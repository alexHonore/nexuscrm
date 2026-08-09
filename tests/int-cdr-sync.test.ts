/**
 * Intégration — synchronisation CDR voip.ms (src/lib/cdr-sync.ts) :
 * attribution par sous-compte et par DID (repli), regroupement des pattes
 * multi-comptes d'un même appel entrant, insertion des appels manqués avec
 * notification, rapprochement sans doublon avec le journal du webphone.
 * Le réseau voip.ms est entièrement simulé — la base, elle, est réelle.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";
import { calls, notifications } from "@/db/schema";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/voipms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voipms")>();
  return {
    ...actual,
    getCdr: vi.fn(async () => []),
    getCallRecordings: vi.fn(async () => []),
  };
});

const { getCdr } = await import("@/lib/voipms");
const { collapseCrossAccountLegs, syncCdrRange } = await import("@/lib/cdr-sync");
type VoipMsCdr = Awaited<ReturnType<typeof getCdr>>[number];

const APP_TZ = "America/Toronto";
const SUB_ACCOUNT = "100000_alex";
const MAIN_ACCOUNT = "100000";
const DID = "+14189065924";

/** Horodatage CDR (heure locale de Toronto) pour un instant donné. */
function cdrDate(at: Date): string {
  return formatInTimeZone(at, APP_TZ, "yyyy-MM-dd HH:mm:ss");
}
function dayStr(at: Date): string {
  return formatInTimeZone(at, APP_TZ, "yyyy-MM-dd");
}

let uid = 0;
function cdrRow(overrides: Partial<VoipMsCdr> = {}): VoipMsCdr {
  uid += 1;
  return {
    date: cdrDate(new Date()),
    callerid: "4185551234",
    destination: "4189065924",
    description: "Inbound DID",
    account: SUB_ACCOUNT,
    disposition: "NO ANSWER",
    duration: "00:00:00",
    seconds: "0",
    uniqueid: `uid-${uid}`,
    ...overrides,
  };
}

function makeLineUser(overrides: Parameters<typeof makeUser>[0] = {}) {
  return makeUser({ sipUsername: SUB_ACCOUNT, didNumber: DID, ...overrides });
}

async function runSync(from = dayStr(new Date()), to = dayStr(new Date())) {
  return syncCdrRange(from, to);
}

