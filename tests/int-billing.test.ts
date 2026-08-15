/**
 * Intégration — consommation par téléphoniste et dépense voip.ms.
 *
 * Ce que l'écran promet au courtier, et qu'on vérifie ici :
 *   - un appel n'est JAMAIS compté deux fois (le CDR renvoie plusieurs pattes) ;
 *   - le coût vient de voip.ms, jamais d'un calcul maison ;
 *   - le trafic qui n'appartient à personne reste visible dans le total ;
 *   - résilier un numéro est irréversible, donc verrouillé et journalisé.
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

const usageRoute = await import("@/app/api/admin/telephony-usage/route");
const cancelRoute = await import("@/app/api/admin/voipms/cancel-did/route");
const { aggregateUsage } = await import("@/lib/telephony-usage");
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

// ── Simulation voip.ms ───────────────────────────────────────────────────────

type VoipHandlers = Record<string, (params: URLSearchParams) => unknown>;

function stubVoipms(handlers: VoipHandlers) {
  const calls: { method: string; params: URLSearchParams }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const method = url.searchParams.get("method") ?? "";
      calls.push({ method, params: url.searchParams });
      const handler = handlers[method];
      const payload = handler ? handler(url.searchParams) : { status: "method_not_stubbed" };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return {
    calls,
    methods: () => calls.map((c) => c.method),
    last: (m: string) => calls.filter((c) => c.method === m).at(-1),
  };
}

/** Ligne de CDR minimale — chaque test ne précise que ce qui l'intéresse. */
const cdr = (over: Partial<Record<string, string>> = {}) => ({
  date: "2026-08-10 09:15:00",
  callerid: "5145551111",
  destination: "4185552222",
  description: "",
  account: "551013_alex",
  disposition: "ANSWERED",
  duration: "0:30",
  seconds: "30",
  uniqueid: "u1",
  total: "0.0100",
  ...over,
});

const person = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Alex",
  email: "alex@nexus.ca",
  sipUsername: "551013_alex",
  didNumber: "+14185552222",
  isActive: true,
  ...over,
}) as Parameters<typeof aggregateUsage>[1][number];

