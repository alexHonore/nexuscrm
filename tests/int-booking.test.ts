/**
 * Tests d'intégration — réservation (booking) + disponibilités.
 *
 * Couvre src/app/(app)/appointments/actions.ts (createAppointment /
 * cancelAppointment) et src/app/api/availability/route.ts.
 * Seule la couche Google (réseau externe) est simulée.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hissés au-dessus des imports) ─────────────────────────────────────

vi.mock("server-only", () => ({}));

const ctx = vi.hoisted(() => ({
  token: undefined as string | undefined,
  /**
   * Renseigné plus bas : permet à deux appels CONCURRENTS de porter deux
   * sessions différentes (le contexte suit les `await`, pas une variable
   * de module).
   */
  als: null as AsyncLocalStorage<string | undefined> | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    const token = ctx.als?.getStore() ?? ctx.token;
    return {
      get: (name: string) =>
        name === "nexus_session" && token ? { name, value: token } : undefined,
      set: () => {},
      delete: () => {},
    };
  },
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

ctx.als = new AsyncLocalStorage<string | undefined>();

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const googleMock = vi.hoisted(() => {
  class GoogleNotConnectedError extends Error {
    constructor() {
      super("Google Calendar is not connected");
      this.name = "GoogleNotConnectedError";
    }
  }
  return {
    GoogleNotConnectedError,
    createBookingEvent: vi.fn(),
    cancelEvent: vi.fn(),
    freeBusy: vi.fn(),
  };
});

vi.mock("@/lib/google", () => ({
  GoogleNotConnectedError: googleMock.GoogleNotConnectedError,
  createBookingEvent: googleMock.createBookingEvent,
  cancelEvent: googleMock.cancelEvent,
  freeBusy: googleMock.freeBusy,
  GOOGLE_STATE_COOKIE: "google_oauth_state",
  GOOGLE_SCOPES: [],
}));

// ── Imports produit (après les mocks) ────────────────────────────────────────

