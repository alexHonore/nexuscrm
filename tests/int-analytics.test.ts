/**
 * Tests d'intégration — analytique (agrégations + bornes de période Toronto)
 * et tâches cron (rappels de suivi, réconciliation CDR voip.ms).
 *
 * Couvre :
 *   src/app/(app)/admin/analytics/queries.ts
 *   src/components/analytics/period.ts
 *   src/components/analytics/user-stats-table.tsx (rendu réel, métriques dérivées)
 *   src/app/api/cron/followup-reminders/route.ts
 *   src/app/api/cron/sync-cdr/route.ts
 *
 * Seul le réseau externe (voip.ms) est simulé, via fetch.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hissés au-dessus des imports) ─────────────────────────────────────

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

// ── Imports produit ──────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { NextIntlClientProvider } from "next-intl";
import { NextRequest } from "next/server";
import {
  getBookingsPerWeek,
  getCallsPerDay,
  getDispositionBreakdown,
  getKpis,
  getUserOptions,
  getUserStats,
  type AnalyticsFilter,
} from "@/app/(app)/admin/analytics/queries";
import { GET as followupCron } from "@/app/api/cron/followup-reminders/route";
import { GET as syncCdrCron } from "@/app/api/cron/sync-cdr/route";
import {
  dayStartUtc,
  listDays,
  resolvePeriod,
  shiftDateStr,
  todayStr,
} from "@/components/analytics/period";
import { UserStatsTable } from "@/components/analytics/user-stats-table";
import { appointments, auditLogs, calls, followups, notifications } from "@/db/schema";
import analyticsFr from "../messages/fr/analytics.json";
import {
  closeDb,
  makeClient,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";

// ── Horloge figée ────────────────────────────────────────────────────────────

/** Jeudi 20 août 2026, 09 h 00 à Toronto (EDT, UTC−4). */
const NOW = new Date("2026-08-20T13:00:00.000Z");
/** Période « 7 j » résolue à cette date : 14 août → 20 août inclus (Toronto). */
const FROM_UTC = new Date("2026-08-14T04:00:00.000Z");
const TO_UTC_EXCL = new Date("2026-08-21T04:00:00.000Z");
const PERIOD: AnalyticsFilter = { fromUtc: FROM_UTC, toUtcExclusive: TO_UTC_EXCL };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});

// ── Fabriques ────────────────────────────────────────────────────────────────

type CallSeed = {
  userId: string;
  clientId?: string | null;
  startedAt: string;
  answered: boolean;
  durationSec: number;
  disposition?: string | null;
  direction?: "outbound" | "inbound";
  fromNumber?: string | null;
  toNumber?: string | null;
  providerCallId?: string | null;
};

async function makeCall(seed: CallSeed) {
  const startedAt = new Date(seed.startedAt);
  const [row] = await testDb
    .insert(calls)
    .values({
      userId: seed.userId,
      clientId: seed.clientId ?? null,
      direction: seed.direction ?? "outbound",
      fromNumber: seed.fromNumber ?? null,
      toNumber: seed.toNumber ?? null,
      startedAt,
      answeredAt: seed.answered ? startedAt : null,
      endedAt: new Date(startedAt.getTime() + seed.durationSec * 1000),
      durationSec: seed.durationSec,
      disposition: seed.disposition ?? null,
      providerCallId: seed.providerCallId ?? null,
      createdAt: startedAt,
    })
    .returning();
  return row;
}

async function makeAppointment(opts: { userId: string; clientId: string; createdAt: string }) {
  const [row] = await testDb
    .insert(appointments)
    .values({
      clientId: opts.clientId,
      userId: opts.userId,
      type: "meet",
      title: "RDV",
      startsAt: new Date(opts.createdAt),
      endsAt: new Date(new Date(opts.createdAt).getTime() + 30 * 60_000),
      status: "scheduled",
      createdAt: new Date(opts.createdAt),
    })
    .returning();
  return row;
}

// ── Jeu de données principal ─────────────────────────────────────────────────

type Core = {
  alice: string;
  bob: string;
  carol: string;
  dave: string;
  client: string;
};

/**
 * Alice : 4 appels (2 connectés, 435 s dont 420 s connectés), 2 RDV.
 * Bob   : 3 appels (2 connectés, 90 s), 0 RDV.
 * Carol : 0 appel, 2 RDV  ← la ligne « division par zéro ».
 * Dave  : aucune activité ← absent du tableau.
 * Leads : 3 dans la période (2 Alice, 1 Bob), 1 hors période.
 */
