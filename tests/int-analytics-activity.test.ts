/**
 * Tests d'intégration — le graphique « Activité » de l'analytique.
 *
 * Couvre :
 *   src/app/(app)/admin/analytics/queries.ts  (getActivityBuckets)
 *   src/components/analytics/activity.ts       (maille, bascule du profil)
 *   src/components/analytics/period.ts         (axes semaine / heure)
 *
 * Pourquoi contre un VRAI Postgres : `getActivityBuckets` est la seule requête
 * de la page écrite en SQL brut — les noms de tables et de colonnes y sont des
 * chaînes, qu'aucun compilateur ne relit. Un renommage dans `schema.ts` ne se
 * verrait qu'ici. Et c'est aussi ici que se vérifient les deux pièges du SQL
 * écrit à la main : un `Date` interpolé sans conversion (la requête ne part
 * jamais) et un `::int` que le pilote rend en texte (« 2 » + 1 = « 21 »).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getActivityBuckets, type AnalyticsFilter } from "@/app/(app)/admin/analytics/queries";
import {
  ACTIVITY_FORMS,
  ACTIVITY_KINDS,
  formHasTimeAxis,
  isHourProfile,
  movingAverage,
  resolveForm,
  resolveGrain,
  trendWindow,
  type ActivityKind,
} from "@/components/analytics/activity";
import {
  listHourProfile,
  listHours,
  listWeekStarts,
  mondayOf,
} from "@/components/analytics/period";
import {
  appointments,
  auditLogs,
  calls,
  clients,
  comments,
  followups,
} from "@/db/schema";
import { messages } from "@/db/schema-sms";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  makeUser,
  resetDb,
  testDb,
} from "./helpers/db";

/** Période : 17 → 23 août 2026 inclus (Toronto, EDT = UTC−4). */
const FROM_UTC = new Date("2026-08-17T04:00:00.000Z");
const TO_UTC_EXCL = new Date("2026-08-24T04:00:00.000Z");
const PERIOD: AnalyticsFilter = { fromUtc: FROM_UTC, toUtcExclusive: TO_UTC_EXCL };

/** Mardi 18 août, 14 h 00 Toronto. */
const TUE_14H = "2026-08-18T18:00:00.000Z";
/** Mardi 18 août, 20 h 30 Toronto. */
const TUE_20H30 = "2026-08-19T00:30:00.000Z";
/** Mercredi 19 août, 09 h 00 Toronto. */
const WED_09H = "2026-08-19T13:00:00.000Z";
/** Dimanche 16 août, 14 h Toronto — HORS période, d'un jour. */
const BEFORE = "2026-08-16T18:00:00.000Z";

type Totals = Record<ActivityKind, number>;

function totals(rows: { kind: ActivityKind; count: number }[]): Totals {
  const out = Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0])) as Totals;
  for (const r of rows) out[r.kind] += r.count;
  return out;
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

/**
 * Un jeu de données où CHAQUE famille est représentée, et où chaque famille a
 * exactement une ligne hors période — la borne se vérifie cinq fois.
 */
