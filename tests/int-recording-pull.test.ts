/**
 * Intégration — récupérer l'enregistrement d'UN appel sans attendre la
 * synchro de la journée (`pullCallRecording`, POST /api/admin/calls/[id]/recording).
 *
 * Ce que ces tests tiennent :
 *  1. Le rapprochement est CELUI de la synchro : les deux chemins passent par
 *     les mêmes fonctions, et la synchro est vérifiée ici aussi — elle n'avait
 *     aucun test de rattachement d'enregistrement.
 *  2. Un enregistrement déjà posé sur un autre appel, ou dont l'uniqueid
 *     désigne un autre appel, ne se vole pas.
 *  3. La route se garde comme l'écoute : droit d'écouter + accès à CET appel,
 *     404 (jamais 403) pour une fiche qu'on ne voit pas — et voip.ms n'est
 *     même pas interrogé.
 * Le réseau voip.ms est simulé ; la base est réelle.
 */
import { SignJWT } from "jose";
import { formatInTimeZone } from "date-fns-tz";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";

vi.mock("server-only", () => ({}));

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, { name: string; value: string }>(),
  headers: new Headers({ "x-forwarded-for": "24.48.1.1" }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const c = ctx.cookies.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    getAll() {
      return [...ctx.cookies.values()];
    },
    has(name: string) {
      return ctx.cookies.has(name);
    },
    set(name: string, value: string) {
      ctx.cookies.set(name, { name, value });
    },
    delete(name: string) {
      ctx.cookies.delete(name);
    },
  }),
  headers: async () => ctx.headers,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

vi.mock("@/lib/voipms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voipms")>();
  return {
    ...actual,
    getCdr: vi.fn(async () => []),
    getCallRecordings: vi.fn(async () => []),
  };
});

const { getCallRecordings, getCdr, recordingRef, VoipMsError } = await import("@/lib/voipms");
const { pullCallRecording, syncCdrRange } = await import("@/lib/cdr-sync");
const route = await import("@/app/api/admin/calls/[id]/recording/route");
const { auditLogs, calls } = await import("@/db/schema");
const { SESSION_COOKIE_NAME } = await import("@/lib/auth/session");
const { CALLER_ROLE_ID, OBSERVER_ROLE_ID, defaultPermissionsConfig } =
  await import("@/lib/permissions/defaults");
const { setSetting } = await import("@/lib/settings");
type VoipMsRecording = Awaited<ReturnType<typeof getCallRecordings>>[number];
type VoipMsCdr = Awaited<ReturnType<typeof getCdr>>[number];

const TZ = "America/Toronto";
const LINE = "551013_luc";
/** 10 h 00 à Toronto. */
const T = new Date("2026-09-09T14:00:00Z");
const DAY = "2026-09-09";
const CLIENT_NUMBER = "+14185551234";

const at = (d: Date, sec: number) => new Date(d.getTime() + sec * 1000);
const voipDate = (d: Date) => formatInTimeZone(d, TZ, "yyyy-MM-dd HH:mm:ss");

let seq = 0;
/** Un enregistrement tel que voip.ms le liste : un identifiant, pas d'URL. */
function rec(overrides: Partial<VoipMsRecording> & { when?: Date } = {}): VoipMsRecording {
  seq += 1;
  const { when, ...rest } = overrides;
  return {
    callrecording: `rec-${seq}`,
    account: LINE,
    call_id: `rec-uid-${seq}`,
    datetime: voipDate(when ?? T),
    caller: "5145550000",
    destination: "4185551234",
    ...rest,
  };
}

function lineUser(overrides: Parameters<typeof makeUser>[0] = {}) {
  return makeUser({ name: "Luc", role: "caller", sipUsername: LINE, ...overrides });
}

async function makeCall(userId: string, overrides: Partial<typeof calls.$inferInsert> = {}) {
  const [row] = await testDb
    .insert(calls)
    .values({
      userId,
      direction: "outbound",
      toNumber: CLIENT_NUMBER,
      startedAt: T,
      answeredAt: at(T, 5),
      durationSec: 120,
      provider: "voipms",
      ...overrides,
    })
    .returning();
  return row;
}

async function recordingOf(callId: string): Promise<string | null> {
  const [row] = await testDb
    .select({ url: calls.recordingUrl })
    .from(calls)
    .where(eq(calls.id, callId));
  return row?.url ?? null;
}

async function providerCallIdOf(callId: string): Promise<string | null> {
  const [row] = await testDb
    .select({ uid: calls.providerCallId })
    .from(calls)
    .where(eq(calls.id, callId));
  return row?.uid ?? null;
}

