/**
 * Intégration — provisionnement et vérification de la ligne SIP.
 *
 * Incident d'origine : un compte créé sans identifiants SIP ne pouvait pas
 * appeler, et rien ne le signalait. On couvre donc :
 *   - la dérivation d'un nom de sous-compte sûr et unique ;
 *   - le provisionnement automatique, idempotent et auto-réparateur ;
 *   - l'état « téléphone prêt » calculé côté serveur (booléens seulement) ;
 *   - la vérification contre voip.ms + la resynchronisation du mot de passe.
 *
 * Seul le réseau voip.ms est simulé ; les gardes RBAC sont réellement exercées.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { users } from "@/db/schema";

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

const subaccountsRoute = await import("@/app/api/admin/voipms/subaccounts/route");
const verifyRoute = await import("@/app/api/admin/voipms/verify/route");
const usersRoute = await import("@/app/api/admin/users/route");
const { deriveSipUsername, findSubAccount } = await import("@/app/api/admin/voipms/_provisioning");
const { computePhoneStatus } = await import("@/app/api/admin/users/_phone-status");
const { decryptSecret, encryptSecret } = await import("@/lib/crypto");

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

/** Répond selon le paramètre `method` de l'URL voip.ms et journalise les appels. */
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
  return { calls, methods: () => calls.map((c) => c.method) };
}

const sub = (over: Partial<Record<string, string>> = {}) => ({
  id: "101",
  account: "551013_alex",
  username: "alex",
  description: "Alex",
  ...over,
});