import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  cancelAppointment,
  createAppointment,
  type CreateAppointmentInput,
} from "@/app/(app)/appointments/actions";
import { GET as availabilityGET } from "@/app/api/availability/route";
import { appointments, auditLogs, clients, notifications } from "@/db/schema";
import { setSetting } from "@/lib/settings";
import {
  closeDb,
  makeClient,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Lundi 10 août 2026, 09 h 00 à Toronto (EDT, UTC-4). */
const NOW = new Date("2026-08-10T13:00:00.000Z");
const DAY = "2026-08-10";
/** 11 h 00 Toronto — sur la grille de 30 min et > NOW + 45 min. */
const SLOT = "2026-08-10T15:00:00.000Z";
const SLOT_B = "2026-08-10T18:00:00.000Z";

const QUALIFICATION = {
  projectType: "acheter",
  timing: "0_3",
  budget: "400_600k",
  financing: "en_demarche",
  currentSituation: "locataire",
  sector: "Québec",
  notes: "Cherche un condo au centre-ville",
} as const;

type Ids = {
  admin: string;
  caller: string;
  otherCaller: string;
  client: string;
  bookedCategoryId: number;
};

let ids: Ids;

async function sessionToken(userId: string, role: "admin" | "caller"): Promise<string> {
  return new SignJWT({ uid: userId, role, tv: 1, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
}

async function login(userId: string, role: "admin" | "caller") {
  ctx.token = await sessionToken(userId, role);
}

/** Exécute une action sous la session d'un autre utilisateur (contexte async isolé). */
function as<T>(token: string, fn: () => Promise<T>): Promise<T> {
  return ctx.als!.run(token, fn);
}

function input(overrides: Partial<CreateAppointmentInput> = {}): CreateAppointmentInput {
  return {
    clientId: ids.client,
    type: "meet",
    startsAt: SLOT,
    email: "nouveau@exemple.ca",
    qualification: { ...QUALIFICATION },
    ...overrides,
  } as CreateAppointmentInput;
}

async function availability(date = DAY, type = "meet"): Promise<{ slots: string[] }> {
  const res = await availabilityGET(
    new NextRequest(`http://localhost:3000/api/availability?date=${date}&type=${type}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { slots: string[] };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();

  googleMock.freeBusy.mockResolvedValue([]);
  googleMock.createBookingEvent.mockResolvedValue({
    eventId: "gcal_evt_001",
    meetLink: "https://meet.google.com/abc-defg-hij",
    htmlLink: "https://calendar.google.com/event?eid=abc",
  });
  googleMock.cancelEvent.mockResolvedValue(undefined);

  await resetDb();
  const cats = await seedSystemCategories();
  const admin = await makeUser({ name: "Admin Nexus", role: "admin", email: "admin@nexus.test" });
  const caller = await makeUser({ name: "Téléphoniste Un", role: "caller", email: "c1@nexus.test" });
  const otherCaller = await makeUser({
    name: "Téléphoniste Deux",
    role: "caller",
    email: "c2@nexus.test",
  });
  const client = await makeClient({
    fullName: "Marie Tremblay",
    phone: "+14184761542",
    email: "ancien@exemple.ca",
    categoryId: cats.new.id,
    assignedToId: caller.id,
  });

  ids = {
    admin: admin.id,
    caller: caller.id,
    otherCaller: otherCaller.id,
    client: client.id,
    bookedCategoryId: cats.booked.id,
  };
  await login(caller.id, "caller");
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});

// ── createAppointment ────────────────────────────────────────────────────────

describe("createAppointment", () => {
  it("enregistre le RDV avec snapshot de qualification, meetLink et googleEventId", async () => {
    const res = await createAppointment(input());
    expect(res).toMatchObject({
      ok: true,
      googleSynced: true,
      warning: null,
      meetLink: "https://meet.google.com/abc-defg-hij",
      startsAt: SLOT,
      endsAt: "2026-08-10T15:30:00.000Z",
    });

    const rows = await testDb.select().from(appointments);
    expect(rows).toHaveLength(1);
    const appt = rows[0];
    expect(appt.clientId).toBe(ids.client);
    expect(appt.userId).toBe(ids.caller);
    expect(appt.type).toBe("meet");
    expect(appt.status).toBe("scheduled");
    expect(appt.title).toBe("RDV — Marie Tremblay");
    expect(appt.startsAt.toISOString()).toBe(SLOT);
    expect(appt.endsAt.toISOString()).toBe("2026-08-10T15:30:00.000Z");
    expect(appt.googleEventId).toBe("gcal_evt_001");
    expect(appt.meetLink).toBe("https://meet.google.com/abc-defg-hij");
    expect(appt.location).toBeNull();
    expect(appt.notes).toBe(QUALIFICATION.notes);
    // Snapshot complet de la qualification au moment de la réservation.
    expect(appt.qualification).toEqual({ ...QUALIFICATION });
  });

  it("transmet à Google le courriel confirmé, le fuseau et le résumé de qualification", async () => {
    await createAppointment(input());
    expect(googleMock.createBookingEvent).toHaveBeenCalledTimes(1);
    const arg = googleMock.createBookingEvent.mock.calls[0][0];
    expect(arg).toMatchObject({
      type: "meet",
      clientName: "Marie Tremblay",
      clientPhone: "+14184761542",
      clientEmail: "nouveau@exemple.ca",
      callerName: "Téléphoniste Un",
      timezone: "America/Toronto",
    });
    expect(arg.startsAt.toISOString()).toBe(SLOT);
    expect(arg.endsAt.toISOString()).toBe("2026-08-10T15:30:00.000Z");
    expect(arg.qualificationSummary).toContain("Projet : Acheter");
    expect(arg.qualificationSummary).toContain("Horizon : 0-3 mois");
    expect(arg.qualificationSummary).toContain("Budget : 400 k$ – 600 k$");
    expect(arg.qualificationSummary).toContain("Secteur : Québec");
  });

  it("bascule le client en catégorie « booked » et recopie la qualification", async () => {
    await createAppointment(input());
    const [client] = await testDb.select().from(clients).where(eq(clients.id, ids.client));
    expect(client.categoryId).toBe(ids.bookedCategoryId);
    expect(client.qualification).toEqual({ ...QUALIFICATION });
    expect(client.projectType).toBe("acheter");
    expect(client.timing).toBe("0-3 mois");
    expect(client.budget).toBe("400 k$ – 600 k$");
    expect(client.city).toBe("Québec");
  });

  it("met à jour le courriel du client quand il a été corrigé", async () => {
    await createAppointment(input({ email: "corrige@exemple.ca" }));
    const [client] = await testDb.select().from(clients).where(eq(clients.id, ids.client));
    expect(client.email).toBe("corrige@exemple.ca");
  });

  it("conserve le courriel existant quand aucun n'est fourni", async () => {
    await createAppointment(input({ email: "" }));
    const [client] = await testDb.select().from(clients).where(eq(clients.id, ids.client));
    expect(client.email).toBe("ancien@exemple.ca");
    expect(googleMock.createBookingEvent.mock.calls[0][0].clientEmail).toBe("ancien@exemple.ca");
  });

  it("journalise l'action dans l'audit", async () => {
    const res = await createAppointment(input());
    if (!res.ok) throw new Error("booking failed");

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "appointment.create"));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(ids.caller);
    expect(logs[0].entity).toBe("appointment");
    expect(logs[0].entityId).toBe(res.appointmentId);
    expect(logs[0].ip).toBe("203.0.113.7");
    expect(logs[0].detail).toMatchObject({
      clientId: ids.client,
      type: "meet",
      startsAt: SLOT,
      googleEventId: "gcal_evt_001",
      googleSynced: true,
    });
  });

  it("notifie l'admin (et pas le téléphoniste auteur)", async () => {
    await createAppointment(input());
    const notifs = await testDb.select().from(notifications);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId).toBe(ids.admin);
    expect(notifs[0].type).toBe("appointment");
    expect(notifs[0].link).toBe("/appointments");
    expect(notifs[0].body).toContain("Marie Tremblay");
    expect(notifs[0].body).toContain("(418) 476-1542");
  });

  it("refuse un appelant non authentifié", async () => {
    ctx.token = undefined;
    expect(await createAppointment(input())).toEqual({ ok: false, error: "unauthenticated" });
    expect(await testDb.select().from(appointments)).toHaveLength(0);
  });

  it("refuse un client inconnu", async () => {
    const res = await createAppointment(
      input({ clientId: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(res).toEqual({ ok: false, error: "not_found" });
  });

  it("refuse une heure hors de la grille de disponibilité", async () => {
    // 15h07 UTC : pas un multiple de 30 min depuis le début de la fenêtre.
    const res = await createAppointment(input({ startsAt: "2026-08-10T15:07:00.000Z" }));
    expect(res).toEqual({ ok: false, error: "slot_taken" });
    expect(await testDb.select().from(appointments)).toHaveLength(0);
  });

  it("refuse une heure déjà passée (délai minimum de 45 min)", async () => {
    const res = await createAppointment(input({ startsAt: "2026-08-10T13:30:00.000Z" }));
    expect(res).toEqual({ ok: false, error: "slot_taken" });
  });

  it("accepte le dernier créneau de la soirée (date UTC du lendemain, jour Toronto courant)", async () => {
    // 22 h 30 à Toronto le 10 août = 02:30Z le 11 août.
    const res = await createAppointment(input({ startsAt: "2026-08-11T02:30:00.000Z" }));
    expect(res).toMatchObject({ ok: true, endsAt: "2026-08-11T03:00:00.000Z" });

    const [appt] = await testDb.select().from(appointments);
    expect(appt.startsAt.toISOString()).toBe("2026-08-11T02:30:00.000Z");
    // Le créneau disparaît bien de la journée Toronto du 10, pas du 11.
    expect((await availability("2026-08-10")).slots).not.toContain("2026-08-11T02:30:00.000Z");
  });
});

// ── Double réservation concurrente ───────────────────────────────────────────

describe("createAppointment — concurrence", () => {
  it("deux réservations simultanées du MÊME créneau : une seule gagne", async () => {
    const [a, b] = await Promise.all([
      createAppointment(input({ startsAt: SLOT_B })),
      createAppointment(input({ startsAt: SLOT_B })),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const kos = [a, b].filter((r) => !r.ok);
    expect(oks).toHaveLength(1);
    expect(kos).toHaveLength(1);
    expect(kos[0]).toEqual({ ok: false, error: "slot_taken" });

    const scheduled = await testDb
      .select()
      .from(appointments)
      .where(eq(appointments.status, "scheduled"));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].startsAt.toISOString()).toBe(SLOT_B);
  });

  it("cinq réservations simultanées du MÊME créneau : une seule ligne planifiée", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createAppointment(input({ startsAt: SLOT_B }))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toEqual({ ok: false, error: "slot_taken" });
    }
    expect(await testDb.select().from(appointments)).toHaveLength(1);
  });

  it("deux téléphonistes en parallèle sur DEUX créneaux : chacun son RDV (sessions bien distinctes)", async () => {
    const t1 = await sessionToken(ids.caller, "caller");
    const t2 = await sessionToken(ids.otherCaller, "caller");

    const results = await Promise.all([
      as(t1, () => createAppointment(input({ startsAt: SLOT }))),
      as(t2, () => createAppointment(input({ startsAt: SLOT_B }))),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);

    const rows = await testDb.select().from(appointments);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([ids.caller, ids.otherCaller]));
  });

  it("deux téléphonistes DIFFÉRENTS visant le même créneau : un seul RDV planifié", async () => {
    const t1 = await sessionToken(ids.caller, "caller");
    const t2 = await sessionToken(ids.otherCaller, "caller");

    const [a, b] = await Promise.all([
      as(t1, () => createAppointment(input({ startsAt: SLOT_B }))),
      as(t2, () => createAppointment(input({ startsAt: SLOT_B }))),
    ]);

    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].filter((r) => !r.ok)).toEqual([{ ok: false, error: "slot_taken" }]);

    const rows = await testDb.select().from(appointments);
    expect(rows).toHaveLength(1);
    expect([ids.caller, ids.otherCaller]).toContain(rows[0].userId);
    // Un seul évènement Google créé — pas de double invitation au client.
    expect(googleMock.createBookingEvent).toHaveBeenCalledTimes(1);
  });

  it("un créneau adjacent (dans la marge tampon) est refusé après réservation", async () => {
    expect((await createAppointment(input())).ok).toBe(true);
    // Marge de 15 min : 15:30 chevauche 15:00-15:30 + tampon.
    const res = await createAppointment(input({ startsAt: "2026-08-10T15:30:00.000Z" }));
    expect(res).toEqual({ ok: false, error: "slot_taken" });
  });
});

// ── Dégradation Google ───────────────────────────────────────────────────────

describe("createAppointment — Google indisponible", () => {
  it("GoogleNotConnectedError : RDV créé localement avec un avertissement", async () => {
    googleMock.createBookingEvent.mockRejectedValue(new googleMock.GoogleNotConnectedError());

    const res = await createAppointment(input());
    expect(res).toMatchObject({
      ok: true,
      googleSynced: false,
      warning: "google_not_connected",
      meetLink: null,
    });

    const [appt] = await testDb.select().from(appointments);
    expect(appt.status).toBe("scheduled");
    expect(appt.googleEventId).toBeNull();
    expect(appt.meetLink).toBeNull();
    // Le client bascule quand même en « booked ».
    const [client] = await testDb.select().from(clients).where(eq(clients.id, ids.client));
    expect(client.categoryId).toBe(ids.bookedCategoryId);
  });

  it("GoogleNotConnectedError : notification système aux admins", async () => {
    googleMock.createBookingEvent.mockRejectedValue(new googleMock.GoogleNotConnectedError());
    await createAppointment(input());

    const systemNotifs = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.type, "system"));
    expect(systemNotifs).toHaveLength(1);
    expect(systemNotifs[0].userId).toBe(ids.admin);
    expect(systemNotifs[0].link).toBe("/admin/settings");
  });

  it("erreur générique : RDV créé + notification système aux admins", async () => {
    googleMock.createBookingEvent.mockRejectedValue(new Error("503 backend error"));

    const res = await createAppointment(input());
    expect(res).toMatchObject({
      ok: true,
      googleSynced: false,
      warning: "google_sync_failed",
      meetLink: null,
    });

    const [appt] = await testDb.select().from(appointments);
    expect(appt.status).toBe("scheduled");
    expect(appt.googleEventId).toBeNull();

    const notifs = await testDb.select().from(notifications);
    // 1 « nouveau RDV » + 1 « système » pour l'admin.
    expect(notifs.filter((n) => n.type === "appointment")).toHaveLength(1);
    const system = notifs.filter((n) => n.type === "system");
    expect(system).toHaveLength(1);
    expect(system[0].userId).toBe(ids.admin);
    expect(system[0].link).toBe("/admin/settings");
  });

  it("Google injoignable au calcul des disponibilités : la réservation échoue (pas de double réservation silencieuse)", async () => {
    googleMock.freeBusy.mockRejectedValue(new Error("ETIMEDOUT"));
    const res = await createAppointment(input());
    expect(res).toEqual({ ok: false, error: "google_error" });
    expect(await testDb.select().from(appointments)).toHaveLength(0);
  });
});

// ── cancelAppointment ────────────────────────────────────────────────────────

async function book(startsAt = SLOT): Promise<string> {
  const res = await createAppointment(input({ startsAt }));
  if (!res.ok) throw new Error(`booking failed: ${res.error}`);
  return res.appointmentId;
}

describe("cancelAppointment", () => {
  it("le propriétaire peut annuler : statut cancelled + appel à Google", async () => {
    const id = await book();
    expect(await cancelAppointment(id)).toEqual({ ok: true });

    const [appt] = await testDb.select().from(appointments).where(eq(appointments.id, id));
    expect(appt.status).toBe("cancelled");
    expect(googleMock.cancelEvent).toHaveBeenCalledTimes(1);
    expect(googleMock.cancelEvent).toHaveBeenCalledWith("gcal_evt_001");

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "appointment.cancel"));
    expect(logs).toHaveLength(1);
    expect(logs[0].entityId).toBe(id);
  });

  it("un admin peut annuler le RDV d'un autre utilisateur", async () => {
    const id = await book();
    await login(ids.admin, "admin");
    expect(await cancelAppointment(id)).toEqual({ ok: true });

    const [appt] = await testDb.select().from(appointments).where(eq(appointments.id, id));
    expect(appt.status).toBe("cancelled");
  });

  it("un autre téléphoniste ne peut PAS annuler", async () => {
    const id = await book();
    await login(ids.otherCaller, "caller");
    expect(await cancelAppointment(id)).toEqual({ ok: false, error: "forbidden" });

    const [appt] = await testDb.select().from(appointments).where(eq(appointments.id, id));
    expect(appt.status).toBe("scheduled");
    expect(googleMock.cancelEvent).not.toHaveBeenCalled();
  });

  it("refuse un appelant non authentifié", async () => {
    const id = await book();
    ctx.token = undefined;
    expect(await cancelAppointment(id)).toEqual({ ok: false, error: "unauthenticated" });
  });

  it("tolère une erreur Google : l'annulation locale a quand même lieu", async () => {
    const id = await book();
    googleMock.cancelEvent.mockRejectedValue(new Error("500 Google down"));

    expect(await cancelAppointment(id)).toEqual({ ok: true });
    const [appt] = await testDb.select().from(appointments).where(eq(appointments.id, id));
    expect(appt.status).toBe("cancelled");
  });

  it("l'annulation ne remet PAS le client hors de la catégorie « RDV » (comportement actuel)", async () => {
    const id = await book();
    await cancelAppointment(id);
    const [client] = await testDb.select().from(clients).where(eq(clients.id, ids.client));
    expect(client.categoryId).toBe(ids.bookedCategoryId);
  });

  it("annulation idempotente et notification aux admins", async () => {
    const id = await book();
    expect(await cancelAppointment(id)).toEqual({ ok: true });
    expect(await cancelAppointment(id)).toEqual({ ok: true });

    expect(googleMock.cancelEvent).toHaveBeenCalledTimes(1);
    const cancelNotifs = await testDb
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, "appointment"), eq(notifications.userId, ids.admin)));
    // 1 création + 1 annulation (la seconde annulation ne renotifie pas).
    expect(cancelNotifs).toHaveLength(2);
  });
});

// ── /api/availability ────────────────────────────────────────────────────────

describe("GET /api/availability", () => {
  it("exige une authentification", async () => {
    ctx.token = undefined;
    const res = await availabilityGET(
      new NextRequest(`http://localhost:3000/api/availability?date=${DAY}&type=meet`),
    );
    expect(res.status).toBe(401);
  });

  it("rejette une date mal formée", async () => {
    const res = await availabilityGET(
      new NextRequest("http://localhost:3000/api/availability?date=10-08-2026&type=meet"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_date" });
  });

  it("respecte le délai minimum et la fenêtre horaire (Toronto)", async () => {
    const { slots } = await availability();
    // Fenêtre 06:00→23:00 Toronto = 10:00Z→03:00Z ; départ ≥ NOW + 45 min.
    expect(slots[0]).toBe("2026-08-10T14:00:00.000Z");
    expect(slots).toContain(SLOT);
    expect(slots.at(-1)).toBe("2026-08-11T02:30:00.000Z");
    expect(slots.some((s) => s < "2026-08-10T13:45:00.000Z")).toBe(false);
  });

  it("retire le créneau réservé (et ses voisins dans la marge)", async () => {
    await book();
    const { slots } = await availability();
    expect(slots).not.toContain(SLOT);
    expect(slots).not.toContain("2026-08-10T14:30:00.000Z");
    expect(slots).not.toContain("2026-08-10T15:30:00.000Z");
    expect(slots).toContain("2026-08-10T14:00:00.000Z");
    expect(slots).toContain("2026-08-10T16:00:00.000Z");
  });

  it("un créneau annulé redevient réservable", async () => {
    const id = await book();
    expect((await availability()).slots).not.toContain(SLOT);

    expect(await cancelAppointment(id)).toEqual({ ok: true });

    const { slots } = await availability();
    expect(slots).toContain(SLOT);
    expect(slots).toContain("2026-08-10T14:30:00.000Z");
    expect(slots).toContain("2026-08-10T15:30:00.000Z");

    // …et il est de nouveau réservable pour de vrai.
    const again = await createAppointment(input({ startsAt: SLOT }));
    expect(again.ok).toBe(true);
    const scheduled = await testDb
      .select()
      .from(appointments)
      .where(eq(appointments.status, "scheduled"));
    expect(scheduled).toHaveLength(1);
  });

  it("soustrait les périodes occupées de Google Agenda", async () => {
    googleMock.freeBusy.mockResolvedValue([
      { start: new Date("2026-08-10T16:00:00.000Z"), end: new Date("2026-08-10T17:00:00.000Z") },
    ]);
    const { slots } = await availability();
    expect(slots).not.toContain("2026-08-10T16:00:00.000Z");
    expect(slots).not.toContain("2026-08-10T16:30:00.000Z");
    expect(slots).toContain("2026-08-10T15:00:00.000Z");
    expect(slots).toContain("2026-08-10T17:30:00.000Z");
  });
});

// ── Réglages de réservation personnalisés ────────────────────────────────────

describe("réglages de réservation (jours, heures, durées, lieu)", () => {
  beforeEach(async () => {
    await setSetting("booking", {
      days: [1, 2, 3, 4, 5], // lundi → vendredi
      startHour: "09:00",
      endHour: "12:00",
      meetDurationMin: 45,
      inPersonDurationMin: 60,
      bufferMin: 0,
      timezone: "America/Toronto",
      inPersonDefaultLocation: "123 rue Principale, Québec",
    });
  });

  it("aucun créneau un jour non réservable (dimanche)", async () => {
    const { slots } = await availability("2026-08-09");
    expect(slots).toEqual([]);
  });

  it("applique la durée du type demandé à la grille", async () => {
    // Fenêtre 09:00→12:00 Toronto = 13:00Z→16:00Z, départ ≥ 13:45Z.
    expect((await availability(DAY, "meet")).slots).toEqual([
      "2026-08-10T14:00:00.000Z",
      "2026-08-10T14:30:00.000Z",
      "2026-08-10T15:00:00.000Z",
    ]);
    expect((await availability(DAY, "inperson")).slots).toEqual([
      "2026-08-10T14:00:00.000Z",
      "2026-08-10T14:30:00.000Z",
      "2026-08-10T15:00:00.000Z",
    ]);
  });

  it("un RDV en personne dure 60 min et hérite du lieu par défaut", async () => {
    const res = await createAppointment(
      input({ type: "inperson", startsAt: "2026-08-10T14:00:00.000Z", location: null }),
    );
    expect(res).toMatchObject({ ok: true, endsAt: "2026-08-10T15:00:00.000Z" });

    const [appt] = await testDb.select().from(appointments);
    expect(appt.type).toBe("inperson");
    expect(appt.location).toBe("123 rue Principale, Québec");
    expect(appt.endsAt.toISOString()).toBe("2026-08-10T15:00:00.000Z");
    expect(googleMock.createBookingEvent.mock.calls[0][0]).toMatchObject({
      type: "inperson",
      location: "123 rue Principale, Québec",
    });

    // Le créneau de 60 min bloque bien les créneaux « meet » chevauchants.
    const { slots } = await availability(DAY, "meet");
    expect(slots).not.toContain("2026-08-10T14:00:00.000Z");
    expect(slots).not.toContain("2026-08-10T14:30:00.000Z");
    expect(slots).toContain("2026-08-10T15:00:00.000Z");
  });

  it("un lieu explicite l'emporte sur le lieu par défaut", async () => {
    await createAppointment(
      input({
        type: "inperson",
        startsAt: "2026-08-10T14:00:00.000Z",
        location: "  7 chemin du Lac  ",
      }),
    );
    const [appt] = await testDb.select().from(appointments);
    expect(appt.location).toBe("7 chemin du Lac");
  });
});
