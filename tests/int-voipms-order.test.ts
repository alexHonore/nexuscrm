/**
 * Intégration — achat d'un numéro voip.ms depuis le CRM.
 *
 * Le besoin d'origine : commander une nouvelle ligne pour un téléphoniste sans
 * passer par le portail voip.ms. On couvre donc :
 *   - la vitrine (provinces → villes → numéros, prix normalisés, solde) ;
 *   - la commande : paramètres exacts d'orderDID (routage, POP, facturation) ;
 *   - l'attribution en base (E.164, exclusivité du numéro) ;
 *   - les rejeux sûrs (numéro déjà possédé, réponse d'achat perdue) ;
 *   - le provisionnement automatique de la ligne SIP au passage.
 *
 * Seul le réseau voip.ms est simulé ; les gardes RBAC sont réellement exercées.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs, users } from "@/db/schema";

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "24.48.1.1" }),
}));

const marketRoute = await import("@/app/api/admin/voipms/available-dids/route");
const orderRoute = await import("@/app/api/admin/voipms/order-did/route");
const { encryptSecret } = await import("@/lib/crypto");

// ── Session ──────────────────────────────────────────────────────────────────

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);

async function loginAs(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  jar.set(
    "nexus_session",
    await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(SECRET),
  );
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// ── Simulation de l'API voip.ms ──────────────────────────────────────────────

type VoipHandlers = Record<string, (params: URLSearchParams) => unknown>;

function stubVoipms(handlers: VoipHandlers) {
  const calls: { method: string; params: URLSearchParams }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const method = url.searchParams.get("method") ?? "";
    calls.push({ method, params: url.searchParams });
    const handler = handlers[method];
    const payload = handler ? handler(url.searchParams) : { status: "method_not_stubbed" };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    methods: () => calls.map((c) => c.method),
    last: (method: string) => calls.filter((c) => c.method === method).at(-1),
  };
}

const sub = (over: Partial<Record<string, string>> = {}) => ({
  id: "101",
  account: "551013_alex",
  username: "alex",
  description: "Alex",
  ...over,
});

/** Réponses « tout va bien » — chaque test ne remplace que ce qui l'intéresse. */
const MARKET_STUBS: VoipHandlers = {
  getProvinces: () => ({
    status: "success",
    provinces: [
      { province: "QC", description: "Quebec" },
      { province: "ON", description: "Ontario" },
    ],
  }),
  getBalance: () => ({ status: "success", balance: { current_balance: "25.4300" } }),
  getRateCentersCAN: () => ({
    status: "success",
    ratecenters: [{ ratecenter: "Montreal" }, { ratecenter: "Quebec" }],
  }),
  getDIDsCAN: () => ({
    status: "success",
    dids: [
      {
        did: "4509999999",
        ratecenter: "Montreal",
        province: "QC",
        perminute_monthly: "0.85",
        perminute_setup: "0.40",
        perminute_minute: "0.009",
        flat_monthly: "4.25",
        flat_setup: "0.40",
        flat_minute: "0.00",
        sms: "1",
      },
    ],
  }),
};

const SERVERS = [
  { server_name: "Toronto 1", server_hostname: "toronto1.voip.ms", server_pop: "11", server_recommended: "1" },
  { server_name: "Montreal 1", server_hostname: "montreal1.voip.ms", server_pop: "25", server_recommended: "0" },
];

const OWNED_DID = {
  did: "4184761542",
  description: "Ligne existante",
  routing: "account:551013_alex",
  pop: "7",
  state: "QC",
};

const ORDER_STUBS: VoipHandlers = {
  getDIDsInfo: () => ({ status: "success", dids: [OWNED_DID] }),
  getServersInfo: () => ({ status: "success", servers: SERVERS }),
  orderDID: () => ({ status: "success" }),
  setDIDRouting: () => ({ status: "success" }),
  getSubAccounts: () => ({ status: "success", accounts: [sub({ password: "MotDePasseReel9" })] }),
  setSubAccount: () => ({ status: "success" }),
};

const marketGet = (qs = "") =>
  marketRoute.GET(new Request(`http://localhost/api/admin/voipms/available-dids${qs}`));