async function seedCore(): Promise<Core> {
  const alice = await makeUser({ name: "Alice Roy", email: "alice@nexus.test" });
  const bob = await makeUser({ name: "Bob Gagnon", email: "bob@nexus.test" });
  const carol = await makeUser({ name: "Carol Nadeau", email: "carol@nexus.test" });
  const dave = await makeUser({ name: "Dave Lemieux", email: "dave@nexus.test" });

  // Client support (créé hors période : ne compte pas comme lead).
  const client = await makeClient({
    fullName: "Client Support",
    phone: "+14185550000",
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
  });

  await makeCall({ userId: alice.id, clientId: client.id, startedAt: "2026-08-18T14:00:00.000Z", answered: true, durationSec: 120, disposition: "booked" });
  await makeCall({ userId: alice.id, clientId: client.id, startedAt: "2026-08-18T15:00:00.000Z", answered: true, durationSec: 300, disposition: "callback" });
  await makeCall({ userId: alice.id, startedAt: "2026-08-18T16:00:00.000Z", answered: false, durationSec: 0, disposition: "no_answer" });
  await makeCall({ userId: alice.id, startedAt: "2026-08-19T13:00:00.000Z", answered: false, durationSec: 15, disposition: "voicemail" });

  await makeCall({ userId: bob.id, startedAt: "2026-08-19T14:00:00.000Z", answered: true, durationSec: 60, disposition: "booked" });
  await makeCall({ userId: bob.id, startedAt: "2026-08-19T14:30:00.000Z", answered: true, durationSec: 30, disposition: "not_interested" });
  await makeCall({ userId: bob.id, startedAt: "2026-08-19T15:00:00.000Z", answered: false, durationSec: 0, disposition: null });

  // Hors période (2026-08-13 16 h Toronto) — ne doit jamais être compté.
  await makeCall({ userId: alice.id, startedAt: "2026-08-13T20:00:00.000Z", answered: true, durationSec: 999, disposition: "booked" });

  await makeAppointment({ userId: alice.id, clientId: client.id, createdAt: "2026-08-18T14:30:00.000Z" });
  await makeAppointment({ userId: alice.id, clientId: client.id, createdAt: "2026-08-19T16:00:00.000Z" });
  await makeAppointment({ userId: carol.id, clientId: client.id, createdAt: "2026-08-19T17:00:00.000Z" });
  // 19 août 22 h Toronto — même semaine (lundi 17 août).
  await makeAppointment({ userId: carol.id, clientId: client.id, createdAt: "2026-08-20T02:00:00.000Z" });
  // Hors période.
  await makeAppointment({ userId: alice.id, clientId: client.id, createdAt: "2026-08-13T20:00:00.000Z" });

  await makeClient({ fullName: "Lead 1", phone: "+14185551111", assignedToId: alice.id, createdAt: FROM_UTC });
  await makeClient({ fullName: "Lead 2", phone: "+14185552222", assignedToId: alice.id, createdAt: new Date("2026-08-19T18:00:00.000Z") });
  await makeClient({ fullName: "Lead 3", phone: "+14185553333", assignedToId: bob.id, createdAt: new Date("2026-08-20T12:00:00.000Z") });
  await makeClient({ fullName: "Lead hors période", phone: "+14185554444", assignedToId: alice.id, createdAt: new Date("2026-08-13T20:00:00.000Z") });

  return { alice: alice.id, bob: bob.id, carol: carol.id, dave: dave.id, client: client.id };
}

// ── Bornes de période (Toronto, pas UTC) ─────────────────────────────────────