describe("consommation et dépenses voip.ms", () => {
  beforeEach(async () => {
    await resetDb();
    jar.delete("nexus_session");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(closeDb);

  // ══ Agrégation (pur, sans réseau) ═════════════════════════════════════════

  describe("aggregateUsage", () => {
    it("rattache par sous-compte et additionne le coût voip.ms tel quel", () => {
      const p = person();
      const { rows, totals } = aggregateUsage(
        [
          cdr({ uniqueid: "a", seconds: "30", total: "0.0100" }),
          cdr({ uniqueid: "b", date: "2026-08-10 10:00:00", seconds: "60", total: "0.0250" }),
        ],
        [p],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: p.id, calls: 2, answered: 2, seconds: 90 });
      // 0.01 + 0.025 — le coût n'est JAMAIS recalculé à partir de la durée.
      expect(rows[0].cost).toBeCloseTo(0.035, 6);
      expect(totals.cost).toBeCloseTo(0.035, 6);
    });

    it("ne compte QU'UNE FOIS un appel renvoyé en plusieurs pattes", () => {
      const p = person();
      // Même sous-compte, même destination, même seconde : deux pattes d'un
      // seul appel. Une seule porte le montant — voip.ms ne facture qu'une fois.
      const { rows, totals } = aggregateUsage(
        [
          cdr({ uniqueid: "leg1", seconds: "12", total: "" }),
          cdr({ uniqueid: "leg2", seconds: "45", total: "0.0100" }),
        ],
        [p],
      );

      expect(totals.calls).toBe(1);
      expect(rows[0].seconds).toBe(45); // la patte la plus longue
      expect(totals.cost).toBeCloseTo(0.01, 6);
    });

    it("absorbe la patte du compte principal d'un appel entrant", () => {
      const p = person();
      // Le même appel entrant vu par le compte principal PUIS par le
      // sous-compte : une seule conversation.
      const { rows, totals } = aggregateUsage(
        [
          cdr({ account: "551013", uniqueid: "main", seconds: "40", total: "" }),
          cdr({ account: "551013_alex", uniqueid: "sub", seconds: "42", total: "0.0100" }),
        ],
        [p],
      );

      expect(totals.calls).toBe(1);
      expect(rows.find((r) => r.userId === p.id)!.calls).toBe(1);
      expect(totals.cost).toBeCloseTo(0.01, 6);
    });

    it("garde le coût d'un ENTRANT même quand c'est la patte facturée qui est absorbée", () => {
      const p = person();
      // Cas réel : un appel entrant est facturé sur la patte du COMPTE
      // PRINCIPAL — précisément celle que le regroupement écarte. Lire le coût
      // sur la seule patte survivante perdait ce montant en silence.
      const { rows, totals, costUnavailable } = aggregateUsage(
        [
          cdr({ account: "551013", uniqueid: "main", seconds: "40", total: "0.0090" }),
          cdr({ account: "551013_alex", uniqueid: "sub", seconds: "42", total: "" }),
        ],
        [p],
      );

      expect(totals.calls).toBe(1);
      expect(totals.cost).toBeCloseTo(0.009, 6);
      expect(rows.find((r) => r.userId === p.id)!.cost).toBeCloseTo(0.009, 6);
      expect(costUnavailable).toBe(false);
    });

    it("n'affiche pas les comptes désactivés qui n'ont rien consommé", () => {
      const active = person();
      const retired = person({
        id: "22222222-2222-4222-8222-222222222222",
        name: "Ancien",
        email: "ancien@nexus.ca",
        sipUsername: "551013_ancien",
        didNumber: null,
        isActive: false,
      });

      const quiet = aggregateUsage([], [active, retired]);
      expect(quiet.rows.map((r) => r.userId)).toEqual([active.id]);

      // …mais s'il a consommé, sa dépense reste visible.
      const busy = aggregateUsage(
        [cdr({ account: "551013_ancien", uniqueid: "old", total: "0.0200" })],
        [active, retired],
      );
      expect(busy.rows.find((r) => r.userId === retired.id)?.cost).toBeCloseTo(0.02, 6);
    });

    it("rattache par DID quand le compte est inconnu", () => {
      const p = person({ sipUsername: null });
      const { rows } = aggregateUsage(
        [cdr({ account: "551013", destination: "4185552222" })],
        [p],
      );
      expect(rows.find((r) => r.userId === p.id)!.calls).toBe(1);
    });

    it("garde le trafic non rattaché DANS le total, en dernière ligne", () => {
      const p = person();
      const { rows, totals } = aggregateUsage(
        [
          cdr({ uniqueid: "mine", total: "0.0100" }),
          cdr({
            account: "551013",
            destination: "9999999999",
            date: "2026-08-11 08:00:00",
            uniqueid: "orphan",
            seconds: "20",
            total: "0.0500",
          }),
        ],
        [p],
      );

      const last = rows.at(-1)!;
      expect(last.userId).toBeNull();
      expect(last.calls).toBe(1);
      // Le total doit rester la dépense RÉELLE, même la part de personne.
      expect(totals.cost).toBeCloseTo(0.06, 6);
    });

    it("affiche un téléphoniste sans aucun appel", () => {
      const { rows, totals } = aggregateUsage([], [person()]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ calls: 0, seconds: 0, cost: 0 });
      expect(totals.calls).toBe(0);
    });

    it("signale « aucun coût chiffré » plutôt que d'afficher 0 $", () => {
      const withoutCost = aggregateUsage([cdr({ total: "" })], [person()]);
      expect(withoutCost.costUnavailable).toBe(true);

      const withCost = aggregateUsage([cdr({ total: "0.02" })], [person()]);
      expect(withCost.costUnavailable).toBe(false);

      // Un appel réellement GRATUIT est chiffré à 0 : ce n'est pas la même
      // chose qu'un montant absent, et l'écran ne doit pas crier au problème.
      const free = aggregateUsage([cdr({ total: "0.0000" })], [person()]);
      expect(free.costUnavailable).toBe(false);
      expect(free.totals.cost).toBe(0);

      // Aucun appel du tout : ce n'est pas « coût indisponible ».
      expect(aggregateUsage([], [person()]).costUnavailable).toBe(false);
    });

    it("ne compte comme répondus que les appels aboutis", () => {
      const { rows } = aggregateUsage(
        [
          cdr({ uniqueid: "a", disposition: "ANSWERED" }),
          cdr({ uniqueid: "b", date: "2026-08-10 11:00:00", disposition: "NO ANSWER" }),
          cdr({ uniqueid: "c", date: "2026-08-10 12:00:00", disposition: "BUSY" }),
        ],
        [person()],
      );
      expect(rows[0]).toMatchObject({ calls: 3, answered: 1 });
    });
  });

  // ══ Route de consommation ═════════════════════════════════════════════════

  describe("GET /api/admin/telephony-usage", () => {
    const get = (qs: string) =>
      usageRoute.GET(new Request(`http://localhost/api/admin/telephony-usage${qs}`));

    it("reste réservée aux admins", async () => {
      const caller = await makeUser({ role: "caller" });
      stubVoipms({ getCDR: () => ({ status: "success", cdr: [] }) });

      expect((await get("?from=2026-08-01&to=2026-08-10")).status).toBe(401);
      await loginAs(caller);
      expect((await get("?from=2026-08-01&to=2026-08-10")).status).toBe(403);
    });

    it("refuse une plage absente, inversée ou trop longue", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      stubVoipms({ getCDR: () => ({ status: "success", cdr: [] }) });

      expect((await get("")).status).toBe(422);
      expect((await get("?from=2026-08-10&to=2026-08-01")).status).toBe(422);

      const tooLong = await get("?from=2026-01-01&to=2026-08-01");
      expect(tooLong.status).toBe(422);
      await expect(tooLong.json()).resolves.toMatchObject({ error: "range_too_long" });
    });

    it("renvoie la consommation par téléphoniste et le solde", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        sipPasswordEnc: encryptSecret("X"),
        didNumber: "+14185552222",
      });
      await loginAs(admin);
      const stub = stubVoipms({
        getCDR: () => ({ status: "success", cdr: [cdr({ seconds: "60", total: "0.0300" })] }),
        getBalance: () => ({
          status: "success",
          balance: { current_balance: "42.5000", spent_total: "7.25" },
        }),
      });

      const res = await get("?from=2026-08-01&to=2026-08-10");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: { userId: string | null; cost: number; seconds: number }[];
        totals: { cost: number };
        balance: { currentBalance: number } | null;
      };

      const mine = body.rows.find((r) => r.userId === target.id)!;
      expect(mine).toMatchObject({ seconds: 60 });
      expect(mine.cost).toBeCloseTo(0.03, 6);
      expect(body.balance?.currentBalance).toBe(42.5);
      // La période demandée est bien transmise à voip.ms.
      expect(stub.last("getCDR")!.params.get("date_from")).toBe("2026-08-01");
    });

    it("reste utilisable quand le solde échoue", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      stubVoipms({
        getCDR: () => ({ status: "success", cdr: [] }),
        getBalance: () => ({ status: "server_error" }),
      });

      const res = await get("?from=2026-08-01&to=2026-08-10");
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ balance: null });
    });

    it("traite « aucun appel » comme un rapport vide, pas une panne", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      stubVoipms({
        getCDR: () => ({ status: "no_cdr" }),
        getBalance: () => ({ status: "success", balance: { current_balance: "10" } }),
      });

      const res = await get("?from=2026-08-01&to=2026-08-10");
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ totals: { calls: 0 } });
    });

    it("remonte une vraie panne voip.ms en 502", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      stubVoipms({ getCDR: () => ({ status: "ip_not_enabled" }) });

      const res = await get("?from=2026-08-01&to=2026-08-10");
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({ error: "voipms", status: "ip_not_enabled" });
    });
  });

  // ══ Résiliation d'un numéro ═══════════════════════════════════════════════

  describe("POST /api/admin/voipms/cancel-did", () => {
    const OWNED = { did: "4185552222", description: "", routing: "account:551013_alex", pop: "5", state: "QC" };
    const CANCEL_STUBS: VoipHandlers = {
      getDIDsInfo: () => ({ status: "success", dids: [OWNED] }),
      cancelDID: () => ({ status: "success" }),
    };
    const post = (body: unknown) =>
      cancelRoute.POST(jsonRequest("http://localhost/api/admin/voipms/cancel-did", "POST", body));

    it("reste réservée aux admins", async () => {
      const caller = await makeUser({ role: "caller" });
      stubVoipms(CANCEL_STUBS);
      const payload = { did: "4185552222", confirm: "2222" };

      expect((await post(payload)).status).toBe(401);
      await loginAs(caller);
      expect((await post(payload)).status).toBe(403);
    });

    it("exige les 4 derniers chiffres RÉELLEMENT saisis", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const stub = stubVoipms(CANCEL_STUBS);

      // Mauvais chiffres : c'est le geste qui protège du clic sur la mauvaise ligne.
      const wrong = await post({ did: "4185552222", confirm: "9999" });
      expect(wrong.status).toBe(422);
      await expect(wrong.json()).resolves.toMatchObject({ error: "confirm_mismatch" });
      expect(stub.methods()).not.toContain("cancelDID");

      // Trop court pour prouver quoi que ce soit.
      expect((await post({ did: "4185552222", confirm: "22" })).status).toBe(422);

      // Les 4 bons chiffres suffisent.
      expect((await post({ did: "4185552222", confirm: "2222" })).status).toBe(200);
    });

    it("refuse un numéro que le compte ne possède pas", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const stub = stubVoipms(CANCEL_STUBS);

      const res = await post({ did: "5145559999", confirm: "9999" });
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ error: "did_not_owned" });
      expect(stub.methods()).not.toContain("cancelDID");
    });

    it("résilie, libère le détenteur et journalise", async () => {
      const admin = await makeUser({ role: "admin" });
      const holder = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        sipUsername: "551013_alex",
        didNumber: "+14185552222",
      });
      await loginAs(admin);
      const stub = stubVoipms(CANCEL_STUBS);

      const res = await post({ did: "+14185552222", confirm: "2222", comment: "inutilisé" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { released: { id: string }[] };
      expect(body.released.map((r) => r.id)).toEqual([holder.id]);

      // voip.ms attend 10 chiffres, jamais l'E.164 stocké en base.
      expect(stub.last("cancelDID")!.params.get("did")).toBe("4185552222");

      const [row] = await testDb.select().from(users).where(eq(users.id, holder.id));
      expect(row.didNumber).toBeNull();

      const log = (await testDb.select().from(auditLogs)).find(
        (l) => l.action === "voipms.did_cancel",
      );
      expect(log).toBeDefined();
      expect(log!.detail).toMatchObject({ did: "+14185552222" });
    });

    it("ne touche à personne quand voip.ms refuse la résiliation", async () => {
      const admin = await makeUser({ role: "admin" });
      const holder = await makeUser({
        name: "Alex",
        email: "alex@nexus.ca",
        didNumber: "+14185552222",
      });
      await loginAs(admin);
      stubVoipms({ ...CANCEL_STUBS, cancelDID: () => ({ status: "invalid_did" }) });

      const res = await post({ did: "4185552222", confirm: "2222" });
      expect(res.status).toBe(502);

      const [row] = await testDb.select().from(users).where(eq(users.id, holder.id));
      expect(row.didNumber).toBe("+14185552222");
    });
  });
});