async function seedActivity() {
  const alice = await makeUser({ name: "Alice Roy", email: "alice@nexus.test" });
  const bob = await makeUser({ name: "Bob Gagnon", email: "bob@nexus.test" });

  const client = await makeClient({
    fullName: "Client Support",
    phone: "+14185550000",
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    createdById: alice.id,
  });

  // — appels : 2 Alice (mardi 14 h, mardi 20 h 30), 1 Bob (mercredi 9 h), 1 hors
  for (const [userId, at] of [
    [alice.id, TUE_14H],
    [alice.id, TUE_20H30],
    [bob.id, WED_09H],
    [alice.id, BEFORE],
  ] as const) {
    await testDb.insert(calls).values({
      userId,
      clientId: client.id,
      direction: "outbound",
      startedAt: new Date(at),
      durationSec: 60,
      createdAt: new Date(at),
    });
  }

  // — RDV : 1 Alice dans la période, 1 hors
  for (const [userId, at] of [
    [alice.id, TUE_14H],
    [alice.id, BEFORE],
  ] as const) {
    await testDb.insert(appointments).values({
      clientId: client.id,
      userId,
      type: "meet",
      title: "RDV",
      startsAt: new Date(at),
      endsAt: new Date(new Date(at).getTime() + 30 * 60_000),
      createdAt: new Date(at),
    });
  }

  // — SMS : 1 sortant humain (Alice), 1 entrant, 1 sortant RETENU (ne compte
  //   pas), 1 hors période
  const number = await makeSmsNumber();
  const conv = await makeConversation({
    clientId: client.id,
    smsNumberId: number.id,
    assignedToId: bob.id,
  });
  await testDb.insert(messages).values([
    {
      conversationId: conv.id,
      direction: "out",
      body: "Bonjour",
      source: "human",
      sentById: alice.id,
      createdAt: new Date(TUE_14H),
    },
    {
      conversationId: conv.id,
      direction: "in",
      body: "Allo",
      source: "human",
      createdAt: new Date(WED_09H),
    },
    {
      conversationId: conv.id,
      direction: "out",
      body: "Jamais parti",
      source: "agent",
      skipReason: "kill_switch",
      createdAt: new Date(WED_09H),
    },
    {
      conversationId: conv.id,
      direction: "out",
      body: "Hors période",
      source: "human",
      sentById: alice.id,
      createdAt: new Date(BEFORE),
    },
  ]);

  // — notes : 1 commentaire (Alice) + 1 suivi (Bob) dans la période, 1 hors
  await testDb.insert(comments).values([
    { clientId: client.id, userId: alice.id, body: "Note", createdAt: new Date(TUE_14H) },
    { clientId: client.id, userId: alice.id, body: "Hors", createdAt: new Date(BEFORE) },
  ]);
  await testDb.insert(followups).values({
    clientId: client.id,
    assignedToId: bob.id,
    createdById: bob.id,
    dueAt: new Date("2026-09-01T12:00:00.000Z"),
    createdAt: new Date(WED_09H),
  });

  // — fiches : 1 créée par Bob + 1 modification auditée (Alice), 1 hors période
  await testDb.insert(clients).values({
    fullName: "Nouveau lead",
    phone: "+14185551111",
    createdById: bob.id,
    createdAt: new Date(WED_09H),
  });
  await testDb.insert(auditLogs).values([
    {
      userId: alice.id,
      action: "client.update",
      entity: "client",
      entityId: client.id,
      createdAt: new Date(TUE_14H),
    },
    // Une action auditée qui n'est PAS une modification de fiche : elle ne doit
    // jamais gonfler la famille « fiches ».
    {
      userId: alice.id,
      action: "export.csv",
      entity: "client",
      createdAt: new Date(TUE_14H),
    },
    {
      userId: alice.id,
      action: "client.update",
      entity: "client",
      entityId: client.id,
      createdAt: new Date(BEFORE),
    },
  ]);

  return { alice: alice.id, bob: bob.id };
}