describe("ligne SIP voip.ms", () => {
  beforeEach(async () => {
    await resetDb();
    jar.delete("nexus_session");
    process.env.NEXT_PUBLIC_SIP_WSS_URL = "wss://sip.example.test:8089/ws";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(closeDb);

  // ══ Dérivation du nom de sous-compte ══════════════════════════════════════

  describe("deriveSipUsername", () => {
    it("plie les accents et la ponctuation du prénom", () => {
      expect(deriveSipUsername({ name: "Alex-Honoré Nsh", email: "a@nexus.ca" }, [])).toBe("alexhonore");
      expect(deriveSipUsername({ name: "Élise Côté", email: "e@nexus.ca" }, [])).toBe("elise");
    });

    it("respecte le format exigé par voip.ms", () => {
      const derived = deriveSipUsername({ name: "Jean-François", email: "jf@nexus.ca" }, []);
      expect(derived).toMatch(/^[A-Za-z0-9_]{2,32}$/);
    });

    it("suffixe en cas de collision, y compris avec un compte préfixé", () => {
      const accounts = [sub({ id: "1", account: "551013_alex", username: "alex" })];
      expect(deriveSipUsername({ name: "Alex Tremblay", email: "alex2@nexus.ca" }, accounts)).toBe("alex2");

      const more = [...accounts, sub({ id: "2", account: "551013_alex2", username: "alex2" })];
      expect(deriveSipUsername({ name: "Alex Roy", email: "alex3@nexus.ca" }, more)).toBe("alex3");
    });

    it("retombe sur le courriel puis sur « agent » quand le nom est inutilisable", () => {
      expect(deriveSipUsername({ name: "则", email: "philippe@nexus.ca" }, [])).toBe("philippe");
      expect(deriveSipUsername({ name: "则", email: "则@nexus.ca" }, [])).toBe("agent");
    });

    it("retrouve un sous-compte par son nom complet OU son suffixe", () => {
      const accounts = [sub()];
      expect(findSubAccount(accounts, "551013_alex")?.id).toBe("101");
      expect(findSubAccount(accounts, "alex")?.id).toBe("101");
      expect(findSubAccount(accounts, "sam")).toBeUndefined();
    });
  });

  // ══ État du téléphone ═════════════════════════════════════════════════════

  describe("état du téléphone", () => {
    it("classe chaque combinaison, la passerelle absente primant sur le reste", () => {
      const full = { sipUsername: "551013_alex", sipPasswordEnc: "enc", didNumber: "+14184761542" };
      expect(computePhoneStatus(full, true).code).toBe("ready");
      expect(computePhoneStatus({ ...full, didNumber: null }, true).code).toBe("no_did");
      expect(computePhoneStatus({ ...full, sipPasswordEnc: null }, true).code).toBe("not_configured");
      expect(computePhoneStatus({ ...full, sipUsername: null }, true).code).toBe("not_configured");
      // Sans passerelle, personne ne peut appeler — même une ligne complète.
      expect(computePhoneStatus(full, false).code).toBe("no_gateway");
    });

    it("n'expose que des booléens dans la réponse d'API (jamais le secret)", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const res = await usersRoute.POST(
        jsonRequest("http://localhost/api/admin/users", "POST", {
          name: "Nouvelle Téléphoniste",
          email: "nouvelle@nexus.ca",
          role: "caller",
          locale: "fr",
        }),
      );
      const body = (await res.json()) as { user: Record<string, unknown> };
      expect(body.user.phone).toEqual({
        code: "not_configured",
        hasSipUsername: false,
        hasSipPassword: false,
        hasDid: false,
        hasGateway: true,
      });
      expect(JSON.stringify(body)).not.toContain("sipPasswordEnc");
    });
  });

  // ══ Provisionnement automatique ═══════════════════════════════════════════

  describe("POST /api/admin/voipms/subaccounts (sans username)", () => {
    it("dérive le nom, crée le sous-compte et enregistre le mot de passe CHIFFRÉ", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Alex-Honoré Nsh", email: "alex@nexus.ca" });
      await loginAs(admin);

      const stub = stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [] }),
        createSubAccount: () => ({ status: "success", account: "551013_alexhonore" }),
      });

      const res = await subaccountsRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/subaccounts", "POST", { userId: target.id }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        account: string;
        password: string;
        created: boolean;
        derived: boolean;
        user: { phone: { code: string } };
      };

      expect(body.account).toBe("551013_alexhonore");
      expect(body.created).toBe(true);
      expect(body.derived).toBe(true);
      // Le badge passe immédiatement à « sans numéro » : il peut appeler.
      expect(body.user.phone.code).toBe("no_did");

      const created = stub.calls.find((c) => c.method === "createSubAccount")!;
      expect(created.params.get("username")).toBe("alexhonore");

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.sipUsername).toBe("551013_alexhonore");
      expect(row.sipPasswordEnc).not.toBeNull();
      expect(row.sipPasswordEnc).not.toContain(body.password);
      expect(decryptSecret(row.sipPasswordEnc!)).toBe(body.password);
    });

    it("n'attribue JAMAIS un DID libre tout seul", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Sam", email: "sam@nexus.ca" });
      await loginAs(admin);

      const stub = stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [] }),
        createSubAccount: () => ({ status: "success", account: "551013_sam" }),
      });

      await subaccountsRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/subaccounts", "POST", { userId: target.id }),
      );

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.didNumber).toBeNull();
      expect(stub.methods()).not.toContain("setDIDRouting");
    });

    it("AUTO-RÉPARATION : la création échoue mais le compte existe → on reprend son mot de passe", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Alex", email: "alex@nexus.ca" });
      await loginAs(admin);

      // La 1re lecture ne voit rien ; après l'échec, voip.ms révèle le compte
      // (la création avait en fait abouti de leur côté).
      let listed = 0;
      const stub = stubVoipms({
        getSubAccounts: () => {
          listed += 1;
          return listed === 1
            ? { status: "success", accounts: [] }
            : { status: "success", accounts: [sub({ password: "MotDePasseReel9" })] };
        },
        createSubAccount: () => ({ status: "invalid_account" }),
      });

      const res = await subaccountsRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/subaccounts", "POST", { userId: target.id }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { account: string; password: string; created: boolean };

      expect(body.account).toBe("551013_alex");
      expect(body.password).toBe("MotDePasseReel9");
      expect(body.created).toBe(false);

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(decryptSecret(row.sipPasswordEnc!)).toBe("MotDePasseReel9");
      // Le mot de passe distant n'a PAS été écrasé : la ligne reste utilisable.
      expect(stub.methods()).not.toContain("setSubAccount");
    });

    it("REJEU : provisionner deux fois ne crée pas de doublon", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("Perdu"),
      });
      await loginAs(admin);

      const stub = stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [sub({ password: "MotDePasseReel9" })] }),
        createSubAccount: () => ({ status: "success", account: "ne_devrait_pas_arriver" }),
      });

      const res = await subaccountsRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/subaccounts", "POST", { userId: target.id }),
      );
      const body = (await res.json()) as { account: string; created: boolean };

      expect(body.created).toBe(false);
      expect(body.account).toBe("551013_alex");
      expect(stub.methods()).not.toContain("createSubAccount");

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(decryptSecret(row.sipPasswordEnc!)).toBe("MotDePasseReel9");
    });

    it("pose un mot de passe quand voip.ms n'en renvoie aucun", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Alex", email: "alex@nexus.ca", sipUsername: "551013_alex" });
      await loginAs(admin);

      const stub = stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [sub()] }),
        setSubAccount: () => ({ status: "success" }),
      });

      const res = await subaccountsRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/subaccounts", "POST", { userId: target.id }),
      );
      const body = (await res.json()) as { password: string };

      expect(stub.methods()).toContain("setSubAccount");
      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(decryptSecret(row.sipPasswordEnc!)).toBe(body.password);
    });

    it("remonte une panne voip.ms en 502 sans toucher à l'utilisateur", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Alex", email: "alex@nexus.ca" });
      await loginAs(admin);
      stubVoipms({ getSubAccounts: () => ({ status: "ip_not_enabled" }) });

      const res = await subaccountsRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/subaccounts", "POST", { userId: target.id }),
      );
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({ error: "voipms", status: "ip_not_enabled" });

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(row.sipUsername).toBeNull();
    });

    it("reste réservé aux admins", async () => {
      const caller = await makeUser({ role: "caller" });
      const target = await makeUser({ name: "Alex", email: "alex@nexus.ca" });
      stubVoipms({ getSubAccounts: () => ({ status: "success", accounts: [] }) });

      const payload = { userId: target.id };
      const anon = await subaccountsRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/subaccounts", "POST", payload),
      );
      expect(anon.status).toBe(401);

      await loginAs(caller);
      const forbidden = await subaccountsRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/subaccounts", "POST", payload),
      );
      expect(forbidden.status).toBe(403);
    });
  });

  // ══ Vérification de la ligne ══════════════════════════════════════════════

  describe("GET /api/admin/voipms/verify", () => {
    const DIDS = [
      { did: "4184761542", description: "Québec", routing: "account:551013_alex", pop: "1", state: "QC" },
    ];

    const verifyGet = (userId: string) =>
      verifyRoute.GET(new Request(`http://localhost/api/admin/voipms/verify?userId=${userId}`));

    type Body = {
      ok: boolean;
      canCall: boolean;
      canResync: boolean;
      checks: { key: string; status: string; reason: string; value?: string }[];
    };
    const reason = (b: Body, key: string) => b.checks.find((c) => c.key === key)!;

    it("valide une ligne complète", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("MotDePasseReel9"),
        didNumber: "+14184761542",
      });
      await loginAs(admin);
      stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [sub({ password: "MotDePasseReel9" })] }),
        getDIDsInfo: () => ({ status: "success", dids: DIDS }),
      });

      const res = await verifyGet(target.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;

      expect(body.ok).toBe(true);
      expect(body.canCall).toBe(true);
      expect(body.canResync).toBe(false);
      expect(body.checks.map((c) => c.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    });

    it("détecte un mot de passe désynchronisé et propose la resynchronisation", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("Perime000"),
        didNumber: "+14184761542",
      });
      await loginAs(admin);
      stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [sub({ password: "MotDePasseReel9" })] }),
        getDIDsInfo: () => ({ status: "success", dids: DIDS }),
      });

      const body = (await (await verifyGet(target.id)).json()) as Body;
      expect(reason(body, "password")).toMatchObject({ status: "fail", reason: "password_mismatch" });
      expect(body.canResync).toBe(true);
      expect(body.ok).toBe(false);
    });

    it("signale un sous-compte absent, un numéro manquant et un routage ailleurs", async () => {
      const admin = await makeUser({ role: "admin" });
      const orphan = await makeUser({
        name: "Fantôme",
        email: "f@nexus.ca",
        sipUsername: "551013_disparu",
        sipPasswordEnc: encryptSecret("X"),
      });
      const misrouted = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("MotDePasseReel9"),
        didNumber: "+14184761542",
      });
      await loginAs(admin);
      stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [sub({ password: "MotDePasseReel9" })] }),
        getDIDsInfo: () => ({
          status: "success",
          dids: [{ ...DIDS[0], routing: "account:551013" }],
        }),
      });

      const orphanBody = (await (await verifyGet(orphan.id)).json()) as Body;
      expect(reason(orphanBody, "subaccount")).toMatchObject({ status: "fail", reason: "sub_not_found" });
      expect(reason(orphanBody, "did")).toMatchObject({ status: "warn", reason: "did_missing" });
      expect(reason(orphanBody, "routing")).toMatchObject({ status: "unknown", reason: "routing_no_did" });
      expect(orphanBody.canCall).toBe(false);

      const misroutedBody = (await (await verifyGet(misrouted.id)).json()) as Body;
      expect(reason(misroutedBody, "routing")).toMatchObject({ status: "fail", reason: "routing_main" });
      // Les appels SORTANTS restent possibles : la nuance compte pour le courtier.
      expect(misroutedBody.canCall).toBe(true);
      expect(misroutedBody.ok).toBe(false);
    });

    it("signale la passerelle absente pour tout le monde", async () => {
      delete process.env.NEXT_PUBLIC_SIP_WSS_URL;
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("MotDePasseReel9"),
        didNumber: "+14184761542",
      });
      await loginAs(admin);
      stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [sub({ password: "MotDePasseReel9" })] }),
        getDIDsInfo: () => ({ status: "success", dids: DIDS }),
      });

      const body = (await (await verifyGet(target.id)).json()) as Body & {
        user: { phone: { code: string } };
      };
      expect(reason(body, "gateway")).toMatchObject({ status: "fail", reason: "gateway_missing" });
      expect(body.user.phone.code).toBe("no_gateway");
      expect(body.canCall).toBe(false);
    });

    it("reste utile quand la liste des DID échoue", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("MotDePasseReel9"),
        didNumber: "+14184761542",
      });
      await loginAs(admin);
      stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [sub({ password: "MotDePasseReel9" })] }),
        getDIDsInfo: () => ({ status: "server_error" }),
      });

      const body = (await (await verifyGet(target.id)).json()) as Body;
      expect(reason(body, "subaccount").status).toBe("ok");
      expect(reason(body, "routing")).toMatchObject({ status: "unknown", reason: "routing_unavailable" });
    });

    it("renvoie 502 quand voip.ms est injoignable (jamais un diagnostic trompeur)", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Alex", email: "alex@nexus.ca" });
      await loginAs(admin);
      stubVoipms({ getSubAccounts: () => ({ status: "ip_not_enabled" }) });

      const res = await verifyGet(target.id);
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({ error: "voipms", status: "ip_not_enabled" });
    });

    it("est réservée aux admins", async () => {
      const caller = await makeUser({ role: "caller" });
      stubVoipms({ getSubAccounts: () => ({ status: "success", accounts: [] }) });

      expect((await verifyGet(caller.id)).status).toBe(401);
      await loginAs(caller);
      expect((await verifyGet(caller.id)).status).toBe(403);
    });
  });

  describe("POST /api/admin/voipms/verify (resynchronisation)", () => {
    it("adopte le mot de passe que voip.ms utilise vraiment", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("Perime000"),
      });
      await loginAs(admin);
      stubVoipms({
        getSubAccounts: () => ({ status: "success", accounts: [sub({ password: "MotDePasseReel9" })] }),
      });

      const res = await verifyRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/verify", "POST", { userId: target.id }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { account: string; user: { phone: { code: string } } };
      expect(body.account).toBe("551013_alex");
      // Aucun secret dans la réponse.
      expect(JSON.stringify(body)).not.toContain("MotDePasseReel9");

      const [row] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(decryptSecret(row.sipPasswordEnc!)).toBe("MotDePasseReel9");
    });

    it("refuse de resynchroniser un sous-compte inexistant plutôt que d'en créer un", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Fantôme",
        email: "f@nexus.ca",
        sipUsername: "551013_disparu",
      });
      await loginAs(admin);
      const stub = stubVoipms({ getSubAccounts: () => ({ status: "success", accounts: [sub()] }) });

      const res = await verifyRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/verify", "POST", { userId: target.id }),
      );
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({ status: "subaccount_not_found" });
      expect(stub.methods()).not.toContain("createSubAccount");
    });
  });
});