describe("synchronisation CDR", () => {
  afterAll(closeDb);
  beforeEach(async () => {
    await resetDb();
    vi.mocked(getCdr).mockReset();
    vi.mocked(getCdr).mockResolvedValue([]);
  });

  it("insère un entrant manqué (sous-compte connu) et notifie le propriétaire de la ligne", async () => {
    const me = await makeLineUser();
    const client = await makeClient({ fullName: "Jean Tremblay", phone: "+14185551234" });
    vi.mocked(getCdr).mockResolvedValue([cdrRow()]);

    const result = await runSync();
    expect(result.errors).toEqual([]);
    expect(result.counts.inserted).toBe(1);
    expect(result.counts.missedNotified).toBe(1);

    const [row] = await testDb.select().from(calls);
    expect(row.userId).toBe(me.id);
    expect(row.direction).toBe("inbound");
    expect(row.answeredAt).toBeNull();
    expect(row.clientId).toBe(client.id);
    expect(row.fromNumber).toBe("+14185551234");

    const [notif] = await testDb.select().from(notifications);
    expect(notif.userId).toBe(me.id);
    expect(notif.type).toBe("missed_call");
    expect(notif.body).toContain("Jean Tremblay");
    expect(notif.link).toBe(`/clients/${client.id}`);
  });

  it("attribue par DID quand le compte CDR est inconnu (patte du compte principal)", async () => {
    const me = await makeLineUser();
    vi.mocked(getCdr).mockResolvedValue([cdrRow({ account: MAIN_ACCOUNT })]);

    const result = await runSync();
    expect(result.counts.unknownAccount).toBe(0);
    expect(result.counts.inserted).toBe(1);

    const [row] = await testDb.select().from(calls);
    expect(row.userId).toBe(me.id);
    expect(row.direction).toBe("inbound");
    expect(row.answeredAt).toBeNull();
  });

  it("écarte toujours un compte inconnu dont la destination n'est le DID de personne", async () => {
    await makeLineUser();
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ account: "999999_autre", destination: "4187770000" }),
    ]);

    const result = await runSync();
    expect(result.counts.unknownAccount).toBe(1);
    expect(result.counts.inserted).toBe(0);
    expect(await testDb.select().from(calls)).toHaveLength(0);
  });

  it("regroupe les pattes d'un même entrant réparties sur deux comptes (pas de doublon)", async () => {
    const me = await makeLineUser();
    const at = cdrDate(new Date());
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ account: MAIN_ACCOUNT, uniqueid: "leg-main", date: at, seconds: "20" }),
      cdrRow({ account: SUB_ACCOUNT, uniqueid: "leg-sub", date: at, seconds: "15" }),
    ]);

    const result = await runSync();
    expect(result.counts.inserted).toBe(1);
    expect(result.counts.missedNotified).toBe(1);

    const rows = await testDb.select().from(calls);
    expect(rows).toHaveLength(1);
    // La patte du sous-compte porte le bon propriétaire : c'est elle qu'on garde.
    expect(rows[0].providerCallId).toBe("leg-sub");
    expect(rows[0].userId).toBe(me.id);
  });

  it("regroupe aussi des pattes décalées d'une seconde (sauts d'acheminement différents)", async () => {
    const me = await makeLineUser();
    const at = new Date();
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ account: MAIN_ACCOUNT, uniqueid: "leg-main", date: cdrDate(at), seconds: "20" }),
      cdrRow({
        account: SUB_ACCOUNT,
        uniqueid: "leg-sub",
        date: cdrDate(new Date(at.getTime() + 1000)),
        seconds: "15",
      }),
    ]);

    const result = await runSync();
    expect(result.counts.inserted).toBe(1);
    expect(result.counts.missedNotified).toBe(1);

    const rows = await testDb.select().from(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0].providerCallId).toBe("leg-sub");
    expect(rows[0].userId).toBe(me.id);
  });

  it("un appel interne (agent A → DID de l'agent B) reste DEUX appels : sortant pour A, manqué pour B", async () => {
    const alice = await makeLineUser(); // possède le DID appelé
    const bob = await makeUser({ sipUsername: "100000_bob", didNumber: "+14185559999" });
    const at = cdrDate(new Date());
    // Le lot CDR contient la patte sortante de Bob ET la patte entrante
    // d'Alice, mêmes numéros, même seconde — deux comptes CONNUS.
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({
        account: "100000_bob",
        callerid: "4185559999",
        destination: "4189065924",
        uniqueid: "leg-bob-out",
        date: at,
        disposition: "NO ANSWER",
      }),
      cdrRow({
        account: SUB_ACCOUNT,
        callerid: "4185559999",
        destination: "4189065924",
        uniqueid: "leg-alice-in",
        date: at,
        disposition: "NO ANSWER",
      }),
    ]);

    const result = await runSync();
    expect(result.counts.inserted).toBe(2);
    expect(result.counts.missedNotified).toBe(1);

    const rows = await testDb.select().from(calls);
    expect(rows).toHaveLength(2);
    const bobCall = rows.find((r) => r.userId === bob.id);
    const aliceCall = rows.find((r) => r.userId === alice.id);
    expect(bobCall?.direction).toBe("outbound");
    expect(aliceCall?.direction).toBe("inbound");
    expect(aliceCall?.answeredAt).toBeNull();

    const notifs = await testDb.select().from(notifications);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId).toBe(alice.id);
  });

  it("rattache un manqué déjà journalisé par le webphone — sans doublon ni re-notification", async () => {
    const me = await makeLineUser();
    const now = new Date();
    await testDb.insert(calls).values({
      userId: me.id,
      direction: "inbound",
      fromNumber: "+14185551234",
      toNumber: DID,
      startedAt: now,
      endedAt: now,
      provider: "voipms",
    });
    vi.mocked(getCdr).mockResolvedValue([cdrRow({ date: cdrDate(now) })]);

    const result = await runSync();
    expect(result.counts.matchedHeuristic).toBe(1);
    expect(result.counts.inserted).toBe(0);
    expect(result.counts.missedNotified).toBe(0);

    const rows = await testDb.select().from(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0].providerCallId).toBe("uid-" + uid);
    expect(await testDb.select().from(notifications)).toHaveLength(0);
  });

  it("insère les vieux manqués (rattrapage) SANS notification", async () => {
    await makeLineUser();
    const threeDaysAgo = new Date(Date.now() - 72 * 3600_000);
    vi.mocked(getCdr).mockResolvedValue([cdrRow({ date: cdrDate(threeDaysAgo) })]);

    const result = await runSync(dayStr(threeDaysAgo), dayStr(new Date()));
    expect(result.counts.inserted).toBe(1);
    expect(result.counts.missedNotified).toBe(0);
    expect(await testDb.select().from(notifications)).toHaveLength(0);
  });

  it("un entrant répondu est inséré avec answeredAt, sans notification", async () => {
    await makeLineUser();
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ disposition: "ANSWERED", seconds: "120" }),
    ]);

    const result = await runSync();
    expect(result.counts.inserted).toBe(1);
    expect(result.counts.missedNotified).toBe(0);

    const [row] = await testDb.select().from(calls);
    expect(row.direction).toBe("inbound");
    expect(row.answeredAt).not.toBeNull();
    expect(row.durationSec).toBe(120);
    expect(await testDb.select().from(notifications)).toHaveLength(0);
  });

  it("un sortant du sous-compte reste classé sortant, sans notification", async () => {
    const me = await makeLineUser();
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({
        callerid: "4189065924",
        destination: "4187778888",
        description: "Value Route",
        disposition: "ANSWERED",
        seconds: "60",
      }),
    ]);

    const result = await runSync();
    expect(result.counts.inserted).toBe(1);

    const [row] = await testDb.select().from(calls);
    expect(row.userId).toBe(me.id);
    expect(row.direction).toBe("outbound");
    expect(await testDb.select().from(notifications)).toHaveLength(0);
  });
});