describe("resolvePeriod — bornes en America/Toronto", () => {
  it("résout la période « 7 j » sur les jours Toronto", () => {
    expect(todayStr()).toBe("2026-08-20");
    const p = resolvePeriod({ period: "7" });
    expect(p).toMatchObject({ preset: "7", fromStr: "2026-08-14", toStr: "2026-08-20", dayCount: 7 });
    // 00:00 Toronto (EDT = UTC−4) le 14, exclusif à 00:00 Toronto le 21.
    expect(p.fromUtc.toISOString()).toBe("2026-08-14T04:00:00.000Z");
    expect(p.toUtcExclusive.toISOString()).toBe("2026-08-21T04:00:00.000Z");
  });

  it("utilise 30 jours par défaut et accepte 90", () => {
    expect(resolvePeriod({})).toMatchObject({ preset: "30", fromStr: "2026-07-22", toStr: "2026-08-20" });
    expect(resolvePeriod({ period: "bidon" })).toMatchObject({ preset: "30" });
    expect(resolvePeriod({ period: "90" })).toMatchObject({ preset: "90", fromStr: "2026-05-23" });
  });

  it("remet une plage personnalisée à l'endroit et la borne à 2 ans", () => {
    const swapped = resolvePeriod({ period: "custom", from: "2026-08-20", to: "2026-08-01" });
    expect(swapped).toMatchObject({ fromStr: "2026-08-01", toStr: "2026-08-20", dayCount: 20 });

    const huge = resolvePeriod({ period: "custom", from: "2000-01-01", to: "2026-08-20" });
    expect(huge.dayCount).toBe(731);
    expect(huge.fromStr).toBe("2024-08-20");
    expect(huge.toStr).toBe("2026-08-20");
  });

  it("gère le passage à l'heure avancée (8 mars 2026)", () => {
    // 7 mars : EST (UTC−5) ; 9 mars : EDT (UTC−4).
    const p = resolvePeriod({ period: "custom", from: "2026-03-07", to: "2026-03-08" });
    expect(p.fromUtc.toISOString()).toBe("2026-03-07T05:00:00.000Z");
    expect(p.toUtcExclusive.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(dayStartUtc("2026-03-08").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(dayStartUtc("2026-03-09").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("énumère les jours d'une période, changement de mois inclus", () => {
    expect(listDays("2026-07-30", "2026-08-02")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(shiftDateStr("2026-03-08", -1)).toBe("2026-03-07");
  });
});

describe("filtrage de période — inclusion/exclusion exactes aux bornes Toronto", () => {
  it("inclut [00:00 Toronto du 1er jour, 00:00 Toronto du lendemain du dernier)", async () => {
    const user = await makeUser({ name: "Borne", email: "borne@nexus.test" });
    const cases: { at: string; included: boolean; why: string }[] = [
      { at: "2026-08-14T03:59:59.999Z", included: false, why: "13 août 23:59:59.999 Toronto" },
      { at: "2026-08-14T04:00:00.000Z", included: true, why: "14 août 00:00:00 Toronto (borne basse)" },
      { at: "2026-08-14T00:30:00.000Z", included: false, why: "date UTC = 14 août mais 13 août 20:30 Toronto" },
      { at: "2026-08-21T02:00:00.000Z", included: true, why: "date UTC = 21 août mais 20 août 22:00 Toronto" },
      { at: "2026-08-21T03:59:59.999Z", included: true, why: "20 août 23:59:59.999 Toronto" },
      { at: "2026-08-21T04:00:00.000Z", included: false, why: "21 août 00:00 Toronto (borne haute exclusive)" },
    ];
    for (const c of cases) {
      await makeCall({ userId: user.id, startedAt: c.at, answered: true, durationSec: 10 });
    }

    const kpis = await getKpis(PERIOD);
    expect(kpis.totalCalls).toBe(cases.filter((c) => c.included).length);
    expect(kpis.totalCalls).toBe(3);
    // Une agrégation en UTC donnerait 4 (03:59:59.999Z du 14 exclu mais 00:30Z inclus).
    expect(kpis.totalSec).toBe(30);
  });

  it("applique les mêmes bornes aux RDV et aux leads", async () => {
    const user = await makeUser({ name: "Borne2", email: "borne2@nexus.test" });
    const client = await makeClient({
      fullName: "C",
      phone: "+14185559999",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await makeAppointment({ userId: user.id, clientId: client.id, createdAt: "2026-08-14T03:59:59.999Z" });
    await makeAppointment({ userId: user.id, clientId: client.id, createdAt: "2026-08-14T04:00:00.000Z" });
    await makeAppointment({ userId: user.id, clientId: client.id, createdAt: "2026-08-21T04:00:00.000Z" });
    await makeClient({ fullName: "L in", phone: "+14185558881", createdAt: new Date("2026-08-21T03:59:59.999Z") });
    await makeClient({ fullName: "L out", phone: "+14185558882", createdAt: new Date("2026-08-21T04:00:00.000Z") });

    const kpis = await getKpis(PERIOD);
    expect(kpis.appointments).toBe(1);
    expect(kpis.leads).toBe(1);
  });
});

// ── KPI ──────────────────────────────────────────────────────────────────────

describe("getKpis", () => {
  let core: Core;
  beforeEach(async () => {
    core = await seedCore();
  });

  it("agrège appels, connectés, minutes, RDV et leads sur la période", async () => {
    const kpis = await getKpis(PERIOD);
    expect(kpis).toEqual({
      totalCalls: 7,
      connectedCalls: 4,
      totalSec: 525,
      answeredSec: 510,
      appointments: 4,
      leads: 3,
    });
    for (const value of Object.values(kpis)) expect(Number.isFinite(value)).toBe(true);
    // Taux de connexion affiché = round(4/7*100) = 57 %.
    expect(Math.round((kpis.connectedCalls / kpis.totalCalls) * 100)).toBe(57);
  });

  it("calcule la durée moyenne sur les appels CONNECTÉS uniquement", async () => {
    const kpis = await getKpis(PERIOD);
    // 510 s répartis sur 4 appels connectés = 127,5 s.
    expect(kpis.answeredSec / kpis.connectedCalls).toBe(127.5);
    // …et non 525/7 = 75 s si on prenait tous les appels.
    expect(kpis.totalSec / kpis.totalCalls).toBe(75);
    // Les appels non connectés ont bien du temps de sonnerie compté dans totalSec.
    expect(kpis.totalSec - kpis.answeredSec).toBe(15);
  });

  it("compte les RDV PRIS, y compris ceux annulés ensuite (comportement actuel)", async () => {
    const cancelled = await makeAppointment({
      userId: core.bob,
      clientId: core.client,
      createdAt: "2026-08-19T19:00:00.000Z",
    });
    await testDb
      .update(appointments)
      .set({ status: "cancelled" })
      .where(eq(appointments.id, cancelled.id));

    expect((await getKpis(PERIOD)).appointments).toBe(5);
    expect((await getUserStats(PERIOD)).find((r) => r.userId === core.bob)!.rdv).toBe(1);
  });

  it("filtre par téléphoniste (appels, RDV et leads assignés)", async () => {
    const alice = await getKpis({ ...PERIOD, userId: core.alice });
    expect(alice).toEqual({
      totalCalls: 4,
      connectedCalls: 2,
      totalSec: 435,
      answeredSec: 420,
      appointments: 2,
      leads: 2,
    });

    const carol = await getKpis({ ...PERIOD, userId: core.carol });
    expect(carol).toEqual({
      totalCalls: 0,
      connectedCalls: 0,
      totalSec: 0,
      answeredSec: 0,
      appointments: 2,
      leads: 0,
    });

    const dave = await getKpis({ ...PERIOD, userId: core.dave });
    expect(dave).toEqual({
      totalCalls: 0,
      connectedCalls: 0,
      totalSec: 0,
      answeredSec: 0,
      appointments: 0,
      leads: 0,
    });
    // Aucun NaN / undefined même sans aucune ligne.
    for (const value of Object.values(dave)) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

// ── Séries temporelles ───────────────────────────────────────────────────────

describe("séries temporelles", () => {
  it("regroupe les appels par jour Toronto (pas UTC)", async () => {
    const user = await makeUser({ name: "TZ", email: "tz@nexus.test" });
    // 18 août 23:00 Toronto — date UTC = 19 août.
    await makeCall({ userId: user.id, startedAt: "2026-08-19T03:00:00.000Z", answered: true, durationSec: 10 });
    // 19 août 00:30 Toronto — date UTC = 19 août également.
    await makeCall({ userId: user.id, startedAt: "2026-08-19T04:30:00.000Z", answered: false, durationSec: 0 });

    expect(await getCallsPerDay(PERIOD)).toEqual([
      { day: "2026-08-18", answered: 1, missed: 0 },
      { day: "2026-08-19", answered: 0, missed: 1 },
    ]);
  });

  it("compte connectés / non connectés par jour sur le jeu principal", async () => {
    await seedCore();
    expect(await getCallsPerDay(PERIOD)).toEqual([
      { day: "2026-08-18", answered: 2, missed: 1 },
      { day: "2026-08-19", answered: 2, missed: 2 },
    ]);
  });

  it("regroupe les RDV par semaine (lundi, Toronto)", async () => {
    await seedCore();
    expect(await getBookingsPerWeek(PERIOD)).toEqual([{ weekStart: "2026-08-17", count: 4 }]);
  });

  it("répartit les dispositions et ignore les appels sans disposition", async () => {
    await seedCore();
    const rows = await getDispositionBreakdown(PERIOD);
    expect(rows[0]).toEqual({ disposition: "booked", count: 2 });
    expect(Object.fromEntries(rows.map((r) => [r.disposition, r.count]))).toEqual({
      booked: 2,
      callback: 1,
      no_answer: 1,
      voicemail: 1,
      not_interested: 1,
    });
    // 7 appels dans la période, 1 sans disposition.
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(6);
  });
});

// ── Tableau par téléphoniste ─────────────────────────────────────────────────

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

function renderStatsTable(rows: Awaited<ReturnType<typeof getUserStats>>): string[] {
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { analytics: analyticsFr } as unknown as IntlMessages,
      children: createElement(UserStatsTable, { rows }),
    }),
  );
  // Le composant rend aussi des cartes (mobile) : on ne garde que le <table>.
  return html
    .split("</table>")[0]
    .split("</tr>")
    .map((chunk) => chunk.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|").trim())
    .filter((line) => line.length > 1);
}

describe("getUserStats + rendu du tableau", () => {
  let core: Core;
  beforeEach(async () => {
    core = await seedCore();
  });

  it("produit une ligne par téléphoniste actif sur la période", async () => {
    const rows = await getUserStats(PERIOD);
    const byId = new Map(rows.map((r) => [r.userId, r]));

    expect(byId.get(core.alice)).toEqual({
      userId: core.alice,
      name: "Alice Roy",
      calls: 4,
      connected: 2,
      totalSec: 435,
      answeredSec: 420,
      rdv: 2,
    });
    expect(byId.get(core.bob)).toEqual({
      userId: core.bob,
      name: "Bob Gagnon",
      calls: 3,
      connected: 2,
      totalSec: 90,
      answeredSec: 90,
      rdv: 0,
    });
    // Aucun appel mais 2 RDV : la ligne existe avec des zéros numériques.
    expect(byId.get(core.carol)).toEqual({
      userId: core.carol,
      name: "Carol Nadeau",
      calls: 0,
      connected: 0,
      totalSec: 0,
      answeredSec: 0,
      rdv: 2,
    });
    // Aucune activité : absent du tableau.
    expect(byId.has(core.dave)).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("un téléphoniste sans appel affiche 0 partout (jamais NaN), RDV/100 compris", async () => {
    const rows = await getUserStats(PERIOD);
    const carol = rows.find((r) => r.userId === core.carol)!;
    for (const key of ["calls", "connected", "totalSec", "answeredSec", "rdv"] as const) {
      expect(typeof carol[key]).toBe("number");
      expect(Number.isFinite(carol[key])).toBe(true);
    }

    const lines = renderStatsTable(rows);
    const carolLine = lines.find((l) => l.includes("Carol Nadeau"))!;
    // Téléphoniste | Appels | % connectés | Minutes | Durée moy. | RDV | RDV/100
    expect(carolLine).toBe("|Carol Nadeau|0|0 %|0|0:00|2|0.0|");
    expect(lines.join("\n")).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("calcule correctement chaque métrique dérivée et le total", async () => {
    const lines = renderStatsTable(await getUserStats(PERIOD));
    expect(lines).toEqual([
      "|Téléphoniste|Appels|% connectés|Minutes|Durée moy.|RDV|RDV / 100 appels|",
      // 4 appels · 2/4 = 50 % · 435 s ≈ 7 min · 420/2 = 3:30 · 2 RDV · 2/4 = 50,0
      "|Alice Roy|4|50 %|7|3:30|2|50.0|",
      // 3 appels · 2/3 = 67 % · 90 s ≈ 2 min · 90/2 = 0:45 · 0 RDV · 0,0
      "|Bob Gagnon|3|67 %|2|0:45|0|0.0|",
      "|Carol Nadeau|0|0 %|0|0:00|2|0.0|",
      // Totaux : 7 appels · 4/7 = 57 % · 525 s ≈ 9 min · 510/4 = 2:08 · 4 RDV · 4/7 = 57,1
      "|Total|7|57 %|9|2:08|4|57.1|",
    ]);
  });

  it("liste tous les utilisateurs pour le filtre, triés par nom", async () => {
    expect((await getUserOptions()).map((u) => u.name)).toEqual([
      "Alice Roy",
      "Bob Gagnon",
      "Carol Nadeau",
      "Dave Lemieux",
    ]);
  });
});

// ── Cron : rappels de suivi ──────────────────────────────────────────────────

function cronRequest(path: string, secret: string | null = "test-cron-secret") {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("GET /api/cron/followup-reminders", () => {
  it("refuse sans secret ou avec un mauvais secret", async () => {
    expect((await followupCron(cronRequest("/api/cron/followup-reminders", null))).status).toBe(401);
    expect((await followupCron(cronRequest("/api/cron/followup-reminders", "mauvais"))).status).toBe(401);
    expect(await testDb.select().from(notifications)).toHaveLength(0);
  });

  it("notifie l'assigné d'un suivi dû ou en retard, et ignore le reste", async () => {
    const alice = await makeUser({ name: "Alice", email: "a@nexus.test", locale: "fr" });
    const bob = await makeUser({ name: "Bob", email: "b@nexus.test", locale: "en" });
    const inactive = await makeUser({ name: "Zoé", email: "z@nexus.test", isActive: false });
    const client = await makeClient({ fullName: "Jean Bouchard", phone: "+14185550001" });

    const rows = [
      { assignedToId: alice.id, dueAt: "2026-08-20T13:30:00.000Z", note: "Rappeler pour l'offre" }, // dans 30 min
      { assignedToId: bob.id, dueAt: "2026-08-20T11:00:00.000Z", note: "En retard de 2 h" },
      { assignedToId: alice.id, dueAt: "2026-08-20T16:00:00.000Z", note: "Dans 3 h — hors fenêtre" },
      { assignedToId: alice.id, dueAt: "2026-08-19T06:00:00.000Z", note: "En retard de 31 h" },
      { assignedToId: inactive.id, dueAt: "2026-08-20T13:10:00.000Z", note: "Assigné inactif" },
    ];
    for (const r of rows) {
      await testDb.insert(followups).values({
        clientId: client.id,
        assignedToId: r.assignedToId,
        dueAt: new Date(r.dueAt),
        note: r.note,
      });
    }
    // Suivi déjà complété, pourtant dans la fenêtre.
    await testDb.insert(followups).values({
      clientId: client.id,
      assignedToId: alice.id,
      dueAt: new Date("2026-08-20T13:15:00.000Z"),
      note: "Déjà fait",
      doneAt: new Date("2026-08-20T12:00:00.000Z"),
    });

    const res = await followupCron(cronRequest("/api/cron/followup-reminders"));
    expect(res.status).toBe(200);
    // Balayés : les 3 suivis ouverts dans la fenêtre (dont l'assigné inactif).
    expect(await res.json()).toEqual({ scanned: 3, created: 2 });

    const notifs = await testDb.select().from(notifications);
    expect(notifs).toHaveLength(2);
    const byUser = new Map(notifs.map((n) => [n.userId, n]));

    const aliceNotif = byUser.get(alice.id)!;
    expect(aliceNotif.type).toBe("followup_due");
    expect(aliceNotif.title).toBe("Suivi à faire : Jean Bouchard");
    expect(aliceNotif.body).toBe("Rappeler pour l'offre");
    expect(aliceNotif.link).toBe(`/clients/${client.id}`);
    expect(aliceNotif.readAt).toBeNull();

    // Le titre suit la langue du DESTINATAIRE, pas celle de l'app.
    expect(byUser.get(bob.id)!.title).toBe("Follow-up due: Jean Bouchard");
    expect(byUser.has(inactive.id)).toBe(false);
  });

  it("ne duplique pas au second passage (dédoublonnage sur les non-lues)", async () => {
    const alice = await makeUser({ name: "Alice", email: "a@nexus.test" });
    const client = await makeClient({ fullName: "Jean Bouchard", phone: "+14185550001" });
    await testDb.insert(followups).values({
      clientId: client.id,
      assignedToId: alice.id,
      dueAt: new Date("2026-08-20T13:30:00.000Z"),
      note: "Rappeler",
    });

    const first = await (await followupCron(cronRequest("/api/cron/followup-reminders"))).json();
    expect(first).toEqual({ scanned: 1, created: 1 });

    const second = await (await followupCron(cronRequest("/api/cron/followup-reminders"))).json();
    expect(second).toEqual({ scanned: 1, created: 0 });
    expect(await testDb.select().from(notifications)).toHaveLength(1);

    // Une fois la notification lue, le rappel suivant en recrée une (comportement documenté).
    await testDb.update(notifications).set({ readAt: new Date() });
    const third = await (await followupCron(cronRequest("/api/cron/followup-reminders"))).json();
    expect(third).toEqual({ scanned: 1, created: 1 });
    expect(await testDb.select().from(notifications)).toHaveLength(2);
  });

  it("ne notifie jamais un suivi complété", async () => {
    const alice = await makeUser({ name: "Alice", email: "a@nexus.test" });
    const client = await makeClient({ fullName: "Jean", phone: "+14185550002" });
    await testDb.insert(followups).values({
      clientId: client.id,
      assignedToId: alice.id,
      dueAt: new Date("2026-08-20T12:00:00.000Z"),
      note: "Fait",
      doneAt: new Date("2026-08-20T12:30:00.000Z"),
    });

    expect(await (await followupCron(cronRequest("/api/cron/followup-reminders"))).json()).toEqual({
      scanned: 0,
      created: 0,
    });
    expect(await testDb.select().from(notifications)).toHaveLength(0);
  });
});

// ── Cron : synchronisation CDR voip.ms ───────────────────────────────────────

type FakeCdr = Record<string, unknown>;

const voip = {
  cdr: [] as FakeCdr[],
  cdrStatus: "success",
  recordings: [] as FakeCdr[],
  recordingsStatus: "success",
  cdrFails: false,
  requests: [] as URL[],
};

function stubVoipms() {
  voip.requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      voip.requests.push(url);
      const method = url.searchParams.get("method");
      if (method === "getCDR") {
        if (voip.cdrFails) throw new TypeError("fetch failed (voip.ms injoignable)");
        return new Response(JSON.stringify({ status: voip.cdrStatus, cdr: voip.cdr }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "getCallRecordings") {
        return new Response(
          JSON.stringify({ status: voip.recordingsStatus, call_recordings: voip.recordings }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`méthode voip.ms inattendue : ${method}`);
    }),
  );
}

type CdrFixture = { alice: string; bob: string; client: string; e1: string; e2: string; e3: string };

/** CDR de référence (fuseau voip.ms fixe −05:00). */
function baseCdr(): FakeCdr[] {
  return [
    { uniqueid: "uid-1", account: "nexus_alice", date: "2026-08-19 10:00:00", callerid: "14180001111", destination: "15145550000", disposition: "ANSWERED", seconds: "95", duration: "0:01:35", description: "" },
    { uniqueid: "uid-2", account: "nexus_alice", date: "2026-08-19 11:00:00", callerid: "14180001111", destination: "14185551234", disposition: "ANSWERED", seconds: "42", duration: "0:00:42", description: "" },
    { uniqueid: "uid-3", account: "nexus_bob", date: "2026-08-19 12:00:00", callerid: "14180002222", destination: "14189998888", disposition: "NO ANSWER", seconds: "0", duration: "0:00:00", description: "" },
    { uniqueid: "uid-4", account: "nexus_bob", date: "2026-08-19 13:00:00", callerid: "14181234567", destination: "14180002222", disposition: "ANSWERED", seconds: "180", duration: "0:03:00", description: "" },
    { uniqueid: "uid-5", account: "nexus_fantome", date: "2026-08-19 13:30:00", callerid: "1", destination: "2", disposition: "ANSWERED", seconds: "5" },
    {},
    { uniqueid: "uid-7", account: "nexus_alice", date: "pas-une-date", callerid: "x", destination: "y", disposition: "ANSWERED", seconds: "12" },
    { uniqueid: "uid-8", account: "nexus_alice", date: "2026-08-19 14:00:00", callerid: null, destination: null, disposition: undefined, seconds: "abc" },
  ];
}

async function seedCdrFixture(): Promise<CdrFixture> {
  await seedSystemCategories();
  const alice = await makeUser({
    name: "Alice", email: "alice@nexus.test", sipUsername: "nexus_alice", didNumber: "+14180001111",
  });
  const bob = await makeUser({
    name: "Bob", email: "bob@nexus.test", sipUsername: "nexus_bob", didNumber: "+14180002222",
  });
  await makeUser({ name: "Sans SIP", email: "nosip@nexus.test" });
  const client = await makeClient({
    fullName: "Client Sortant",
    phone: "+14189998888",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  });

  const e1 = await makeCall({
    userId: alice.id, startedAt: "2026-08-19T15:00:00.000Z", answered: false, durationSec: 0,
    providerCallId: "uid-1", fromNumber: "+14180001111", toNumber: "+15145550000",
  });
  const e2 = await makeCall({
    userId: alice.id, startedAt: "2026-08-19T16:01:00.000Z", answered: false, durationSec: 0,
    fromNumber: "+14180001111", toNumber: "+14185551234",
  });
  const e3 = await makeCall({
    userId: bob.id, startedAt: "2026-08-19T20:00:00.000Z", answered: false, durationSec: 7,
    fromNumber: "+14180002222", toNumber: "+15819990000",
  });

  return { alice: alice.id, bob: bob.id, client: client.id, e1: e1.id, e2: e2.id, e3: e3.id };
}

async function runSync() {
  const res = await syncCdrCron(cronRequest("/api/cron/sync-cdr"));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    ok: boolean;
    range: { from: string; to: string };
    cdrRows: number;
    matchedByProviderId: number;
    matchedHeuristic: number;
    inserted: number;
    unknownAccount: number;
    recordingsAttached: number;
    errors: string[];
  };
}

describe("GET /api/cron/sync-cdr", () => {
  beforeEach(() => {
    voip.cdr = baseCdr();
    voip.cdrStatus = "success";
    voip.recordings = [];
    voip.recordingsStatus = "success";
    voip.cdrFails = false;
    stubVoipms();
  });

  it("refuse sans secret", async () => {
    const res = await syncCdrCron(cronRequest("/api/cron/sync-cdr", null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("demande les CDR d'hier et d'aujourd'hui (dates Toronto, fuseau −5)", async () => {
    await seedCdrFixture();
    const out = await runSync();
    expect(out.range).toEqual({ from: "2026-08-19", to: "2026-08-20" });

    const cdrReq = voip.requests.find((u) => u.searchParams.get("method") === "getCDR")!;
    expect(cdrReq.searchParams.get("date_from")).toBe("2026-08-19");
    expect(cdrReq.searchParams.get("date_to")).toBe("2026-08-20");
    expect(cdrReq.searchParams.get("timezone")).toBe("-5");
  });

  it("rattache un CDR à l'appel existant par uniqueid", async () => {
    const f = await seedCdrFixture();
    const out = await runSync();
    expect(out.matchedByProviderId).toBe(1);

    const [call] = await testDb.select().from(calls).where(eq(calls.id, f.e1));
    expect(call.durationSec).toBe(95);
    expect(call.answeredAt?.toISOString()).toBe("2026-08-19T15:00:00.000Z");
    expect(call.providerCallId).toBe("uid-1");
  });

  it("rattache un CDR par proximité utilisateur + heure + numéro", async () => {
    const f = await seedCdrFixture();
    const out = await runSync();
    expect(out.matchedHeuristic).toBe(1);

    const [call] = await testDb.select().from(calls).where(eq(calls.id, f.e2));
    expect(call.providerCallId).toBe("uid-2");
    expect(call.durationSec).toBe(42);
    expect(call.answeredAt?.toISOString()).toBe("2026-08-19T16:00:00.000Z");

    // L'appel sans CDR correspondant reste intact.
    const [untouched] = await testDb.select().from(calls).where(eq(calls.id, f.e3));
    expect(untouched.providerCallId).toBeNull();
    expect(untouched.durationSec).toBe(7);
    expect(untouched.answeredAt).toBeNull();
  });

  it("insère les CDR inconnus d'un sous-compte SIP connu, avec direction et client", async () => {
    const f = await seedCdrFixture();
    const out = await runSync();
    expect(out.inserted).toBe(3);
    expect(out.unknownAccount).toBe(1);

    const rows = await testDb.select().from(calls);
    const byUid = new Map(rows.map((r) => [r.providerCallId, r]));

    // Sortant : la destination n'est pas le DID de Bob ; client retrouvé par numéro.
    const outbound = byUid.get("uid-3")!;
    expect(outbound.userId).toBe(f.bob);
    expect(outbound.direction).toBe("outbound");
    expect(outbound.fromNumber).toBe("+14180002222");
    expect(outbound.toNumber).toBe("+14189998888");
    expect(outbound.clientId).toBe(f.client);
    expect(outbound.startedAt.toISOString()).toBe("2026-08-19T17:00:00.000Z");
    expect(outbound.answeredAt).toBeNull();
    expect(outbound.durationSec).toBe(0);
    expect(outbound.provider).toBe("voipms");

    // Entrant : la destination est le DID de Bob.
    const inbound = byUid.get("uid-4")!;
    expect(inbound.direction).toBe("inbound");
    expect(inbound.fromNumber).toBe("+14181234567");
    expect(inbound.answeredAt?.toISOString()).toBe("2026-08-19T18:00:00.000Z");
    expect(inbound.durationSec).toBe(180);
    expect(inbound.endedAt?.toISOString()).toBe("2026-08-19T18:03:00.000Z");
    expect(inbound.clientId).toBeNull();

    // Compte SIP inconnu : aucune ligne.
    expect(byUid.has("uid-5")).toBe(false);
  });

  it("ne plante pas sur des CDR partiels ou invalides", async () => {
    await seedCdrFixture();
    const out = await runSync();

    expect(out.cdrRows).toBe(8);
    // Ligne sans uniqueid : ignorée silencieusement ; date invalide : erreur collectée.
    expect(out.errors).toEqual(['cdr uid-7: date invalide "pas-une-date"']);
    expect(out.ok).toBe(false);

    const rows = await testDb.select().from(calls);
    const garbage = rows.find((r) => r.providerCallId === "uid-8")!;
    expect(garbage.durationSec).toBe(0);
    expect(garbage.answeredAt).toBeNull();
    expect(garbage.fromNumber).toBeNull();
    expect(garbage.toNumber).toBeNull();
    expect(garbage.clientId).toBeNull();
    expect(rows.some((r) => r.providerCallId === "uid-7")).toBe(false);
  });

  it("est idempotent : deux passages ne créent aucun doublon", async () => {
    await seedCdrFixture();
    const first = await runSync();
    expect(first.inserted).toBe(3);
    const afterFirst = await testDb.select().from(calls);
    expect(afterFirst).toHaveLength(6);

    const second = await runSync();
    expect(second.inserted).toBe(0);
    expect(second.matchedHeuristic).toBe(0);
    expect(second.matchedByProviderId).toBe(5);

    const afterSecond = await testDb.select().from(calls);
    expect(afterSecond).toHaveLength(6);
    expect(new Set(afterSecond.map((r) => r.providerCallId).filter(Boolean))).toEqual(
      new Set(["uid-1", "uid-2", "uid-3", "uid-4", "uid-8"]),
    );
    // e3 n'a aucun CDR correspondant : il reste sans providerCallId, sans doublon.
    expect(afterSecond.filter((r) => r.providerCallId === null)).toHaveLength(1);
    // Les valeurs déjà réconciliées ne bougent plus.
    expect(afterSecond.map((r) => r.durationSec).sort((a, b) => a - b)).toEqual([0, 0, 7, 42, 95, 180]);
  });

  it("attache les enregistrements par uniqueid, puis par repli textuel", async () => {
    const f = await seedCdrFixture();
    voip.recordings = [
      { id: "r1", uniqueid: "uid-1", url: "https://voip.ms/rec/r1.wav", date: "2026-08-19 10:00:00" },
      { id: "r2", callrecording: "enregistrement-uid-4-final", url: "https://voip.ms/rec/r2.wav" },
      { id: "r3", url: "" },
    ];

    const out = await runSync();
    expect(out.recordingsAttached).toBe(2);

    const [e1] = await testDb.select().from(calls).where(eq(calls.id, f.e1));
    expect(e1.recordingUrl).toBe("https://voip.ms/rec/r1.wav");
    const rows = await testDb.select().from(calls);
    expect(rows.find((r) => r.providerCallId === "uid-4")!.recordingUrl).toBe(
      "https://voip.ms/rec/r2.wav",
    );

    // Second passage : rien à réattacher.
    expect((await runSync()).recordingsAttached).toBe(0);
  });

  it("tolère l'échec des enregistrements sans perdre la réconciliation CDR", async () => {
    const f = await seedCdrFixture();
    voip.recordingsStatus = "invalid_method";

    const out = await runSync();
    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => e.startsWith("getCallRecordings:"))).toBe(true);
    expect(out.matchedByProviderId).toBe(1);
    expect(out.inserted).toBe(3);

    const [call] = await testDb.select().from(calls).where(eq(calls.id, f.e1));
    expect(call.durationSec).toBe(95);
  });

  it("tolère voip.ms injoignable : aucun changement, erreur rapportée", async () => {
    const f = await seedCdrFixture();
    voip.cdrFails = true;

    const out = await runSync();
    expect(out.cdrRows).toBe(0);
    expect(out.inserted).toBe(0);
    expect(out.errors.some((e) => e.startsWith("getCdr:"))).toBe(true);

    expect(await testDb.select().from(calls)).toHaveLength(3);
    const [call] = await testDb.select().from(calls).where(eq(calls.id, f.e1));
    expect(call.durationSec).toBe(0);
  });

  it("journalise le passage du cron dans l'audit", async () => {
    await seedCdrFixture();
    await runSync();

    const logs = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "cron.sync_cdr"));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBeNull();
    expect(logs[0].entity).toBe("calls");
    expect(logs[0].detail).toMatchObject({
      range: { from: "2026-08-19", to: "2026-08-20" },
      counts: { matchedByProviderId: 1, matchedHeuristic: 1, inserted: 3, unknownAccount: 1 },
    });
  });
});