describe("getActivityBuckets — les cinq familles", () => {
  it("compte chaque famille et n'admet que la période", async () => {
    await seedActivity();
    const rows = await getActivityBuckets(PERIOD, "day", false);

    expect(totals(rows)).toEqual({
      calls: 3,
      bookings: 1,
      sms: 2, // le sortant retenu est exclu
      notes: 2, // 1 commentaire + 1 suivi
      records: 2, // 1 fiche créée + 1 modification auditée
    });
  });

  it("rend des NOMBRES, pas du texte", async () => {
    await seedActivity();
    const rows = await getActivityBuckets(PERIOD, "day", false);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.count).toBe("number");
      expect(Number.isFinite(row.count)).toBe(true);
    }
  });

  it("range les gestes dans le bon JOUR de Toronto", async () => {
    await seedActivity();
    const rows = await getActivityBuckets(PERIOD, "day", false);

    const calls18 = rows.find((r) => r.kind === "calls" && r.bucket === "2026-08-18");
    const calls19 = rows.find((r) => r.kind === "calls" && r.bucket === "2026-08-19");
    // L'appel de 20 h 30 le mardi est à 00 h 30 UTC le mercredi : sans le
    // fuseau, il basculerait d'un jour.
    expect(calls18?.count).toBe(2);
    expect(calls19?.count).toBe(1);
  });

  it("range les gestes dans la bonne HEURE de Toronto", async () => {
    await seedActivity();
    const rows = await getActivityBuckets(PERIOD, "hour", false);

    expect(rows.find((r) => r.kind === "calls" && r.bucket === "2026-08-18 14")?.count).toBe(1);
    expect(rows.find((r) => r.kind === "calls" && r.bucket === "2026-08-18 20")?.count).toBe(1);
    expect(rows.find((r) => r.kind === "calls" && r.bucket === "2026-08-19 09")?.count).toBe(1);
  });

  it("cumule les 24 heures d'une journée type en mode profil", async () => {
    await seedActivity();
    const rows = await getActivityBuckets(PERIOD, "hour", true);

    // Le profil ne garde que l'heure : les deux appels de 14 h (mardi) et 9 h
    // (mercredi) tombent dans deux cases, pas dans deux jours.
    expect(rows.find((r) => r.kind === "calls" && r.bucket === "14")?.count).toBe(1);
    expect(rows.find((r) => r.kind === "calls" && r.bucket === "09")?.count).toBe(1);
    expect(rows.every((r) => /^\d{2}$/.test(r.bucket))).toBe(true);
  });

  it("regroupe la semaine sur le LUNDI", async () => {
    await seedActivity();
    const rows = await getActivityBuckets(PERIOD, "week", false);
    // 17 août 2026 est un lundi : toute la période tient dans une semaine.
    expect([...new Set(rows.map((r) => r.bucket))]).toEqual(["2026-08-17"]);
    expect(totals(rows).calls).toBe(3);
  });

  it("filtre sur QUI a posé le geste, pas sur qui détient la fiche", async () => {
    const { alice, bob } = await seedActivity();

    const ofAlice = totals(await getActivityBuckets({ ...PERIOD, userId: alice }, "day", false));
    expect(ofAlice).toEqual({
      calls: 2,
      bookings: 1,
      sms: 1, // son sortant à elle ; l'entrant revient à Bob (fil assigné)
      notes: 1, // son commentaire ; le suivi est de Bob
      records: 1, // sa modification auditée ; la fiche créée est de Bob
    });

    const ofBob = totals(await getActivityBuckets({ ...PERIOD, userId: bob }, "day", false));
    expect(ofBob).toEqual({ calls: 1, bookings: 0, sms: 1, notes: 1, records: 1 });
  });

  it("ne rend rien plutôt que de tomber sur une base vide", async () => {
    await expect(getActivityBuckets(PERIOD, "day", false)).resolves.toEqual([]);
  });

  it("ne rend que des familles connues — un renommage de table se verrait", async () => {
    await seedActivity();
    const rows = await getActivityBuckets(PERIOD, "day", false);
    for (const row of rows) {
      expect(ACTIVITY_KINDS).toContain(row.kind);
    }
    // Les cinq familles sont toutes servies : une table renommée rendrait 0.
    expect(new Set(rows.map((r) => r.kind)).size).toBe(ACTIVITY_KINDS.length);
  });
});

describe("la maille de temps", () => {
  it("retombe sur le jour devant n'importe quoi", () => {
    expect(resolveGrain(undefined)).toBe("day");
    expect(resolveGrain("mois")).toBe("day");
    expect(resolveGrain("hour")).toBe("hour");
    expect(resolveGrain("week")).toBe("week");
  });

  it("bascule « heure » sur le profil au-delà de sept jours, et pas avant", () => {
    expect(isHourProfile("hour", 7)).toBe(false);
    expect(isHourProfile("hour", 8)).toBe(true);
    // Le jour et la semaine restent des frises, quelle que soit la longueur.
    expect(isHourProfile("day", 90)).toBe(false);
    expect(isHourProfile("week", 90)).toBe(false);
  });
});

