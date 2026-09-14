/**
 * Intégration — synchronisation CDR voip.ms (src/lib/cdr-sync.ts) :
 * attribution par sous-compte et par DID (repli), regroupement des pattes
 * multi-comptes d'un même appel entrant, insertion des appels manqués avec
 * notification, rapprochement sans doublon avec le journal du webphone.
 * Le réseau voip.ms est entièrement simulé — la base, elle, est réelle.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatInTimeZone } from "date-fns-tz";
import { eq } from "drizzle-orm";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";
import { calls, notifications } from "@/db/schema";
import { callStars } from "@/db/schema-library";

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

  // ── Ligne partagée, pattes d'un même appel (2026-09-12 : l'appel d'Alex au
  //    581-990-5955 inscrit deux fois sous « mikey », qui partageait sa ligne) ──

  const ALEX_DID = "+15149561693";
  const hourAgo = () => new Date(Date.now() - 3600_000);
  const outboundLeg = (at: Date, overrides: Partial<VoipMsCdr> = {}) =>
    cdrRow({
      date: cdrDate(at),
      callerid: "5149561693",
      destination: "15819905955",
      description: "Outbound",
      disposition: "ANSWERED",
      seconds: "1011",
      ...overrides,
    });

  it("ligne PARTAGÉE : l'appel sortant revient à celui dont le webphone l'a journalisé — une seule fois", async () => {
    const alex = await makeUser({
      name: "Alex",
      sipUsername: SUB_ACCOUNT,
      didNumber: ALEX_DID,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await makeUser({
      name: "mikey",
      sipUsername: SUB_ACCOUNT,
      didNumber: DID,
      createdAt: new Date("2026-09-06T00:00:00Z"),
    });
    const at = hourAgo();
    const [webphone] = await testDb
      .insert(calls)
      .values({
        userId: alex.id,
        direction: "outbound",
        fromNumber: ALEX_DID,
        toNumber: "+15819905955",
        startedAt: at,
        answeredAt: new Date(at.getTime() + 5000),
        durationSec: 1010,
        provider: "voipms",
      })
      .returning();
    // Deux pattes, horodatées à une seconde d'écart.
    vi.mocked(getCdr).mockResolvedValue([
      outboundLeg(at, { uniqueid: "leg-a" }),
      outboundLeg(new Date(at.getTime() + 1000), { uniqueid: "leg-b" }),
    ]);

    const out = await runSync(dayStr(at), dayStr(new Date()));
    expect(out.counts.inserted).toBe(0);
    expect(out.counts.matchedHeuristic).toBe(1);
    const rows = await testDb.select().from(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: webphone.id, userId: alex.id, providerCallId: "leg-a" });
  });

  it("ligne PARTAGÉE : un entrant va à celui dont le DID a été composé", async () => {
    await makeUser({
      name: "Alex",
      sipUsername: SUB_ACCOUNT,
      didNumber: ALEX_DID,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const mikey = await makeUser({
      name: "mikey",
      sipUsername: SUB_ACCOUNT,
      didNumber: DID,
      createdAt: new Date("2026-09-06T00:00:00Z"),
    });
    const at = hourAgo();
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ date: cdrDate(at), disposition: "ANSWERED", seconds: "60" }),
    ]);

    await runSync(dayStr(at), dayStr(new Date()));
    const [row] = await testDb.select().from(calls);
    expect(row).toMatchObject({ userId: mikey.id, direction: "inbound" });
  });

  it("deux synchros qui ne gardent pas la même patte n'inscrivent pas l'appel deux fois", async () => {
    await makeLineUser();
    const at = hourAgo();
    const kept = outboundLeg(at, { callerid: "4189065924", uniqueid: "leg-2" });
    vi.mocked(getCdr).mockResolvedValue([kept]);
    await runSync(dayStr(at), dayStr(new Date()));

    // La seconde fois, voip.ms liste aussi l'autre patte, de même durée : le
    // regroupement garde le plus petit uniqueid — pas celui de la 1re synchro.
    vi.mocked(getCdr).mockResolvedValue([
      kept,
      outboundLeg(new Date(at.getTime() + 1000), { callerid: "4189065924", uniqueid: "leg-1" }),
    ]);
    const second = await runSync(dayStr(at), dayStr(new Date()));
    expect(second.counts.inserted).toBe(0);
    expect(await testDb.select().from(calls)).toHaveLength(1);
  });

  // ── Réparation des doublons déjà en base — pour n'importe quels comptes ──

  /** Une ligne telle que la synchro la crée depuis le registre : à la seconde pile. */
  async function registryCall(userId: string, at: Date, over: Partial<typeof calls.$inferInsert> = {}) {
    const startedAt = new Date(Math.floor(at.getTime() / 1000) * 1000);
    const durationSec = over.durationSec ?? 1011;
    const [row] = await testDb
      .insert(calls)
      .values({
        userId,
        direction: "outbound",
        fromNumber: "+14189065924",
        toNumber: "+15819905955",
        startedAt,
        answeredAt: startedAt,
        endedAt: new Date(startedAt.getTime() + durationSec * 1000),
        durationSec,
        provider: "voipms",
        providerCallId: `reg-${Math.random().toString(36).slice(2)}`,
        ...over,
      })
      .returning();
    return row;
  }
  /** Un appel du webphone : l'heure du navigateur, avec ses millisecondes. */
  async function webphoneCall(userId: string, at: Date, over: Partial<typeof calls.$inferInsert> = {}) {
    const startedAt = new Date(Math.floor(at.getTime() / 1000) * 1000 + 437);
    const [row] = await testDb
      .insert(calls)
      .values({
        userId,
        direction: "outbound",
        fromNumber: ALEX_DID,
        toNumber: "+15819905955",
        startedAt,
        answeredAt: new Date(startedAt.getTime() + 5000),
        durationSec: 1010,
        provider: "voipms",
        ...over,
      })
      .returning();
    return row;
  }
  async function sharedLine() {
    const alex = await makeUser({
      name: "Alex",
      sipUsername: SUB_ACCOUNT,
      didNumber: ALEX_DID,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const mikey = await makeUser({
      name: "mikey",
      sipUsername: SUB_ACCOUNT,
      didNumber: DID,
      createdAt: new Date("2026-09-06T00:00:00Z"),
    });
    return { alex, mikey };
  }

  it("RÉPARE : les doublons nés sous l'autre compte d'une ligne partagée rejoignent l'appel du webphone", async () => {
    const { alex, mikey } = await sharedLine();
    const at = hourAgo();
    const mine = await webphoneCall(alex.id, at);
    const withRecording = await registryCall(mikey.id, at, {
      providerCallId: "leg-a",
      recordingUrl: "voipms:100000_alex:r1",
    });
    await registryCall(mikey.id, new Date(at.getTime() + 1000), { providerCallId: "leg-b" });
    // Marqué par quelqu'un avant la réparation : l'étoile suit.
    await testDb.insert(callStars).values({ callId: withRecording.id, userId: alex.id });

    const out = await runSync(dayStr(at), dayStr(new Date()));
    expect(out.counts.duplicatesMerged).toBe(2);

    const rows = await testDb.select().from(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: mine.id,
      userId: alex.id,
      providerCallId: "leg-a",
      recordingUrl: "voipms:100000_alex:r1",
      durationSec: 1011,
    });
    const stars = await testDb.select().from(callStars);
    expect(stars.map((s) => s.callId)).toEqual([mine.id]);
  });

  it("RÉPARE : la patte en trop à côté d'un appel du webphone DÉJÀ retrouvé — qui garde ses données", async () => {
    const me = await makeLineUser();
    const at = hourAgo();
    // L'appel du webphone, retrouvé par une synchro : sa disposition, son uniqueid, l'enregistrement.
    const mine = await webphoneCall(me.id, at, {
      providerCallId: "leg-1",
      disposition: "voicemail",
      durationSec: 63,
      recordingUrl: "voipms:100000_alex:r4",
    });
    // L'autre patte, inscrite comme un appel, avec le même enregistrement.
    await registryCall(me.id, new Date(at.getTime() + 1000), {
      providerCallId: "leg-2",
      durationSec: 63,
      recordingUrl: "voipms:100000_alex:r4",
    });

    const out = await runSync(dayStr(at), dayStr(new Date()));
    expect(out.counts.duplicatesMerged).toBe(1);
    const rows = await testDb.select().from(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: mine.id,
      providerCallId: "leg-1",
      disposition: "voicemail",
      recordingUrl: "voipms:100000_alex:r4",
    });
  });

  it("un appel très court : ses pattes à 4 s d'écart restent UN appel, et la patte fondue ne revient pas", async () => {
    const me = await makeLineUser();
    const at = hourAgo();
    // Le webphone, retrouvé par la patte 1 ; la patte 2 démarre 4 s plus tard.
    // Une seconde chacune : elles ne se chevauchent pas.
    const mine = await webphoneCall(me.id, at, {
      providerCallId: "short-1",
      disposition: "voicemail",
      durationSec: 1,
      endedAt: new Date(Math.floor(at.getTime() / 1000) * 1000 + 9_437),
    });
    await registryCall(me.id, new Date(at.getTime() + 4000), { providerCallId: "short-2", durationSec: 1 });
    vi.mocked(getCdr).mockResolvedValue([
      outboundLeg(at, { callerid: "4189065924", seconds: "1", uniqueid: "short-1" }),
      outboundLeg(new Date(at.getTime() + 4000), { callerid: "4189065924", seconds: "1", uniqueid: "short-2" }),
    ]);

    const first = await runSync(dayStr(at), dayStr(new Date()));
    expect(first.counts.duplicatesMerged).toBe(1);
    expect(first.counts.inserted).toBe(0);
    // Et la synchro suivante n'a plus rien à défaire ni à refaire.
    const second = await runSync(dayStr(at), dayStr(new Date()));
    expect(second.counts.duplicatesMerged).toBe(0);
    expect(second.counts.inserted).toBe(0);
    const rows = await testDb.select().from(calls);
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });

  it("un entrant dont la patte qui décroche démarre 25 s après celle qui sonne : UN appel, sans va-et-vient", async () => {
    const me = await makeLineUser();
    const at = hourAgo();
    const base = Math.floor(at.getTime() / 1000) * 1000;
    // Le webphone, retrouvé par la patte qui sonne.
    const mine = await webphoneCall(me.id, at, {
      direction: "inbound",
      fromNumber: "+14184311685",
      toNumber: DID,
      providerCallId: "ring",
      durationSec: 229,
      endedAt: new Date(base + 254_437),
    });
    // Le doublon qu'avaient laissé les synchros d'avant (la patte qui décroche).
    await registryCall(me.id, new Date(base + 25_000), {
      direction: "inbound",
      fromNumber: "+141843116854184311685",
      toNumber: DID,
      providerCallId: "answer",
      durationSec: 229,
    });
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ date: cdrDate(at), callerid: "4184311685", disposition: "NO ANSWER", seconds: "0", uniqueid: "ring" }),
      cdrRow({
        date: cdrDate(new Date(base + 25_000)),
        callerid: '"4184311685" <4184311685>',
        disposition: "ANSWERED",
        seconds: "229",
        uniqueid: "answer",
      }),
    ]);

    const first = await runSync(dayStr(at), dayStr(new Date()));
    expect(first.counts.duplicatesMerged).toBe(1);
    expect(first.counts.inserted).toBe(0);
    const second = await runSync(dayStr(at), dayStr(new Date()));
    expect(second.counts.duplicatesMerged).toBe(0);
    expect(second.counts.inserted).toBe(0);
    const rows = await testDb.select().from(calls);
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });

  it("ligne PARTAGÉE : un entrant au DID de l'un, décroché par l'autre, n'est pas réinséré à chaque synchro", async () => {
    const { alex, mikey } = await sharedLine();
    const at = hourAgo();
    const base = Math.floor(at.getTime() / 1000) * 1000;
    // mikey a décroché l'appel composé au DID d'Alex : c'est son webphone qui l'a journalisé.
    const answered = await webphoneCall(mikey.id, at, {
      direction: "inbound",
      fromNumber: "+14184311685",
      toNumber: ALEX_DID,
      providerCallId: "ring",
      disposition: "dncl",
      durationSec: 31,
      endedAt: new Date(base + 56_437),
    });
    // Le doublon laissé sous Alex, celui dont le DID a été composé.
    await registryCall(alex.id, new Date(base + 25_000), {
      direction: "inbound",
      fromNumber: "+14184311685",
      toNumber: ALEX_DID,
      providerCallId: "answer",
      durationSec: 31,
    });
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ date: cdrDate(at), callerid: "4184311685", destination: "5149561693", disposition: "NO ANSWER", seconds: "0", uniqueid: "ring" }),
      cdrRow({
        date: cdrDate(new Date(base + 25_000)),
        callerid: "4184311685",
        destination: "5149561693",
        disposition: "ANSWERED",
        seconds: "31",
        uniqueid: "answer",
      }),
    ]);

    const first = await runSync(dayStr(at), dayStr(new Date()));
    expect(first.counts.duplicatesMerged).toBe(1);
    expect(first.counts.inserted).toBe(0);
    const second = await runSync(dayStr(at), dayStr(new Date()));
    expect(second.counts.duplicatesMerged).toBe(0);
    expect(second.counts.inserted).toBe(0);
    const rows = await testDb.select().from(calls);
    expect(rows.map((r) => r.id)).toEqual([answered.id]);
  });

  it("ligne PARTAGÉE : même quand la patte qui décroche passe par le compte PRINCIPAL", async () => {
    const { alex, mikey } = await sharedLine();
    const at = hourAgo();
    const base = Math.floor(at.getTime() / 1000) * 1000;
    const answered = await webphoneCall(mikey.id, at, {
      direction: "inbound",
      fromNumber: "+15142661939",
      toNumber: ALEX_DID,
      providerCallId: "ring",
      disposition: "callback",
      durationSec: 229,
      endedAt: new Date(base + 254_437),
    });
    await registryCall(alex.id, new Date(base + 25_000), {
      direction: "inbound",
      fromNumber: "+15142661939",
      toNumber: ALEX_DID,
      providerCallId: "answer",
      durationSec: 229,
    });
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ date: cdrDate(at), callerid: "5142661939", destination: "5149561693", disposition: "NO ANSWER", seconds: "0", uniqueid: "ring" }),
      // Compte principal : attribuée à Alex par son DID.
      cdrRow({
        date: cdrDate(new Date(base + 25_000)),
        account: MAIN_ACCOUNT,
        callerid: "5142661939",
        destination: "5149561693",
        disposition: "ANSWERED",
        seconds: "229",
        uniqueid: "answer",
      }),
    ]);

    const first = await runSync(dayStr(at), dayStr(new Date()));
    expect(first.counts.duplicatesMerged).toBe(1);
    expect(first.counts.inserted).toBe(0);
    const second = await runSync(dayStr(at), dayStr(new Date()));
    expect(second.counts.duplicatesMerged).toBe(0);
    expect(second.counts.inserted).toBe(0);
    const rows = await testDb.select().from(calls);
    expect(rows.map((r) => r.id)).toEqual([answered.id]);
  });

  it("ne fond pas un rappel dans le premier essai quand le webphone n'a journalisé que celui-ci", async () => {
    const { alex, mikey } = await sharedLine();
    const at = hourAgo();
    // Premier essai sans réponse, raccroché après 30 s — le seul que le webphone a gardé.
    const firstTry = await webphoneCall(alex.id, at, {
      answeredAt: null,
      durationSec: 0,
      endedAt: new Date(Math.floor(at.getTime() / 1000) * 1000 + 30_437),
    });
    // Deux doublons : l'essai, et le rappel une minute plus tard (5 min, enregistré).
    await registryCall(mikey.id, at, { answeredAt: null, durationSec: 0, providerCallId: "try" });
    const redial = await registryCall(mikey.id, new Date(at.getTime() + 60_000), {
      durationSec: 300,
      providerCallId: "redial",
      recordingUrl: "voipms:100000_alex:r3",
    });

    const out = await runSync(dayStr(at), dayStr(new Date()));
    expect(out.counts.duplicatesMerged).toBe(1);
    const [tried] = await testDb.select().from(calls).where(eq(calls.id, firstTry.id));
    // L'essai garde le sien — pas l'enregistrement de 5 min du rappel.
    expect(tried).toMatchObject({ providerCallId: "try", recordingUrl: null, durationSec: 0 });
    const [kept] = await testDb.select().from(calls).where(eq(calls.id, redial.id));
    expect(kept?.recordingUrl).toBe("voipms:100000_alex:r3");
  });

  it("RÉPARE : un appel reçu, inscrit sous l'autre compte comme un sortant vers son DID, lui revient", async () => {
    const { alex, mikey } = await sharedLine();
    const at = hourAgo();
    const row = await registryCall(mikey.id, at, {
      fromNumber: "+14185551234",
      toNumber: ALEX_DID,
      durationSec: 60,
    });

    const out = await runSync(dayStr(at), dayStr(new Date()));
    expect(out.counts.callsReassigned).toBe(1);
    const [after] = await testDb.select().from(calls).where(eq(calls.id, row.id));
    expect(after).toMatchObject({ userId: alex.id, direction: "inbound" });
  });

  it("RÉPARE : deux pattes d'un même appel inscrites comme deux appels n'en font plus qu'un", async () => {
    const me = await makeLineUser();
    const at = hourAgo();
    await registryCall(me.id, at);
    const keeper = await registryCall(me.id, new Date(at.getTime() + 1000), {
      recordingUrl: "voipms:100000_alex:r2",
    });

    const out = await runSync(dayStr(at), dayStr(new Date()));
    expect(out.counts.duplicatesMerged).toBe(1);
    const rows = await testDb.select().from(calls);
    expect(rows.map((r) => r.id)).toEqual([keeper.id]);
  });

  it("ne touche ni à ce qu'une personne a annoté, ni aux comptes qui ne partagent pas de ligne, ni à un rappel", async () => {
    const { alex, mikey } = await sharedLine();
    const other = await makeUser({ name: "Sam", sipUsername: "100000_sam", didNumber: "+14180009999" });
    const at = hourAgo();
    // Ligne partagée, mais le « doublon » porte une disposition : quelqu'un l'a traité.
    await webphoneCall(alex.id, at);
    await registryCall(mikey.id, at, { disposition: "interested" });
    // Même numéro, même minute, mais sur une AUTRE ligne : deux vrais appels.
    await registryCall(other.id, at, { fromNumber: "+14180009999" });
    // Deux appels de Sam au même numéro, le second après la fin du premier.
    await registryCall(other.id, new Date(at.getTime() + 3600_000 / 2), { durationSec: 20 });
    await registryCall(other.id, new Date(at.getTime() + 3600_000 / 2 + 60_000), { durationSec: 20 });

    const out = await runSync(dayStr(at), dayStr(new Date()));
    expect(out.counts.duplicatesMerged).toBe(0);
    expect(out.counts.callsReassigned).toBe(0);
    expect(await testDb.select().from(calls)).toHaveLength(5);
  });

  it("un rappel du même numéro, après la fin du premier appel, reste un appel à part", async () => {
    await makeLineUser();
    const at = hourAgo();
    vi.mocked(getCdr).mockResolvedValue([
      outboundLeg(at, { callerid: "4189065924", seconds: "20", uniqueid: "first" }),
      outboundLeg(new Date(at.getTime() + 40_000), {
        callerid: "4189065924",
        seconds: "300",
        uniqueid: "redial",
      }),
    ]);

    const out = await runSync(dayStr(at), dayStr(new Date()));
    expect(out.counts.inserted).toBe(2);
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

  // ── Changement d'heure ─────────────────────────────────────────────────────
  // voip.ms renvoie l'heure LOCALE de Toronto ; la synchro tourne sur hier +
  // aujourd'hui. Chaque ligne doit être lue avec le décalage valable À SON
  // instant — pas celui du premier jour de la plage, sinon le dimanche du
  // changement tout le jour est décalé d'une heure et chaque appel du webphone
  // se dédouble (l'heuristique ne voit rien à ±3 min).

  it("passage à l'heure avancée (2026-03-08) : un appel du webphone le jour J est rattaché, pas dédoublé", async () => {
    const me = await makeLineUser();
    // 10:30 EDT le 8 mars = 14:30Z — journalisé par le webphone sans providerCallId.
    const startedAt = new Date("2026-03-08T14:30:00.000Z");
    await testDb.insert(calls).values({
      userId: me.id,
      direction: "outbound",
      fromNumber: DID,
      toNumber: "+14187778888",
      startedAt,
      endedAt: new Date(startedAt.getTime() + 60_000),
      provider: "voipms",
    });
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({
        uniqueid: "dst-spring",
        callerid: "4189065924",
        destination: "4187778888",
        date: "2026-03-08 10:30:12",
        disposition: "ANSWERED",
        seconds: "60",
      }),
    ]);

    const result = await syncCdrRange("2026-03-07", "2026-03-08");
    expect(result.errors).toEqual([]);
    expect(result.counts.matchedHeuristic).toBe(1);
    expect(result.counts.inserted).toBe(0);

    const rows = await testDb.select().from(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0].providerCallId).toBe("dst-spring");
  });

  it("retour à l'heure normale (2026-11-01) : même chose dans l'autre sens", async () => {
    const me = await makeLineUser();
    // 10:00 EST le 1er novembre = 15:00Z.
    const startedAt = new Date("2026-11-01T15:00:00.000Z");
    await testDb.insert(calls).values({
      userId: me.id,
      direction: "inbound",
      fromNumber: "+14185551234",
      toNumber: DID,
      startedAt,
      endedAt: startedAt,
      provider: "voipms",
    });
    vi.mocked(getCdr).mockResolvedValue([cdrRow({ uniqueid: "dst-fall", date: "2026-11-01 10:00:05" })]);

    const result = await syncCdrRange("2026-10-31", "2026-11-01");
    expect(result.counts.matchedHeuristic).toBe(1);
    expect(result.counts.inserted).toBe(0);
    expect((await testDb.select().from(calls))[0].providerCallId).toBe("dst-fall");
  });

  it("une plage qui enjambe le changement : chaque ligne garde SON décalage (−4 puis −5)", async () => {
    await makeLineUser();
    vi.mocked(getCdr).mockResolvedValue([
      cdrRow({ uniqueid: "before", date: "2026-10-31 10:00:00", callerid: "4181110000" }),
      cdrRow({ uniqueid: "after", date: "2026-11-01 10:00:00", callerid: "4182220000" }),
    ]);

    const result = await syncCdrRange("2026-10-31", "2026-11-01");
    expect(result.counts.inserted).toBe(2);

    const rows = await testDb.select().from(calls);
    const byId = new Map(rows.map((r) => [r.providerCallId, r]));
    expect(byId.get("before")?.startedAt.toISOString()).toBe("2026-10-31T14:00:00.000Z"); // EDT
    expect(byId.get("after")?.startedAt.toISOString()).toBe("2026-11-01T15:00:00.000Z"); // EST
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
