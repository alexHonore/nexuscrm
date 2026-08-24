/**
 * Disponibilités de réservation — GET /api/availability + computeAvailability.
 *
 * Cœur métier : un créneau proposé à tort = double réservation dans l'agenda
 * du courtier. On exerce le vrai handler de route et le vrai calcul de
 * créneaux ; seule la couche Google (réseau) est simulée.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { eq } from "drizzle-orm";
import { appointments } from "@/db/schema";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";

// ── Doublures (réseau externe + contexte de requête Next) ────────────────────

const H = vi.hoisted(() => {
  class GoogleNotConnectedError extends Error {
    constructor() {
      super("Google Calendar is not connected");
      this.name = "GoogleNotConnectedError";
    }
  }
  return {
    GoogleNotConnectedError,
    freeBusy: vi.fn<(min: Date, max: Date) => Promise<{ start: Date; end: Date }[]>>(),
    session: { token: null as string | null },
  };
});

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "nexus_session" && H.session.token
        ? { name, value: H.session.token }
        : undefined,
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/google", () => ({
  freeBusy: H.freeBusy,
  GoogleNotConnectedError: H.GoogleNotConnectedError,
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/availability/route";
import {
  computeAvailability,
  durationFor,
  MIN_LEAD_MIN,
  SLOT_STEP_MIN,
} from "@/app/api/availability/slots";
import { bookingSettingsSchema, setSetting, type BookingSettings } from "@/lib/settings";

// ── Outils ───────────────────────────────────────────────────────────────────

const TZ = "America/Toronto";

/** Instant UTC correspondant à une heure murale (par défaut America/Toronto). */
const at = (local: string, tz: string = TZ) => fromZonedTime(local, tz);

/** Étiquette murale d'un créneau, dans le fuseau demandé. */
const label = (iso: string, tz: string = TZ) => formatInTimeZone(new Date(iso), tz, "HH:mm");
const labels = (slots: string[], tz: string = TZ) => slots.map((s) => label(s, tz));
/** Décalage UTC affiché ("-04:00" en EDT, "-05:00" en EST). */
const offset = (iso: string, tz: string = TZ) => formatInTimeZone(new Date(iso), tz, "XXX");

async function setBooking(overrides: Partial<BookingSettings> = {}): Promise<void> {
  await setSetting("booking", bookingSettingsSchema.parse(overrides));
}