describe("les formes du graphique", () => {
  it("retombe sur la pile devant n'importe quoi", () => {
    expect(resolveForm(undefined)).toBe("stacked");
    expect(resolveForm("camembert")).toBe("stacked");
    for (const f of ACTIVITY_FORMS) expect(resolveForm(f)).toBe(f);
  });

  it("l'anneau est la SEULE forme sans axe de temps", () => {
    const sansAxe = ACTIVITY_FORMS.filter((f) => !formHasTimeAxis(f));
    expect(sansAxe).toEqual(["donut"]);
  });

  it("la fenêtre de tendance est impaire, donc centrable, et bornée", () => {
    for (const n of [0, 1, 7, 24, 30, 90, 168, 720, 2000]) {
      const w = trendWindow(n);
      expect(w % 2, `fenêtre paire pour ${n} cases`).toBe(1);
      expect(w).toBeGreaterThanOrEqual(3);
      expect(w).toBeLessThanOrEqual(25);
    }
    // Elle suit la longueur de la série, elle n'est pas figée.
    expect(trendWindow(7)).toBe(3);
    expect(trendWindow(30)).toBe(5);
    expect(trendWindow(168)).toBe(21);
  });

  it("la moyenne mobile ne plonge PAS aux deux bouts", () => {
    // Série plate : une moyenne mobile correcte reste plate d'un bout à
    // l'autre. Diviser par la largeur nominale au lieu du nombre de cases
    // réellement présentes creuserait un trou au début et à la fin — on
    // lirait une accalmie là où il n'y a qu'un bord.
    const flat = movingAverage([10, 10, 10, 10, 10, 10, 10], 5);
    expect(flat).toEqual([10, 10, 10, 10, 10, 10, 10]);
  });

  it("la moyenne mobile lisse vraiment, et garde la longueur", () => {
    const noisy = [0, 10, 0, 10, 0, 10, 0];
    const smooth = movingAverage(noisy, 3);
    expect(smooth).toHaveLength(noisy.length);
    // Le pic isolé est raboté : aucune valeur lissée n'atteint l'extrême brut.
    expect(Math.max(...smooth)).toBeLessThan(Math.max(...noisy));
    expect(Math.min(...smooth)).toBeGreaterThan(Math.min(...noisy));
    // Une fenêtre de 1 rend la série intacte.
    expect(movingAverage(noisy, 1)).toEqual(noisy);
  });

  it("supporte une série vide sans exploser", () => {
    expect(movingAverage([], 5)).toEqual([]);
  });
});

describe("les axes continus", () => {
  it("ancre la semaine sur le lundi, dimanche compris", () => {
    expect(mondayOf("2026-08-17")).toBe("2026-08-17"); // lundi
    expect(mondayOf("2026-08-23")).toBe("2026-08-17"); // dimanche → lundi d'avant
    expect(mondayOf("2026-08-24")).toBe("2026-08-24"); // lundi suivant
  });

  it("couvre les semaines de la période sans trou", () => {
    expect(listWeekStarts("2026-08-19", "2026-09-02")).toEqual([
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
    ]);
  });

  it("produit des clés d'heure au format exact de to_char", () => {
    const hours = listHours("2026-08-18", "2026-08-19");
    expect(hours).toHaveLength(48);
    expect(hours[0]).toBe("2026-08-18 00");
    expect(hours[14]).toBe("2026-08-18 14");
    expect(hours.at(-1)).toBe("2026-08-19 23");
  });

  it("donne les 24 heures du profil, zéro-préfixées", () => {
    const profile = listHourProfile();
    expect(profile).toHaveLength(24);
    expect(profile[0]).toBe("00");
    expect(profile[9]).toBe("09");
    expect(profile.at(-1)).toBe("23");
  });

  it("les clés rendues par Postgres rejoignent celles de l'axe", async () => {
    await seedActivity();
    const axis = new Set(listHours("2026-08-17", "2026-08-23"));
    const rows = await getActivityBuckets(PERIOD, "hour", false);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(axis.has(row.bucket)).toBe(true);

    const weekAxis = new Set(listWeekStarts("2026-08-17", "2026-08-23"));
    for (const row of await getActivityBuckets(PERIOD, "week", false)) {
      expect(weekAxis.has(row.bucket)).toBe(true);
    }

    const profileAxis = new Set(listHourProfile());
    for (const row of await getActivityBuckets(PERIOD, "hour", true)) {
      expect(profileAxis.has(row.bucket)).toBe(true);
    }
  });
});