/** Une ligne du registre voip.ms (CDR) : l'appel sortant de Luc, par défaut. */
function cdr(overrides: Partial<VoipMsCdr> & { when?: Date } = {}): VoipMsCdr {
  seq += 1;
  const { when, ...rest } = overrides;
  return {
    date: voipDate(when ?? T),
    callerid: "4189065924",
    destination: "14185551234",
    description: "Outbound",
    account: LINE,
    disposition: "ANSWERED",
    duration: "00:02:00",
    seconds: "120",
    uniqueid: `cdr-uid-${seq}`,
    ...rest,
  };
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(getCallRecordings).mockReset();
  vi.mocked(getCallRecordings).mockResolvedValue([]);
  vi.mocked(getCdr).mockReset();
  vi.mocked(getCdr).mockResolvedValue([]);
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("un seul appel — le rapprochement", () => {
  it("rattache par l'uniqueid du CDR, en ne demandant que la ligne et la journée de l'appel", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id, { providerCallId: "cdr-777" });
    // Un enregistrement plus proche dans le temps, mais d'un autre appel :
    // l'uniqueid l'emporte sur l'horaire.
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "near", when: at(T, 2) }),
      rec({ callrecording: "mine", call_id: "cdr-777", when: at(T, 150) }),
    ]);

    const out = await pullCallRecording(call.id);
    expect(out).toMatchObject({
      status: "attached",
      recordingUrl: recordingRef(LINE, "mine"),
      diag: { matchedBy: "uid" },
    });
    expect(await recordingOf(call.id)).toBe(recordingRef(LINE, "mine"));
    expect(getCallRecordings).toHaveBeenCalledTimes(1);
    expect(getCallRecordings).toHaveBeenCalledWith(LINE, DAY, DAY);
    // Le registre est consulté quand même : c'est lui qui désigne les autres appels.
    expect(getCdr).toHaveBeenCalledWith(DAY, DAY);
  });

  it("sans uniqueid encore, rapproche par horaire et numéro — le plus proche gagne", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "late", when: at(T, 170) }),
      rec({ callrecording: "close", when: at(T, 20) }),
      // Le plus proche de tous, mais vers un autre numéro.
      rec({ callrecording: "elsewhere", destination: "4187770000", when: at(T, 1) }),
    ]);

    const out = await pullCallRecording(call.id);
    expect(out).toMatchObject({
      status: "attached",
      recordingUrl: recordingRef(LINE, "close"),
      diag: { matchedBy: "time", cdrFound: false },
    });
  });

  it("hors de ±3 min, rien — et rien d'écrit", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockResolvedValue([rec({ when: at(T, 200) })]);

    expect(await pullCallRecording(call.id)).toMatchObject({
      status: "not_found",
      reason: "unmatched",
      diag: { recordingsOnLine: 1, nearestGapSec: 200 },
    });
    expect(await recordingOf(call.id)).toBeNull();
  });

  it("aucun enregistrement sur la ligne : « pas encore », avec ce que voip.ms a montré", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);

    expect(await pullCallRecording(call.id)).toEqual({
      status: "not_found",
      reason: "pending",
      diag: { recordingsOnLine: 0, recordingFields: [], cdrFound: false, nearestGapSec: null },
    });
  });

  it("ne prend pas l'enregistrement déjà posé sur un autre appel", async () => {
    const luc = await lineUser();
    const other = await makeCall(luc.id, {
      startedAt: at(T, 30),
      recordingUrl: recordingRef(LINE, "taken"),
    });
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "taken", when: at(T, 10) }),
    ]);

    expect(await pullCallRecording(call.id)).toMatchObject({
      status: "not_found",
      reason: "unmatched",
    });
    expect(await recordingOf(call.id)).toBeNull();
    expect(await recordingOf(other.id)).toBe(recordingRef(LINE, "taken"));
  });

  it("ni celui dont l'uniqueid désigne un autre appel connu", async () => {
    const luc = await lineUser();
    await makeCall(luc.id, { startedAt: at(T, 40), providerCallId: "cdr-other" });
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "theirs", call_id: "cdr-other", when: at(T, 5) }),
    ]);

    expect(await pullCallRecording(call.id)).toMatchObject({
      status: "not_found",
      reason: "unmatched",
    });
  });

  it("un appel qui a déjà le sien ne dérange pas voip.ms", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id, { recordingUrl: recordingRef(LINE, "old") });

    expect(await pullCallRecording(call.id)).toEqual({
      status: "already",
      recordingUrl: recordingRef(LINE, "old"),
    });
    expect(getCallRecordings).not.toHaveBeenCalled();
  });

  it("un téléphoniste sans sous-compte voip.ms : personne à qui demander", async () => {
    const sansLigne = await makeUser({ name: "Sans ligne", sipUsername: null });
    const call = await makeCall(sansLigne.id);

    expect(await pullCallRecording(call.id)).toEqual({ status: "no_line" });
    expect(getCallRecordings).not.toHaveBeenCalled();
  });

  it("un appel Twilio ne se cherche pas chez voip.ms", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id, { provider: "twilio" });

    expect(await pullCallRecording(call.id)).toEqual({ status: "not_found", reason: "not_voipms" });
    expect(getCallRecordings).not.toHaveBeenCalled();
    expect(getCdr).not.toHaveBeenCalled();
  });

  it("un appel qui frôle minuit demande les deux journées", async () => {
    const luc = await lineUser();
    // 23 h 59 à Toronto le 9 : ±3 min déborde sur le 10.
    const call = await makeCall(luc.id, { startedAt: new Date("2026-09-10T03:59:00Z") });

    await pullCallRecording(call.id);
    expect(getCallRecordings).toHaveBeenCalledWith(LINE, "2026-09-09", "2026-09-10");
  });

  it("voip.ms en panne : l'erreur remonte, rien n'est écrit", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockRejectedValue(
      new VoipMsError("timeout", "voip.ms: aucune réponse"),
    );

    const out = await pullCallRecording(call.id);
    expect(out?.status).toBe("upstream_error");
    expect(await recordingOf(call.id)).toBeNull();
  });

  it("un appel inconnu : null", async () => {
    expect(await pullCallRecording("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("un appel du webphone, retrouvé au registre de voip.ms", () => {
  /**
   * Le cas du 2026-09-13 (581-990-5955) : un appel du webphone n'a pas
   * d'uniqueid avant une synchro, et l'enregistrement tel que voip.ms le
   * documente n'a pas de `caller` — son horaire, sans fuseau demandé, peut
   * être décalé d'une heure. Avant, « Récupérer » répondait « pas encore ».
   */
  it("rattache par l'uniqueid retrouvé au registre, même quand l'horaire de l'enregistrement ment d'une heure", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);
    vi.mocked(getCdr).mockResolvedValue([cdr({ uniqueid: "1757426400.374" })]);
    vi.mocked(getCallRecordings).mockResolvedValue([
      {
        callrecording: "r-5955",
        account: LINE,
        call_id: "1757426400.374",
        datetime: voipDate(at(T, 3600)),
        destination: "4185551234",
        type: "outgoing",
        duration: "0:02:00",
      },
    ]);

    const out = await pullCallRecording(call.id);
    expect(out).toMatchObject({
      status: "attached",
      recordingUrl: recordingRef(LINE, "r-5955"),
      diag: { matchedBy: "uid", cdrFound: true, nearestGapSec: 3600 },
    });
    expect(getCdr).toHaveBeenCalledWith(DAY, DAY);
    // L'uniqueid reste sur l'appel : la synchro le reconnaîtra directement.
    expect(await providerCallIdOf(call.id)).toBe("1757426400.374");
  });

  it("reconnaît l'uniqueid d'une patte écartée au regroupement", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);
    // Deux pattes, même seconde : la synchro garde la plus longue (…375).
    vi.mocked(getCdr).mockResolvedValue([
      cdr({ uniqueid: "u-374", seconds: "3" }),
      cdr({ uniqueid: "u-375", seconds: "120" }),
    ]);
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "leg", call_id: "u-374", when: at(T, 3600) }),
    ]);

    expect(await pullCallRecording(call.id)).toMatchObject({
      status: "attached",
      recordingUrl: recordingRef(LINE, "leg"),
    });
    expect(await providerCallIdOf(call.id)).toBe("u-375");
  });

  it("ne prend pas l'enregistrement du rappel d'à côté, même tombé à la bonne minute", async () => {
    const luc = await lineUser();
    // Premier essai à 10 h 00, rappel du même numéro à 10 h 01 — c'est celui-ci
    // qu'on veut écouter. Le premier est au journal, sans uniqueid lui non plus.
    await makeCall(luc.id);
    const call = await makeCall(luc.id, { startedAt: at(T, 60), answeredAt: at(T, 65) });
    vi.mocked(getCdr).mockResolvedValue([
      cdr({ uniqueid: "first", seconds: "20" }),
      cdr({ uniqueid: "redial", when: at(T, 60) }),
    ]);
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "first-rec", call_id: "first", when: at(T, 0) }),
    ]);

    expect(await pullCallRecording(call.id)).toMatchObject({
      status: "not_found",
      reason: "unmatched",
    });
    expect(await recordingOf(call.id)).toBeNull();

    // Le sien arrive : il est pris, et pas l'autre.
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "first-rec", call_id: "first", when: at(T, 0) }),
      rec({ callrecording: "redial-rec", call_id: "redial", when: at(T, 3660) }),
    ]);
    expect(await pullCallRecording(call.id)).toMatchObject({
      status: "attached",
      recordingUrl: recordingRef(LINE, "redial-rec"),
    });
  });

  it("un entrant, inscrit au registre sous le compte principal : attribué par le DID", async () => {
    const luc = await lineUser({ didNumber: "+14189065924" });
    const call = await makeCall(luc.id, {
      direction: "inbound",
      fromNumber: CLIENT_NUMBER,
      toNumber: "+14189065924",
    });
    vi.mocked(getCdr).mockResolvedValue([
      cdr({
        uniqueid: "in-1",
        account: "551013",
        callerid: "4185551234",
        destination: "4189065924",
      }),
    ]);
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "in-rec", call_id: "in-1", destination: "551013_luc", when: at(T, 3600) }),
    ]);

    expect(await pullCallRecording(call.id)).toMatchObject({
      status: "attached",
      recordingUrl: recordingRef(LINE, "in-rec"),
    });
  });

  it("le registre en panne n'empêche pas de chercher : horaire et numéro, comme avant", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);
    vi.mocked(getCdr).mockRejectedValue(new VoipMsError("timeout", "voip.ms: aucune réponse"));
    vi.mocked(getCallRecordings).mockResolvedValue([rec({ callrecording: "t", when: at(T, 20) })]);

    const out = await pullCallRecording(call.id);
    expect(out).toMatchObject({
      status: "attached",
      recordingUrl: recordingRef(LINE, "t"),
      diag: { matchedBy: "time", cdrFound: false, cdrError: "voip.ms: aucune réponse" },
    });
    expect(await providerCallIdOf(call.id)).toBeNull();
  });

  it("retrouvé au registre sans enregistrement encore : l'uniqueid est gardé pour la prochaine fois", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);
    vi.mocked(getCdr).mockResolvedValue([cdr({ uniqueid: "later" })]);

    expect(await pullCallRecording(call.id)).toMatchObject({
      status: "not_found",
      reason: "pending",
      diag: { cdrFound: true },
    });
    expect(await providerCallIdOf(call.id)).toBe("later");
  });

  it("un uniqueid déjà porté par un autre appel du journal ne se reprend pas", async () => {
    const luc = await lineUser();
    await makeCall(luc.id, { startedAt: at(T, 10), providerCallId: "owned" });
    const call = await makeCall(luc.id);
    vi.mocked(getCdr).mockResolvedValue([cdr({ uniqueid: "owned", when: at(T, 10) })]);

    await pullCallRecording(call.id);
    expect(await providerCallIdOf(call.id)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("la synchro de la journée rattache avec les MÊMES règles", () => {
  it("par l'uniqueid du CDR", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id, { providerCallId: "cdr-9" });
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "r9", call_id: "cdr-9", when: at(T, 100) }),
    ]);

    const result = await syncCdrRange(DAY, DAY);
    expect(result.counts.recordingsAttached).toBe(1);
    expect(await recordingOf(call.id)).toBe(recordingRef(LINE, "r9"));
  });

  it("par horaire et numéro quand l'uniqueid ne correspond à rien", async () => {
    const luc = await lineUser();
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockResolvedValue([
      rec({ callrecording: "r10", when: at(T, 30) }),
    ]);

    const result = await syncCdrRange(DAY, DAY);
    expect(result.counts.recordingsAttached).toBe(1);
    expect(await recordingOf(call.id)).toBe(recordingRef(LINE, "r10"));
  });

  it("un enregistrement sans URL ni identifiant est compté et décrit, pas perdu en silence", async () => {
    await lineUser();
    vi.mocked(getCallRecordings).mockResolvedValue([rec({ callrecording: undefined })]);

    const result = await syncCdrRange(DAY, DAY);
    expect(result.counts.recordingsWithoutUrl).toBe(1);
    expect(result.recordingFields).toContain("datetime");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("la route", () => {
  type Account = { id: string; role: "admin" | "caller"; tokenVersion: number };

  async function loginAs(user: Account | null): Promise<void> {
    ctx.cookies.clear();
    if (!user) return;
    const token = await new SignJWT({
      uid: user.id,
      role: user.role,
      tv: user.tokenVersion,
      remember: false,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
    ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: token });
  }

  const post = (id: string) =>
    route.POST(new Request(`http://localhost/api/admin/calls/${id}/recording`, { method: "POST" }), {
      params: Promise.resolve({ id }),
    });

  let patron: Awaited<ReturnType<typeof makeUser>>;
  let luc: Awaited<ReturnType<typeof makeUser>>;
  let stagiaire: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    patron = await makeUser({ name: "Alex-Honoré", role: "admin" });
    luc = await lineUser();
    stagiaire = await makeUser({ name: "Stagiaire", role: "caller" });
    // Le téléphoniste reçoit le droit d'ÉCOUTER ; l'observateur ne l'a pas.
    const base = defaultPermissionsConfig();
    await setSetting("permissions", {
      ...base,
      roles: base.roles.map((r) =>
        r.id === CALLER_ROLE_ID ? { ...r, perms: { ...r.perms, "clients.recordings": true } } : r,
      ),
      userRoles: { [luc.id]: CALLER_ROLE_ID, [stagiaire.id]: OBSERVER_ROLE_ID },
    });
    await loginAs(luc);
  });

  it("rattache, trace la demande, et ne renvoie pas la référence au navigateur", async () => {
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockResolvedValue([rec({ callrecording: "r1", when: at(T, 10) })]);

    const res = await post(call.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "attached" });
    expect(await recordingOf(call.id)).toBe(recordingRef(LINE, "r1"));

    const logs = await testDb.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toEqual(["recording.pull"]);
    expect(logs[0].userId).toBe(luc.id);
    expect(logs[0].entityId).toBe(call.id);
    expect((logs[0].detail as { status: string }).status).toBe("attached");
  });

  it("« pas encore » est une réponse, pas une panne — et elle est tracée aussi", async () => {
    const call = await makeCall(luc.id);

    const res = await post(call.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_found", reason: "pending" });
    const [log] = await testDb.select().from(auditLogs);
    expect(log.detail).toMatchObject({
      status: "not_found",
      reason: "pending",
      voipms: { recordingsOnLine: 0, cdrFound: false },
    });
  });

  it("des enregistrements, mais pas le sien : la raison le dit, et l'audit garde les NOMS de champs", async () => {
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockResolvedValue([rec({ when: at(T, 900) })]);

    const res = await post(call.id);
    expect(await res.json()).toEqual({ status: "not_found", reason: "unmatched" });
    const [log] = await testDb.select().from(auditLogs);
    const detail = log.detail as { voipms: { recordingFields: string[]; nearestGapSec: number } };
    expect(detail.voipms.recordingFields).toEqual(
      expect.arrayContaining(["callrecording", "call_id", "datetime", "destination"]),
    );
    expect(detail.voipms.nearestGapSec).toBe(900);
    // Des noms, jamais des valeurs.
    expect(JSON.stringify(log.detail)).not.toContain("4185551234");
  });

  it("voip.ms en panne : 502", async () => {
    const call = await makeCall(luc.id);
    vi.mocked(getCallRecordings).mockRejectedValue(new VoipMsError("timeout", "lent"));

    const res = await post(call.id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: "upstream_error" });
  });

  it("sans le droit d'écouter : 403, et voip.ms n'est pas interrogé", async () => {
    const call = await makeCall(luc.id);
    await loginAs(stagiaire);

    const res = await post(call.id);
    expect(res.status).toBe(403);
    expect(getCallRecordings).not.toHaveBeenCalled();
  });

  it("sur une fiche invisible : INTROUVABLE, pas « interdit » — et voip.ms n'est pas interrogé", async () => {
    // Une fiche tenue par le patron est invisible au téléphoniste (bucket
    // `role:admin` = INVISIBLE dans la configuration livrée).
    const fiche = await makeClient({ fullName: "Client du patron", assignedToId: patron.id });
    const call = await makeCall(luc.id, { clientId: fiche.id });

    const res = await post(call.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(getCallRecordings).not.toHaveBeenCalled();
    expect(await testDb.select().from(auditLogs)).toHaveLength(0);
  });

  it("identifiant invalide : 400 ; inconnu : 404 ; sans session : 401", async () => {
    expect((await post("pas-un-uuid")).status).toBe(400);
    expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    await loginAs(null);
    expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(401);
  });
});