const orderPost = (body: unknown) =>
  orderRoute.POST(jsonRequest("http://localhost/api/admin/voipms/order-did", "POST", body));

describe("achat d'un numéro voip.ms", () => {
  beforeEach(async () => {
    await resetDb();
    jar.delete("nexus_session");
    process.env.NEXT_PUBLIC_SIP_WSS_URL = "wss://sip.example.test:8089/ws";
    process.env.VOIPMS_SIP_DOMAIN = "montreal1.voip.ms";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(closeDb);

  // ══ Vitrine ═══════════════════════════════════════════════════════════════

  describe("GET /api/admin/voipms/available-dids", () => {
    it("reste réservée aux admins", async () => {
      const caller = await makeUser({ role: "caller" });
      stubVoipms(MARKET_STUBS);

      expect((await marketGet()).status).toBe(401);
      await loginAs(caller);
      expect((await marketGet()).status).toBe(403);
    });

    it("liste provinces + solde, et survit à un solde illisible", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      stubVoipms(MARKET_STUBS);

      const body = (await (await marketGet()).json()) as {
        provinces: { province: string }[];
        balance: number | null;
      };
      expect(body.provinces.map((p) => p.province)).toEqual(["QC", "ON"]);
      expect(body.balance).toBe(25.43);

      // Le solde est décoratif : son échec ne bloque JAMAIS la recherche.
      stubVoipms({ ...MARKET_STUBS, getBalance: () => ({ status: "server_error" }) });
      const degraded = (await (await marketGet()).json()) as { balance: number | null };
      expect(degraded.balance).toBeNull();
    });

    it("liste les villes d'une province (code plié en majuscules)", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const stub = stubVoipms(MARKET_STUBS);

      const body = (await (await marketGet("?province=qc")).json()) as {
        ratecenters: { ratecenter: string }[];
      };
      expect(body.ratecenters.map((r) => r.ratecenter)).toEqual(["Montreal", "Quebec"]);
      expect(stub.last("getRateCentersCAN")!.params.get("province")).toBe("QC");
    });

    it("normalise les numéros en vente : E.164, prix numériques, SMS", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const stub = stubVoipms(MARKET_STUBS);

      const res = await marketGet("?province=QC&ratecenter=Montreal");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { dids: Record<string, unknown>[] };

      expect(stub.last("getDIDsCAN")!.params.get("ratecenter")).toBe("Montreal");
      expect(body.dids).toHaveLength(1);
      expect(body.dids[0]).toMatchObject({
        did: "4509999999",
        e164: "+14509999999",
        ratecenter: "Montreal",
        sms: true,
        prices: {
          perminute: { monthly: 0.85, setup: 0.4, minute: 0.009 },
          flat: { monthly: 4.25, setup: 0.4, minute: 0 },
        },
      });
    });

    it("traduit « rien en vente ici » en liste vide plutôt qu'en erreur", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      stubVoipms({ ...MARKET_STUBS, getDIDsCAN: () => ({ status: "no_dids" }) });

      const res = await marketGet("?province=QC&ratecenter=Montreal");
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ dids: [] });
    });

    it("remonte une vraie panne voip.ms en 502", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      stubVoipms({ ...MARKET_STUBS, getProvinces: () => ({ status: "ip_not_enabled" }) });

      const res = await marketGet();
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({ error: "voipms", status: "ip_not_enabled" });
    });
  });

  // ══ Commande ══════════════════════════════════════════════════════════════

  describe("POST /api/admin/voipms/order-did", () => {
    it("reste réservée aux admins", async () => {
      const caller = await makeUser({ role: "caller" });
      const target = await makeUser({ name: "Alex", email: "alex@nexus.ca" });
      stubVoipms(ORDER_STUBS);

      const payload = { userId: target.id, did: "4509999999" };
      expect((await orderPost(payload)).status).toBe(401);
      await loginAs(caller);
      expect((await orderPost(payload)).status).toBe(403);
    });

    it("refuse un utilisateur inconnu et un numéro invalide", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Alex", email: "alex@nexus.ca" });
      await loginAs(admin);
      stubVoipms(ORDER_STUBS);

      const missing = await orderPost({
        userId: "00000000-0000-4000-8000-000000000000",
        did: "4509999999",
      });
      expect(missing.status).toBe(404);

      // Trop court : arrêté par le schéma avant même la normalisation.
      const tooShort = await orderPost({ userId: target.id, did: "abc" });
      expect(tooShort.status).toBe(422);
      await expect(tooShort.json()).resolves.toMatchObject({ error: "validation" });

      // Longueur acceptable mais aucun chiffre : refusé à la normalisation.
      const invalid = await orderPost({ userId: target.id, did: "pas-un-numero" });
      expect(invalid.status).toBe(422);
      await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_did" });
    });

    it("commande avec les bons paramètres : routage, POP de la passerelle, facturation", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("MotDePasseReel9"),
      });
      await loginAs(admin);
      const stub = stubVoipms(ORDER_STUBS);

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        ok: true,
        did: "+14509999999",
        account: "551013_alex",
        alreadyOwned: false,
        calleridUpdated: true,
        provision: null,
      });

      const order = stub.last("orderDID")!;
      expect(order.params.get("did")).toBe("4509999999");
      expect(order.params.get("routing")).toBe("account:551013_alex");
      // montreal1.voip.ms (VOIPMS_SIP_DOMAIN) → POP 25, pas le POP recommandé.
      expect(order.params.get("pop")).toBe("25");
      expect(order.params.get("dialtime")).toBe("60");
      expect(order.params.get("cnam")).toBe("0");
      expect(order.params.get("billing_type")).toBe("1"); // à la minute par défaut

      // L'identité de l'appelant sortant suit le numéro.
      expect(stub.last("setSubAccount")!.params.get("callerid_number")).toBe("4509999999");

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.didNumber).toBe("+14509999999");
    });

    it("respecte le barème forfaitaire demandé", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      const stub = stubVoipms(ORDER_STUBS);

      await orderPost({ userId: target.id, did: "4509999999", billingType: "flat" });
      expect(stub.last("orderDID")!.params.get("billing_type")).toBe("2");
    });

    it("retire le numéro de son détenteur précédent dans la même transaction", async () => {
      const admin = await makeUser({ role: "admin" });
      const previous = await makeUser({
        name: "Sam",
        email: "sam@nexus.ca",
        didNumber: "+14509999999",
      });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      stubVoipms(ORDER_STUBS);

      const body = (await (await orderPost({ userId: target.id, did: "4509999999" })).json()) as {
        released: { id: string }[];
      };
      expect(body.released.map((r) => r.id)).toEqual([previous.id]);

      const [prevRow] = await testDb.select().from(users).where(eq(users.id, previous.id));
      expect(prevRow.didNumber).toBeNull();
      const [targetRow] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(targetRow.didNumber).toBe("+14509999999");
    });

    it("provisionne la ligne SIP au passage quand l'utilisateur n'en a pas", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Sam Roy", email: "sam@nexus.ca" });
      await loginAs(admin);
      const stub = stubVoipms({
        ...ORDER_STUBS,
        getSubAccounts: () => ({ status: "success", accounts: [] }),
        createSubAccount: () => ({ status: "success", account: "551013_sam" }),
      });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        account: string;
        provision: { account: string; password: string } | null;
      };

      expect(stub.methods()).toContain("createSubAccount");
      expect(body.account).toBe("551013_sam");
      // Mot de passe SIP montré UNE fois — comme le provisionnement manuel.
      expect(body.provision?.password).toBeTruthy();
      expect(stub.last("orderDID")!.params.get("routing")).toBe("account:551013_sam");

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.sipUsername).toBe("551013_sam");
      expect(row.didNumber).toBe("+14509999999");
    });

    it("ne rachète JAMAIS un numéro déjà possédé : il est routé et attribué", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      const stub = stubVoipms(ORDER_STUBS);

      const res = await orderPost({ userId: target.id, did: OWNED_DID.did });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true, alreadyOwned: true });

      expect(stub.methods()).not.toContain("orderDID");
      const routing = stub.last("setDIDRouting")!;
      expect(routing.params.get("did")).toBe(OWNED_DID.did);
      expect(routing.params.get("routing")).toBe("account:551013_alex");
    });

    it("AUTO-RÉPARATION : la commande échoue mais l'achat a abouti → on route quand même", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);

      // 1re lecture : pas encore possédé. Après l'échec apparent de la
      // commande, voip.ms révèle que le numéro est bien arrivé sur le compte.
      let listed = 0;
      const stub = stubVoipms({
        ...ORDER_STUBS,
        getDIDsInfo: () => {
          listed += 1;
          return listed === 1
            ? { status: "success", dids: [OWNED_DID] }
            : { status: "success", dids: [OWNED_DID, { ...OWNED_DID, did: "4509999999" }] };
        },
        orderDID: () => ({ status: "server_error" }),
      });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true, did: "+14509999999" });
      expect(stub.methods()).toContain("setDIDRouting");

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.didNumber).toBe("+14509999999");
    });

    it("remonte un vrai refus d'achat en 502 sans toucher à l'utilisateur", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
        didNumber: "+14184761542",
      });
      await loginAs(admin);
      stubVoipms({ ...ORDER_STUBS, orderDID: () => ({ status: "did_not_available" }) });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({ error: "voipms", status: "did_not_available" });

      // Le numéro déjà en place n'est pas écrasé par un achat raté.
      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.didNumber).toBe("+14184761542");
    });

    it("consigne le DÉBIT avant toute étape faillible, et l'attribution ensuite", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      stubVoipms(ORDER_STUBS);

      await orderPost({ userId: target.id, did: "4509999999" });

      const logs = await testDb.select().from(auditLogs);
      const purchase = logs.find((l) => l.action === "voipms.did_purchase");
      const order = logs.find((l) => l.action === "voipms.did_order");

      // L'achat engage l'argent : sa trace ne doit dépendre d'aucune étape
      // ultérieure (routage, identité d'appelant, écriture en base).
      expect(purchase).toBeDefined();
      expect(purchase!.entityId).toBe(target.id);
      expect(purchase!.detail).toMatchObject({
        did: "+14509999999",
        account: "551013_alex",
        billingType: "perminute",
        recovered: false,
      });
      expect(order).toBeDefined();
      expect(purchase!.id).toBeLessThan(order!.id);
    });

    it("garde la trace du débit même si l'achat n'a été confirmé qu'après coup", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);

      let listed = 0;
      stubVoipms({
        ...ORDER_STUBS,
        getDIDsInfo: () => {
          listed += 1;
          return listed === 1
            ? { status: "success", dids: [OWNED_DID] }
            : { status: "success", dids: [OWNED_DID, { ...OWNED_DID, did: "4509999999" }] };
        },
        orderDID: () => ({ status: "server_error" }),
      });

      await orderPost({ userId: target.id, did: "4509999999" });

      const purchase = (await testDb.select().from(auditLogs)).find(
        (l) => l.action === "voipms.did_purchase",
      );
      expect(purchase!.detail).toMatchObject({ did: "+14509999999", recovered: true });
    });

    it("ne consigne AUCUN débit quand le numéro était déjà possédé", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      stubVoipms(ORDER_STUBS);

      await orderPost({ userId: target.id, did: OWNED_DID.did });

      const actions = (await testDb.select().from(auditLogs)).map((l) => l.action);
      expect(actions).not.toContain("voipms.did_purchase");
      expect(actions).toContain("voipms.did_order");
    });

    it("attribue quand même le numéro si l'identité de l'appelant échoue", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      // Un achat déjà débité ne doit pas être perdu pour un réglage secondaire.
      stubVoipms({ ...ORDER_STUBS, setSubAccount: () => ({ status: "invalid_account" }) });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true, calleridUpdated: false });

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.didNumber).toBe("+14509999999");
    });

    it("n'achète RIEN quand la ligne SIP ne peut pas être provisionnée", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Sam Roy", email: "sam@nexus.ca" });
      await loginAs(admin);
      const stub = stubVoipms({
        ...ORDER_STUBS,
        getSubAccounts: () => ({ status: "ip_not_enabled" }),
      });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(502);
      expect(stub.methods()).not.toContain("orderDID");

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.didNumber).toBeNull();
    });

    it("refuse d'acheter quand l'inventaire du compte est ILLISIBLE (risque de double achat)", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      // Panne de la liste : impossible de savoir si le numéro est déjà payé.
      const stub = stubVoipms({ ...ORDER_STUBS, getDIDsInfo: () => ({ status: "server_error" }) });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(502);
      expect(stub.methods()).not.toContain("orderDID");
    });

    it("achète quand même le PREMIER numéro d'un compte encore vide", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      // « no_did » = inventaire vide, PAS une panne : ne doit rien bloquer,
      // sinon un compte neuf ne pourrait jamais acheter sa première ligne.
      const stub = stubVoipms({ ...ORDER_STUBS, getDIDsInfo: () => ({ status: "no_did" }) });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(200);
      expect(stub.methods()).toContain("orderDID");

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.didNumber).toBe("+14509999999");
    });

    it("garde une trace de la tentative quand l'achat échoue sans pouvoir être confirmé", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      stubVoipms({ ...ORDER_STUBS, orderDID: () => ({ status: "server_error" }) });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(502);

      // Un débit a PU avoir lieu : le journal doit le dire, jamais rester muet.
      const failed = (await testDb.select().from(auditLogs)).find(
        (l) => l.action === "voipms.did_order_failed",
      );
      expect(failed).toBeDefined();
      expect(failed!.detail).toMatchObject({ did: "+14509999999", status: "server_error" });
    });

    it("refuse plutôt que d'acheter sur un serveur arbitraire (POP indéterminable)", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      process.env.VOIPMS_SIP_DOMAIN = "ailleurs.voip.ms";
      const stub = stubVoipms({
        ...ORDER_STUBS,
        getDIDsInfo: () => ({ status: "no_did" }),
        getServersInfo: () => ({
          status: "success",
          servers: [{ server_hostname: "dallas1.voip.ms", server_pop: "3", server_recommended: "0" }],
        }),
      });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({ status: "no_pop" });
      expect(stub.methods()).not.toContain("orderDID");
    });

    it("remonte la VRAIE panne voip.ms, pas un « no_pop » trompeur", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      stubVoipms({
        ...ORDER_STUBS,
        getDIDsInfo: () => ({ status: "no_did" }),
        getServersInfo: () => ({ status: "ip_not_enabled" }),
      });

      const res = await orderPost({ userId: target.id, did: "4509999999" });
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({ status: "ip_not_enabled" });
    });

    it("ne laisse AUCUN secret dans le journal d'audit", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Sam Roy", email: "sam@nexus.ca" });
      await loginAs(admin);
      stubVoipms({
        ...ORDER_STUBS,
        getSubAccounts: () => ({ status: "success", accounts: [] }),
        createSubAccount: () => ({ status: "success", account: "551013_sam" }),
      });

      const body = (await (await orderPost({ userId: target.id, did: "4509999999" })).json()) as {
        provision: { password: string } | null;
      };
      expect(body.provision?.password).toBeTruthy();

      const logs = JSON.stringify(await testDb.select().from(auditLogs));
      expect(logs).not.toContain(body.provision!.password);
    });

    it("retombe sur le POP des lignes en service quand la passerelle ne matche aucun serveur", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      process.env.VOIPMS_SIP_DOMAIN = "ailleurs.voip.ms";
      const stub = stubVoipms(ORDER_STUBS);

      await orderPost({ userId: target.id, did: "4509999999" });
      // Aucun serveur nommé « ailleurs » : on suit les numéros déjà en service.
      expect(stub.last("orderDID")!.params.get("pop")).toBe(OWNED_DID.pop);
    });

    it("retombe sur le serveur recommandé quand le compte n'a encore aucun numéro", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
      });
      await loginAs(admin);
      process.env.VOIPMS_SIP_DOMAIN = "ailleurs.voip.ms";
      const stub = stubVoipms({
        ...ORDER_STUBS,
        getDIDsInfo: () => ({ status: "no_did" }),
      });

      await orderPost({ userId: target.id, did: "4509999999" });
      expect(stub.last("orderDID")!.params.get("pop")).toBe("11"); // server_recommended
    });
  });
});