describe("collapseCrossAccountLegs", () => {
  const known = new Set([SUB_ACCOUNT]);

  it("préfère la patte d'un compte connu, quel que soit l'ordre", async () => {
    const at = cdrDate(new Date());
    const legMain = cdrRow({ account: MAIN_ACCOUNT, uniqueid: "m", date: at, seconds: "30" });
    const legSub = cdrRow({ account: SUB_ACCOUNT, uniqueid: "s", date: at, seconds: "10" });

    for (const rows of [[legMain, legSub], [legSub, legMain]]) {
      const out = collapseCrossAccountLegs(rows, known);
      expect(out).toHaveLength(1);
      expect(out[0].uniqueid).toBe("s");
    }
  });

  it("garde la patte la plus longue quand aucune n'est d'un compte connu", async () => {
    const at = cdrDate(new Date());
    const a = cdrRow({ account: "x", uniqueid: "a", date: at, seconds: "5" });
    const b = cdrRow({ account: "y", uniqueid: "b", date: at, seconds: "25" });
    const out = collapseCrossAccountLegs([a, b], known);
    expect(out).toHaveLength(1);
    expect(out[0].uniqueid).toBe("b");
  });

  it("ne regroupe pas deux appels distincts (appelants ou secondes différents)", async () => {
    const at = new Date();
    const rows = [
      cdrRow({ callerid: "4181110000", date: cdrDate(at) }),
      cdrRow({ callerid: "4182220000", date: cdrDate(at) }),
      cdrRow({ callerid: "4181110000", date: cdrDate(new Date(at.getTime() + 60_000)) }),
    ];
    expect(collapseCrossAccountLegs(rows, known)).toHaveLength(3);
  });
});