async function loginAs(role: "admin" | "caller" = "caller") {
  const user = await makeUser({ role });
  H.session.token = await new SignJWT({
    uid: user.id,
    role: user.role,
    tv: user.tokenVersion,
    remember: false,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(4_102_444_800) // 2100-01-01, insensible à l'horloge simulée
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  return user;
}

async function call(date: string, type?: string) {
  const qs = new URLSearchParams({ date, ...(type !== undefined ? { type } : {}) });
  const res = await GET(new NextRequest(`http://localhost:3000/api/availability?${qs}`));
  return { status: res.status, body: await res.json() };
}

/** Créneaux (ISO) via le handler de route, en échouant si la route ne répond pas 200. */
async function slotsOf(date: string, type?: string): Promise<string[]> {
  const { status, body } = await call(date, type);
  expect(status, JSON.stringify(body)).toBe(200);
  return body.slots as string[];
}

function now(iso: string) {
  vi.setSystemTime(new Date(iso));
}

async function makeAppointment(over: {
  start: Date;
  end: Date;
  status?: "scheduled" | "cancelled" | "completed" | "noshow";
  type?: "meet" | "inperson";
}) {
  const user = await makeUser();
  const client = await makeClient();
  const [row] = await testDb
    .insert(appointments)
    .values({
      clientId: client.id,
      userId: user.id,
      type: over.type ?? "meet",
      title: "RDV test",
      startsAt: over.start,
      endsAt: over.end,
      status: over.status ?? "scheduled",
    })
    .returning();
  return row;
}

// ── Cycle de vie ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  await resetDb();
  H.session.token = null;
  H.freeBusy.mockReset();
  H.freeBusy.mockResolvedValue([]);
  // Seule Date est simulée : les minuteries de postgres.js restent réelles.
  vi.useFakeTimers({ toFake: ["Date"] });
  now("2026-08-09T12:00:00Z"); // dimanche, la veille des journées testées
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(closeDb);

// ═══════════════════════════════════════════════════════════════════════════
// Garde d'accès et validation d'entrée
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/availability — accès et validation", () => {
  it("répond 401 sans session", async () => {
    await setBooking();
    const { status, body } = await call("2026-08-10");
    expect(status).toBe(401);
    expect(body).toEqual({ error: "unauthenticated" });
    expect(H.freeBusy).not.toHaveBeenCalled();
  });

  it("répond 401 avec un jeton signé par une autre clé", async () => {
    await setBooking();
    H.session.token = await new SignJWT({ uid: crypto.randomUUID(), role: "admin", tv: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(4_102_444_800)
      .sign(new TextEncoder().encode("une-autre-cle-de-32-octets-aaaaaa"));
    expect((await call("2026-08-10")).status).toBe(401);
  });

  it("répond 401 quand la version de jeton ne correspond plus (session révoquée)", async () => {
    await setBooking();
    const user = await loginAs("caller");
    await testDb
      .update((await import("@/db/schema")).users)
      .set({ tokenVersion: user.tokenVersion + 1 })
      .where(eq((await import("@/db/schema")).users.id, user.id));
    expect((await call("2026-08-10")).status).toBe(401);
  });

  it("un téléphoniste (caller) a le droit de consulter les disponibilités", async () => {
    await setBooking();
    await loginAs("caller");
    const { status, body } = await call("2026-08-10");
    expect(status).toBe(200);
    expect(body.viewerIsAdmin).toBe(false);
    expect(Array.isArray(body.slots)).toBe(true);
  });

  it("expose viewerIsAdmin=true pour l'admin", async () => {
    await setBooking();
    await loginAs("admin");
    expect((await call("2026-08-10")).body.viewerIsAdmin).toBe(true);
  });

  it.each([
    ["vide", ""],
    ["format jour/mois", "10-08-2026"],
    ["sans zéro initial", "2026-8-1"],
    ["horodatage complet", "2026-08-10T00:00:00Z"],
    ["texte", "demain"],
  ])("répond 400 pour une date %s", async (_l, date) => {
    await setBooking();
    await loginAs();
    const { status, body } = await call(date);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid_date" });
  });

  it("répond 400 quand le paramètre date est absent", async () => {
    await setBooking();
    await loginAs();
    const res = await GET(new NextRequest("http://localhost:3000/api/availability"));
    expect(res.status).toBe(400);
  });

  it.each(["2026-13-45", "2026-00-10", "2026-01-32", "9999-99-99"])(
    "une date absurde (%s) est refusée avec 400 invalid_date",
    async (date) => {
      await setBooking();
      await loginAs();
      const { status, body } = await call(date);
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_date");
    },
  );

  it.each(["2026-02-30", "2026-04-31", "2026-11-31"])(
    "RÉGRESSION (corrigé) : une date impossible (%s) renvoie 502 au lieu d'être refusée proprement",
    async (date) => {
      // DATE_RE laisse passer ces dates. `new Date("2026-02-30T…Z")` déborde
      // silencieusement sur mars, donc le contrôle du jour de semaine passe,
      // puis `fromZonedTime` produit une Invalid Date → RangeError dans la
      // requête Postgres → 502 + trace d'erreur serveur, sur une simple
      // entrée malformée. Attendu : 400 (rejet) ou 200 avec zéro créneau.
      vi.stubGlobal("console", { ...console, error: vi.fn() });
      await setBooking();
      await loginAs();
      const { status, body } = await call(date);
      expect([200, 400], `statut inattendu: ${status} ${JSON.stringify(body)}`).toContain(status);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Fenêtre horaire, fuseau et durées
// ═══════════════════════════════════════════════════════════════════════════

describe("fenêtre horaire et fuseau", () => {
  beforeEach(async () => {
    await loginAs();
  });

  it("respecte startHour / endHour", async () => {
    await setBooking({ startHour: "09:00", endHour: "12:00", bufferMin: 0, meetDurationMin: 30 });
    expect(labels(await slotsOf("2026-08-10"))).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it("le dernier créneau se termine exactement à endHour, jamais après", async () => {
    await setBooking({ startHour: "09:00", endHour: "10:00", bufferMin: 0, meetDurationMin: 30 });
    const slots = await slotsOf("2026-08-10");
    expect(labels(slots)).toEqual(["09:00", "09:30"]);
    const last = new Date(slots[slots.length - 1]).getTime() + 30 * 60_000;
    expect(last).toBe(at("2026-08-10T10:00:00").getTime());
  });

  it("les créneaux sont ancrés sur le fuseau des réglages, pas sur celui du serveur", async () => {
    await setBooking({ startHour: "09:00", endHour: "11:00", bufferMin: 0, timezone: "Europe/Paris" });
    const { body } = await call("2026-08-10");
    expect(body.timezone).toBe("Europe/Paris");
    expect(new Date(body.slots[0]).toISOString()).toBe(
      at("2026-08-10T09:00:00", "Europe/Paris").toISOString(),
    );
    expect(labels(body.slots, "Europe/Paris")).toEqual(["09:00", "09:30", "10:00", "10:30"]);
    // …et le même instant s'affiche 6 h plus tôt à Toronto (été).
    expect(label(body.slots[0])).toBe("03:00");
  });

  it("retombe sur America/Toronto quand le fuseau enregistré est vide", async () => {
    await setBooking({ timezone: "", startHour: "09:00", endHour: "10:00", bufferMin: 0 });
    const { body } = await call("2026-08-10");
    expect(body.timezone).toBe(TZ);
    expect(new Date(body.slots[0]).toISOString()).toBe(at("2026-08-10T09:00:00").toISOString());
  });

  it("le pas de la grille est de 30 minutes quelle que soit la durée", async () => {
    await setBooking({ startHour: "09:00", endHour: "12:00", bufferMin: 0, inPersonDurationMin: 60 });
    const slots = await slotsOf("2026-08-10", "inperson");
    for (let i = 1; i < slots.length; i++) {
      expect(new Date(slots[i]).getTime() - new Date(slots[i - 1]).getTime()).toBe(
        SLOT_STEP_MIN * 60_000,
      );
    }
  });

  it("une fenêtre inversée ou vide (endHour <= startHour) est REFUSÉE par le schéma des réglages", () => {
    // Avant : stockée telle quelle, elle rendait zéro créneau pour tout le
    // monde sans la moindre erreur. `computeAvailability` garde sa garde
    // « windowEnd <= windowStart » en défense, mais l'état n'est plus atteignable.
    expect(bookingSettingsSchema.safeParse({ startHour: "18:00", endHour: "09:00" }).success).toBe(false);
    expect(bookingSettingsSchema.safeParse({ startHour: "09:00", endHour: "09:00" }).success).toBe(false);
    expect(bookingSettingsSchema.safeParse({ startHour: "09:00", endHour: "09:30" }).success).toBe(true);
  });

  it("les créneaux sont strictement croissants et sans doublon", async () => {
    await setBooking({ bufferMin: 0 }); // 06:00 → 23:00
    const slots = await slotsOf("2026-08-10");
    expect(new Set(slots).size).toBe(slots.length);
    const times = slots.map((s) => new Date(s).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("durées meet vs en personne", () => {
  beforeEach(async () => {
    await loginAs();
    await setBooking({
      startHour: "09:00",
      endHour: "12:00",
      meetDurationMin: 30,
      inPersonDurationMin: 60,
      bufferMin: 0,
      inPersonDefaultLocation: "123 rue Principale, Québec",
    });
  });

  it("meet : 30 min, dernier départ à 11:30", async () => {
    const { body } = await call("2026-08-10", "meet");
    expect(body.duration).toBe(30);
    expect(labels(body.slots)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
  });

  it("inperson : 60 min, dernier départ à 11:00", async () => {
    const { body } = await call("2026-08-10", "inperson");
    expect(body.duration).toBe(60);
    expect(labels(body.slots)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
    expect(body.defaultLocation).toBe("123 rue Principale, Québec");
  });

  it("un type inconnu retombe sur meet", async () => {
    for (const type of ["", "visio", "INPERSON", "in-person"]) {
      const { body } = await call("2026-08-10", type);
      expect(body.duration, `type=${type}`).toBe(30);
    }
  });

  it("durationFor reflète les réglages", async () => {
    const s = bookingSettingsSchema.parse({ meetDurationMin: 45, inPersonDurationMin: 90 });
    expect(durationFor(s, "meet")).toBe(45);
    expect(durationFor(s, "inperson")).toBe(90);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Jours réservables
// ═══════════════════════════════════════════════════════════════════════════

describe("jours réservables", () => {
  beforeEach(async () => {
    await loginAs();
  });

  it("un jour absent de settings.days ne renvoie aucun créneau et n'interroge pas Google", async () => {
    await setBooking({ days: [1, 2, 3, 4, 5] }); // lundi → vendredi
    const { status, body } = await call("2026-08-09"); // dimanche
    expect(status).toBe(200);
    expect(body.slots).toEqual([]);
    expect(body.days).toEqual([1, 2, 3, 4, 5]);
    expect(H.freeBusy).not.toHaveBeenCalled();
  });

  it("le jour de la semaine est indépendant du fuseau configuré", async () => {
    // 2026-08-10 est un lundi partout ; avec un fuseau très décalé la journée
    // doit rester réservable.
    await setBooking({ days: [1], timezone: "Pacific/Auckland", startHour: "09:00", endHour: "10:00" });
    expect((await slotsOf("2026-08-10")).length).toBeGreaterThan(0);
    expect(await slotsOf("2026-08-11")).toEqual([]); // mardi
  });

  it("days: [] bloque toute la semaine", async () => {
    await setBooking({ days: [] });
    for (const d of ["2026-08-10", "2026-08-11", "2026-08-12"]) {
      expect(await slotsOf(d)).toEqual([]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Délai minimum (pas de créneau dans le passé)
// ═══════════════════════════════════════════════════════════════════════════

describe("délai minimum avant réservation", () => {
  beforeEach(async () => {
    await loginAs();
    await setBooking({ startHour: "09:00", endHour: "12:00", bufferMin: 0 });
  });

  it("écarte les créneaux à moins de MIN_LEAD_MIN de maintenant", async () => {
    expect(MIN_LEAD_MIN).toBe(45);
    now("2026-08-10T13:20:00Z"); // 09:20 à Toronto → premier créneau utile 10:05+
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["10:30", "11:00", "11:30"]);
  });

  it("garde le créneau situé juste au-delà de la limite", async () => {
    now("2026-08-10T13:16:00Z"); // 09:16 → limite 10:01 → 10:00 exclu, 10:30 gardé
    expect(labels(await slotsOf("2026-08-10"))[0]).toBe("10:30");
    now("2026-08-10T13:14:00Z"); // 09:14 → limite 09:59 → 10:00 gardé
    expect(labels(await slotsOf("2026-08-10"))[0]).toBe("10:00");
  });

  it("une journée entièrement passée ne renvoie aucun créneau", async () => {
    now("2026-08-10T13:00:00Z");
    expect(await slotsOf("2026-08-03")).toEqual([]); // lundi précédent
  });

  it("aucun créneau quand la fenêtre du jour est déjà écoulée", async () => {
    now("2026-08-10T23:00:00Z"); // 19:00 à Toronto, fenêtre 09:00 → 12:00
    expect(await slotsOf("2026-08-10")).toEqual([]);
  });

  it("aucun créneau retourné n'est antérieur à maintenant", async () => {
    now("2026-08-10T14:07:00Z");
    const slots = await slotsOf("2026-08-10");
    for (const s of slots) {
      expect(new Date(s).getTime()).toBeGreaterThanOrEqual(Date.now() + MIN_LEAD_MIN * 60_000);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Occupations Google
// ═══════════════════════════════════════════════════════════════════════════

describe("occupations Google Agenda", () => {
  beforeEach(async () => {
    await loginAs();
    await setBooking({ startHour: "09:00", endHour: "12:00", bufferMin: 0, meetDurationMin: 30 });
  });

  it("interroge freeBusy sur la journée locale complète", async () => {
    await call("2026-08-10");
    expect(H.freeBusy).toHaveBeenCalledTimes(1);
    const [min, max] = H.freeBusy.mock.calls[0];
    expect(min.toISOString()).toBe(at("2026-08-10T00:00:00").toISOString());
    // La borne haute couvre toute la journée locale (23 h à 25 h selon le DST).
    const spanH = (max.getTime() - min.getTime()) / 3_600_000;
    expect(spanH).toBeGreaterThanOrEqual(23);
    expect(spanH).toBeLessThanOrEqual(25);
  });

  it("soustrait un bloc occupé aligné sur la grille", async () => {
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T10:00:00"), end: at("2026-08-10T10:30:00") },
    ]);
    expect(labels(await slotsOf("2026-08-10"))).toEqual([
      "09:00",
      "09:30",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it("soustrait un chevauchement PARTIEL par la fin du créneau (bord gauche)", async () => {
    // 10:15 → 10:20 : ne touche que le créneau 10:00-10:30.
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T10:15:00"), end: at("2026-08-10T10:20:00") },
    ]);
    expect(labels(await slotsOf("2026-08-10"))).toEqual([
      "09:00",
      "09:30",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it("soustrait un chevauchement PARTIEL des deux côtés", async () => {
    // 10:15 → 10:45 déborde sur 10:00-10:30 ET sur 10:30-11:00.
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T10:15:00"), end: at("2026-08-10T10:45:00") },
    ]);
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["09:00", "09:30", "11:00", "11:30"]);
  });

  it("deux blocs adjacents ne se bloquent pas mutuellement (bornes exclusives)", async () => {
    // Un bloc qui finit pile au début d'un créneau ne le bloque pas.
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T09:00:00"), end: at("2026-08-10T10:00:00") },
    ]);
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["10:00", "10:30", "11:00", "11:30"]);
  });

  it("un bloc couvrant toute la fenêtre supprime tous les créneaux", async () => {
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T08:00:00"), end: at("2026-08-10T13:00:00") },
    ]);
    expect(await slotsOf("2026-08-10")).toEqual([]);
  });

  it("un bloc hors fenêtre ne change rien", async () => {
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T05:00:00"), end: at("2026-08-10T06:00:00") },
      { start: at("2026-08-10T14:00:00"), end: at("2026-08-10T15:00:00") },
    ]);
    expect(labels(await slotsOf("2026-08-10"))).toHaveLength(6);
  });

  it("cumule plusieurs blocs occupés", async () => {
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T09:00:00"), end: at("2026-08-10T09:30:00") },
      { start: at("2026-08-10T11:00:00"), end: at("2026-08-10T12:00:00") },
    ]);
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["09:30", "10:00", "10:30"]);
  });

  it("un rendez-vous en personne (60 min) est bloqué par un occupé dans sa seconde moitié", async () => {
    await setBooking({
      startHour: "09:00",
      endHour: "12:00",
      bufferMin: 0,
      inPersonDurationMin: 60,
    });
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T10:45:00"), end: at("2026-08-10T10:50:00") },
    ]);
    // 10:00-11:00 et 10:30-11:30 chevauchent ; 09:00/09:30/11:00 restent libres.
    expect(labels(await slotsOf("2026-08-10", "inperson"))).toEqual(["09:00", "09:30", "11:00"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tampon (bufferMin)
// ═══════════════════════════════════════════════════════════════════════════

describe("tampon autour des blocs occupés", () => {
  beforeEach(async () => {
    await loginAs();
  });

  it("bufferMin=15 élargit le bloc des deux côtés", async () => {
    await setBooking({ startHour: "09:00", endHour: "12:00", bufferMin: 15 });
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T10:00:00"), end: at("2026-08-10T10:30:00") },
    ]);
    // Bloqués : 09:30 (finit 10:00 > 09:45), 10:00, 10:30 (démarre avant 10:45).
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["09:00", "11:00", "11:30"]);
  });

  it("bufferMin=0 ne bloque que le chevauchement strict", async () => {
    await setBooking({ startHour: "09:00", endHour: "12:00", bufferMin: 0 });
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T10:00:00"), end: at("2026-08-10T10:30:00") },
    ]);
    expect(labels(await slotsOf("2026-08-10"))).toEqual([
      "09:00",
      "09:30",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it("bufferMin=60 dégage une heure de part et d'autre", async () => {
    await setBooking({ startHour: "09:00", endHour: "14:00", bufferMin: 60 });
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T11:00:00"), end: at("2026-08-10T11:30:00") },
    ]);
    // Libre seulement si le créneau finit ≤ 10:00 ou démarre ≥ 12:30.
    expect(labels(await slotsOf("2026-08-10"))).toEqual([
      "09:00",
      "09:30",
      "12:30",
      "13:00",
      "13:30",
    ]);
  });

  it("le tampon s'applique aussi à un bloc situé AVANT la fenêtre", async () => {
    await setBooking({ startHour: "09:00", endHour: "11:00", bufferMin: 15 });
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T08:30:00"), end: at("2026-08-10T08:50:00") },
    ]);
    // 08:50 + 15 min = 09:05 > 09:00 → le premier créneau saute.
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["09:30", "10:00", "10:30"]);
  });

  it("le tampon s'applique aussi à un bloc situé APRÈS la fenêtre", async () => {
    await setBooking({ startHour: "09:00", endHour: "11:00", bufferMin: 15 });
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T11:05:00"), end: at("2026-08-10T12:00:00") },
    ]);
    // 11:05 - 15 min = 10:50 : le créneau 10:30-11:00 finit après → bloqué.
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["09:00", "09:30", "10:00"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rendez-vous locaux
// ═══════════════════════════════════════════════════════════════════════════

describe("rendez-vous déjà enregistrés en base", () => {
  beforeEach(async () => {
    await loginAs();
    await setBooking({ startHour: "09:00", endHour: "12:00", bufferMin: 0 });
  });

  it("un rendez-vous « scheduled » bloque son créneau", async () => {
    await makeAppointment({
      start: at("2026-08-10T10:00:00"),
      end: at("2026-08-10T10:30:00"),
    });
    expect(labels(await slotsOf("2026-08-10"))).toEqual([
      "09:00",
      "09:30",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it("un rendez-vous ANNULÉ ne bloque rien", async () => {
    await makeAppointment({
      start: at("2026-08-10T10:00:00"),
      end: at("2026-08-10T10:30:00"),
      status: "cancelled",
    });
    expect(labels(await slotsOf("2026-08-10"))).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it.each(["completed", "noshow"] as const)(
    "un rendez-vous « %s » ne bloque plus le créneau",
    async (status) => {
      await makeAppointment({
        start: at("2026-08-10T10:00:00"),
        end: at("2026-08-10T10:30:00"),
        status,
      });
      expect(labels(await slotsOf("2026-08-10"))).toContain("10:00");
    },
  );

  it("un rendez-vous local subit le même tampon qu'un bloc Google", async () => {
    await setBooking({ startHour: "09:00", endHour: "12:00", bufferMin: 15 });
    await makeAppointment({
      start: at("2026-08-10T10:00:00"),
      end: at("2026-08-10T10:30:00"),
    });
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["09:00", "11:00", "11:30"]);
  });

  it("un rendez-vous d'un AUTRE jour ne bloque rien", async () => {
    await makeAppointment({
      start: at("2026-08-11T10:00:00"),
      end: at("2026-08-11T10:30:00"),
    });
    expect(labels(await slotsOf("2026-08-10"))).toHaveLength(6);
  });

  it("un rendez-vous qui déborde depuis la veille bloque le début de la journée", async () => {
    await setBooking({ startHour: "00:00", endHour: "03:00", bufferMin: 0 });
    await makeAppointment({
      start: at("2026-08-09T23:00:00"),
      end: at("2026-08-10T01:00:00"),
    });
    expect(labels(await slotsOf("2026-08-10"))).toEqual([
      "01:00",
      "01:30",
      "02:00",
      "02:30",
    ]);
  });

  it("cumule les rendez-vous locaux et les blocs Google", async () => {
    H.freeBusy.mockResolvedValue([
      { start: at("2026-08-10T09:00:00"), end: at("2026-08-10T09:30:00") },
    ]);
    await makeAppointment({
      start: at("2026-08-10T11:00:00"),
      end: at("2026-08-10T12:00:00"),
    });
    expect(labels(await slotsOf("2026-08-10"))).toEqual(["09:30", "10:00", "10:30"]);
  });

  it("excludeAppointmentId libère le créneau du rendez-vous en cours de modification", async () => {
    const appt = await makeAppointment({
      start: at("2026-08-10T10:00:00"),
      end: at("2026-08-10T10:30:00"),
    });
    const without = await computeAvailability("2026-08-10", "meet");
    expect(labels(without.slots)).not.toContain("10:00");

    const withExclusion = await computeAvailability("2026-08-10", "meet", {
      excludeAppointmentId: appt.id,
    });
    expect(labels(withExclusion.slots)).toContain("10:00");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Panne / non-connexion Google
// ═══════════════════════════════════════════════════════════════════════════

describe("état de la connexion Google", () => {
  beforeEach(async () => {
    await loginAs("admin");
    await setBooking({ startHour: "09:00", endHour: "11:00", bufferMin: 0 });
  });

  it("googleConnected=true quand freeBusy répond", async () => {
    const { body } = await call("2026-08-10");
    expect(body.googleConnected).toBe(true);
  });

  it("googleConnected=false quand Google n'est pas connecté, mais les créneaux sont calculés", async () => {
    H.freeBusy.mockRejectedValue(new H.GoogleNotConnectedError());
    const { status, body } = await call("2026-08-10");
    expect(status).toBe(200);
    expect(body.googleConnected).toBe(false);
    expect(labels(body.slots)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  it("les rendez-vous locaux bloquent encore quand Google n'est pas connecté", async () => {
    H.freeBusy.mockRejectedValue(new H.GoogleNotConnectedError());
    await makeAppointment({
      start: at("2026-08-10T10:00:00"),
      end: at("2026-08-10T10:30:00"),
    });
    const { body } = await call("2026-08-10");
    expect(body.googleConnected).toBe(false);
    expect(labels(body.slots)).toEqual(["09:00", "09:30", "10:30"]);
  });

  it("échoue en 502 plutôt que de proposer des créneaux quand Google est injoignable", async () => {
    vi.stubGlobal("console", { ...console, error: vi.fn() });
    H.freeBusy.mockRejectedValue(new Error("ECONNRESET"));
    const { status, body } = await call("2026-08-10");
    expect(status).toBe(502);
    expect(body).toEqual({ error: "availability_failed" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Réglages par défaut
// ═══════════════════════════════════════════════════════════════════════════

describe("réglages", () => {
  it("fonctionne sans ligne « booking » en base (défauts du schéma)", async () => {
    await loginAs();
    const { status, body } = await call("2026-08-10");
    expect(status).toBe(200);
    expect(body.timezone).toBe(TZ);
    expect(body.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(body.duration).toBe(30);
    // 06:00 → 23:00, pas de 30 min, durée 30 → 34 départs possibles.
    expect(body.slots).toHaveLength(34);
    expect(labels(body.slots)[0]).toBe("06:00");
    expect(labels(body.slots).at(-1)).toBe("22:30");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Changements d'heure (DST) — America/Toronto
// ═══════════════════════════════════════════════════════════════════════════

describe("changement d'heure — passage à l'heure avancée (2026-03-08)", () => {
  beforeEach(async () => {
    await loginAs();
    now("2026-03-01T12:00:00Z");
  });

  it("saute l'heure inexistante 02:00 → 03:00 sans trou ni doublon", async () => {
    await setBooking({ startHour: "00:00", endHour: "05:00", bufferMin: 0 });
    const slots = await slotsOf("2026-03-08");

    // 4 h réelles (la journée locale perd une heure) → 8 départs de 30 min.
    expect(slots).toHaveLength(8);
    expect(new Set(slots).size).toBe(8);
    expect(labels(slots)).toEqual([
      "00:00",
      "00:30",
      "01:00",
      "01:30",
      "03:00", // 02:00 et 02:30 n'existent pas ce jour-là
      "03:30",
      "04:00",
      "04:30",
    ]);
    expect(labels(slots)).not.toContain("02:00");
    expect(labels(slots)).not.toContain("02:30");
  });

  it("les instants restent espacés de 30 minutes réelles à travers la bascule", async () => {
    await setBooking({ startHour: "00:00", endHour: "05:00", bufferMin: 0 });
    const slots = await slotsOf("2026-03-08");
    for (let i = 1; i < slots.length; i++) {
      expect(new Date(slots[i]).getTime() - new Date(slots[i - 1]).getTime()).toBe(30 * 60_000);
    }
    // Décalage : EST (-05:00) avant la bascule, EDT (-04:00) après.
    expect(offset(slots[0])).toBe("-05:00");
    expect(offset(slots.at(-1)!)).toBe("-04:00");
  });

  it("un bloc occupé exprimé en heure locale est correctement soustrait après la bascule", async () => {
    await setBooking({ startHour: "00:00", endHour: "05:00", bufferMin: 0 });
    H.freeBusy.mockResolvedValue([
      { start: at("2026-03-08T03:00:00"), end: at("2026-03-08T03:30:00") },
    ]);
    expect(labels(await slotsOf("2026-03-08"))).toEqual([
      "00:00",
      "00:30",
      "01:00",
      "01:30",
      "03:30",
      "04:00",
      "04:30",
    ]);
  });

  it("avec la fenêtre par défaut (06:00-23:00) la journée est identique à un dimanche normal", async () => {
    await setBooking({ bufferMin: 0 });
    const dst = await slotsOf("2026-03-08");
    const normal = await slotsOf("2026-03-15");
    expect(dst).toHaveLength(34);
    expect(labels(dst)).toEqual(labels(normal));
    expect(labels(dst)[0]).toBe("06:00");
    expect(labels(dst).at(-1)).toBe("22:30");
  });
});

describe("changement d'heure — retour à l'heure normale (2026-11-01)", () => {
  beforeEach(async () => {
    await loginAs();
    now("2026-10-25T12:00:00Z");
  });

  it("propose les deux occurrences de l'heure répétée, sur des instants distincts", async () => {
    await setBooking({ startHour: "00:00", endHour: "05:00", bufferMin: 0 });
    const slots = await slotsOf("2026-11-01");

    // 6 h réelles (la journée locale gagne une heure) → 12 départs de 30 min.
    expect(slots).toHaveLength(12);
    expect(new Set(slots).size).toBe(12); // instants uniques
    expect(labels(slots)).toEqual([
      "00:00",
      "00:30",
      "01:00", // EDT
      "01:30", // EDT
      "01:00", // EST — même heure murale, instant différent
      "01:30", // EST
      "02:00",
      "02:30",
      "03:00",
      "03:30",
      "04:00",
      "04:30",
    ]);

    // Les deux « 01:00 » sont séparés d'exactement une heure réelle et portent
    // un décalage UTC différent : l'UI peut les distinguer.
    expect(new Date(slots[4]).getTime() - new Date(slots[2]).getTime()).toBe(3_600_000);
    expect(offset(slots[2])).toBe("-04:00");
    expect(offset(slots[4])).toBe("-05:00");
  });

  it("les instants restent espacés de 30 minutes réelles et strictement croissants", async () => {
    await setBooking({ startHour: "00:00", endHour: "05:00", bufferMin: 0 });
    const slots = await slotsOf("2026-11-01");
    for (let i = 1; i < slots.length; i++) {
      const delta = new Date(slots[i]).getTime() - new Date(slots[i - 1]).getTime();
      expect(delta).toBe(30 * 60_000);
    }
  });

  it("un bloc occupé pendant l'heure répétée ne neutralise que son instant", async () => {
    await setBooking({ startHour: "00:00", endHour: "05:00", bufferMin: 0 });
    const firstOneAm = at("2026-11-01T00:30:00").getTime() + 30 * 60_000; // 01:00 EDT
    H.freeBusy.mockResolvedValue([
      { start: new Date(firstOneAm), end: new Date(firstOneAm + 30 * 60_000) },
    ]);
    const slots = await slotsOf("2026-11-01");
    expect(slots).toHaveLength(11);
    // Il reste une seule occurrence de 01:00 : celle en EST.
    const remaining = slots.filter((s) => label(s) === "01:00");
    expect(remaining).toHaveLength(1);
    expect(offset(remaining[0])).toBe("-05:00");
  });

  it("avec la fenêtre par défaut (06:00-23:00) la journée est identique à un dimanche normal", async () => {
    await setBooking({ bufferMin: 0 });
    const dst = await slotsOf("2026-11-01");
    const normal = await slotsOf("2026-11-08");
    expect(dst).toHaveLength(34);
    expect(labels(dst)).toEqual(labels(normal));
    expect(new Set(labels(dst)).size).toBe(34); // aucune étiquette dupliquée
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Fenêtre FreeBusy = journée LOCALE complète, quel que soit le fuseau du
// PROCESSUS (Vercel tourne en UTC). `addDays` sur l'instant comptait 24 h
// dans le fuseau du processus : la 25e heure du 1er novembre n'était jamais
// demandée à Google, et un évènement de 23 h ce jour-là ne bloquait pas le
// créneau de 22 h 30 malgré le tampon.
// ═══════════════════════════════════════════════════════════════════════════

describe("fenêtre FreeBusy — journée locale complète, processus en UTC (prod)", () => {
  const previousTz = process.env.TZ;

  beforeEach(async () => {
    // Node relit TZ à l'affectation : on reproduit exactement l'environnement de prod.
    process.env.TZ = "UTC";
    await loginAs();
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("2026-11-01 (25 h) : la borne haute est minuit local du lendemain, pas +24 h", async () => {
    now("2026-10-25T12:00:00Z");
    await setBooking({ bufferMin: 0 });
    await call("2026-11-01");
    const [min, max] = H.freeBusy.mock.calls[0];
    expect(min.toISOString()).toBe(at("2026-11-01T00:00:00").toISOString());
    expect(max.toISOString()).toBe(at("2026-11-02T00:00:00").toISOString());
    expect((max.getTime() - min.getTime()) / 3_600_000).toBe(25);
  });

  it("2026-03-08 (23 h) : idem, la journée courte est couverte exactement", async () => {
    now("2026-03-01T12:00:00Z");
    await setBooking({ bufferMin: 0 });
    await call("2026-03-08");
    const [min, max] = H.freeBusy.mock.calls[0];
    expect(max.toISOString()).toBe(at("2026-03-09T00:00:00").toISOString());
    expect((max.getTime() - min.getTime()) / 3_600_000).toBe(23);
  });

  it("un jour ordinaire garde ses 24 h", async () => {
    await setBooking({ bufferMin: 0 });
    await call("2026-08-10");
    const [min, max] = H.freeBusy.mock.calls[0];
    expect(max.toISOString()).toBe(at("2026-08-11T00:00:00").toISOString());
    expect((max.getTime() - min.getTime()) / 3_600_000).toBe(24);
  });

  it("un évènement Google à 23 h 05 le 1er novembre bloque le créneau de 22 h 30 (tampon 15 min)", async () => {
    now("2026-10-25T12:00:00Z");
    await setBooking({ bufferMin: 15 }); // fenêtre par défaut 06:00 → 23:00
    // Google ne renvoie le bloc que s'il est DANS la fenêtre demandée — on
    // simule sa réponse fidèlement : rien si la borne haute s'arrête avant.
    const busyStart = at("2026-11-01T23:05:00");
    const busyEnd = at("2026-11-01T23:35:00");
    H.freeBusy.mockImplementation(async (_min: Date, max: Date) =>
      busyStart < max ? [{ start: busyStart, end: busyEnd }] : [],
    );
    const slots = await slotsOf("2026-11-01");
    expect(labels(slots)).not.toContain("22:30");
    expect(labels(slots)).toContain("22:00");
  });
});
