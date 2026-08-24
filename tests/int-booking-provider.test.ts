/**
 * Intégration (structure) — BookingProvider interne (src/lib/booking/internal.ts).
 *
 * Mêmes fixtures et doublures que tests/int-booking.test.ts (le pendant
 * « réservation manuelle » de createAppointment) : seule la couche Google
 * (réseau externe) est simulée. Écrit pour COMPILER et documenter le contrat
 * attendu de `getInternalBookingProvider()` — NON EXÉCUTÉ ici : l'orchestrateur
 * fait tourner les tests de base de données en série, en dehors de cette
 * tâche.
 */
import { randomUUID } from "crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// ── Stubs d'environnement Next (aucune logique produit n'est simulée) ────────
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
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

vi.mock("@/lib/google", async (importOriginal) => {
  // Les helpers purs (titre, palette de couleurs) restent RÉELS : seul le
  // réseau Google est simulé — même doublure que tests/int-booking.test.ts.
  const actual = await importOriginal<typeof import("@/lib/google")>();
  return {
    ...actual,
    GoogleNotConnectedError: googleMock.GoogleNotConnectedError,
    createBookingEvent: googleMock.createBookingEvent,
    cancelEvent: googleMock.cancelEvent,
    freeBusy: googleMock.freeBusy,
  };
});

// ── Imports produit (après les mocks) ────────────────────────────────────────

import { getInternalBookingProvider } from "@/lib/booking/internal";
import { appointments, auditLogs, clients } from "@/db/schema";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";

/** Lundi 10 août 2026, 09 h 00 à Toronto (EDT, UTC-4) — même ancrage que int-booking.test.ts. */
const NOW = new Date("2026-08-10T13:00:00.000Z");
/** 11 h 00 Toronto — sur la grille de 30 min et > NOW + 45 min. */
const SLOT = "2026-08-10T15:00:00.000Z";
/** 14 h 00 Toronto — un second créneau valide, distinct de SLOT. */
const SLOT_B = "2026-08-10T18:00:00.000Z";

type Ids = {
  admin: string;
  client: string;
  conversationId: string;
  bookedCategoryId: number;
};

let ids: Ids;

const booking = getInternalBookingProvider();
const { getSetting, setSetting } = await import("@/lib/settings");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();

  googleMock.freeBusy.mockResolvedValue([]);
  googleMock.createBookingEvent.mockResolvedValue({
    eventId: "gcal_evt_sms_001",
    meetLink: "https://meet.google.com/sms-agent",
    htmlLink: "https://calendar.google.com/event?eid=sms",
  });

  await resetDb();
  const cats = await seedSystemCategories();
  const admin = await makeUser({ name: "Admin Nexus", role: "admin", email: "admin@nexus.test" });
  const client = await makeClient({
    fullName: "Marie Tremblay",
    phone: "+14184761542",
    email: "ancien@exemple.ca",
    categoryId: cats.new.id,
    // Aucun téléphoniste assigné : resolveOwnerId doit retomber sur l'admin.
    assignedToId: null,
  });
  const smsNumber = await makeSmsNumber({});
  const conversation = await makeConversation({ clientId: client.id, smsNumberId: smsNumber.id });

  ids = {
    admin: admin.id,
    client: client.id,
    conversationId: conversation.id,
    bookedCategoryId: cats.booked.id,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});

// ── getSlots ─────────────────────────────────────────────────────────────────

describe("BookingProvider interne — getSlots", () => {
  it("renvoie des créneaux réels avec un libellé français", async () => {
    const { slots, googleConnected } = await booking.getSlots({ type: "meet", count: 2 });
    expect(googleConnected).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(2);
    // Même grille que /api/availability (voir tests/int-booking.test.ts) :
    // fenêtre 06:00→23:00 Toronto, départ ≥ NOW + 45 min ⇒ premier créneau
    // à 10:00 Toronto (14:00Z).
    expect(slots[0].iso).toBe("2026-08-10T14:00:00.000Z");
    expect(slots[0].label).toBe("lundi 10 h");
  });

  it("« fin de semaine » rend des créneaux de fin de semaine, pas les premiers libres", async () => {
    // Le bogue signalé : get_slots rendait toujours les MÊMES premiers
    // créneaux, donc « je peux juste la fin de semaine » s'entendait répondre
    // qu'il n'y a rien la fin de semaine — alors que le samedi était ouvert.
    const { slots, preferenceUnavailable } = await booking.getSlots({
      type: "meet",
      count: 2,
      preference: "weekend",
    });
    expect(preferenceUnavailable).toBeUndefined();
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.label).toMatch(/samedi|dimanche/);
    }
  });

  it("« le matin » ne rend que des heures avant midi", async () => {
    const { slots } = await booking.getSlots({ type: "meet", count: 3, preference: "morning" });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const hour = Number(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Toronto",
          hour: "numeric",
          hour12: false,
        }).format(new Date(slot.iso)),
      );
      expect(hour).toBeLessThan(12);
    }
  });

  it("une contrainte impossible est ANNONCÉE, avec un repli — jamais un agenda faussement vide", async () => {
    // Installation ouverte du lundi au vendredi seulement.
    await setSetting("booking", { ...(await getSetting("booking")), days: [1, 2, 3, 4, 5] });
    const { slots, preferenceUnavailable } = await booking.getSlots({
      type: "meet",
      count: 2,
      preference: "weekend",
    });
    expect(preferenceUnavailable).toBe(true);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(slot.label).not.toMatch(/samedi|dimanche/);
  });

  it("Google Agenda déconnecté : ne propose AUCUNE heure (jamais à l'aveugle)", async () => {
    googleMock.freeBusy.mockRejectedValue(new googleMock.GoogleNotConnectedError());
    const result = await booking.getSlots({ type: "meet", count: 2 });
    expect(result).toEqual({ slots: [], googleConnected: false });
  });
});

// ── book ─────────────────────────────────────────────────────────────────────

describe("BookingProvider interne — book", () => {
  it("crée le rendez-vous et bascule le client en catégorie « booked »", async () => {
    const result = await booking.book({
      clientId: ids.client,
      conversationId: ids.conversationId,
      type: "meet",
      slotIso: SLOT,
      email: "confirme@exemple.ca",
    });
    expect(result).toMatchObject({ ok: true, startsAtIso: SLOT });
    if (!result.ok) throw new Error("booking failed");

    const [appt] = await testDb
      .select()
      .from(appointments)
      .where(eq(appointments.id, result.appointmentId));
    expect(appt).toBeDefined();
    expect(appt.clientId).toBe(ids.client);
    // Aucun téléphoniste assigné au client → repli sur le premier admin actif.
    expect(appt.userId).toBe(ids.admin);
    expect(appt.status).toBe("scheduled");
    expect(appt.googleEventId).toBe("gcal_evt_sms_001");
    expect(appt.meetLink).toBe("https://meet.google.com/sms-agent");
    // Traçabilité vers le fil SMS d'origine (notes ET qualification).
    expect(appt.qualification).toMatchObject({
      conversationId: ids.conversationId,
      source: "sms_agent",
    });
    expect(appt.notes).toContain(ids.conversationId);

    const [client] = await testDb.select().from(clients).where(eq(clients.id, ids.client));
    expect(client.categoryId).toBe(ids.bookedCategoryId);
    expect(client.email).toBe("confirme@exemple.ca");
  });

  it.each(["jean point tremblay arobase gmail", "pas de courriel", "Mon courriel c'est marie@exemple.ca merci"])(
    "un courriel dicté au modèle mais invalide (« %s ») n'est ni stocké ni envoyé à Google",
    async (junk) => {
      const result = await booking.book({
        clientId: ids.client,
        conversationId: ids.conversationId,
        type: "meet",
        slotIso: SLOT,
        email: junk,
      });
      expect(result.ok).toBe(true);

      // Le rendez-vous part quand même sur l'agenda (sans participant client
      // plutôt que pas d'évènement du tout), avec le courriel VALIDE de la fiche.
      expect(googleMock.createBookingEvent).toHaveBeenCalledTimes(1);
      expect(googleMock.createBookingEvent.mock.calls[0][0].clientEmail).toBe("ancien@exemple.ca");

      // `clients.email` n'est jamais écrasé par autre chose qu'une adresse.
      const [client] = await testDb.select().from(clients).where(eq(clients.id, ids.client));
      expect(client.email).toBe("ancien@exemple.ca");
      expect(client.categoryId).toBe(ids.bookedCategoryId);
    },
  );

  it("un courriel de fiche mal formé n'est pas envoyé à Google non plus", async () => {
    await testDb.update(clients).set({ email: "aucun" }).where(eq(clients.id, ids.client));
    const result = await booking.book({
      clientId: ids.client,
      conversationId: ids.conversationId,
      type: "meet",
      slotIso: SLOT,
    });
    expect(result.ok).toBe(true);
    expect(googleMock.createBookingEvent.mock.calls[0][0].clientEmail).toBeNull();
  });

  it("journalise la réécriture de la fiche (courriel, catégorie) en client.update, au nom du propriétaire du RDV", async () => {
    const result = await booking.book({
      clientId: ids.client,
      conversationId: ids.conversationId,
      type: "meet",
      slotIso: SLOT,
      email: "confirme@exemple.ca",
    });
    if (!result.ok) throw new Error("booking failed");

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "client.update"));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(ids.admin);
    expect(logs[0].entity).toBe("client");
    expect(logs[0].entityId).toBe(ids.client);
    const detail = logs[0].detail as {
      via: string;
      appointmentId: string;
      conversationId: string;
      changes: Record<string, { from: unknown; to: unknown }>;
    };
    expect(detail.via).toBe("sms_agent");
    expect(detail.appointmentId).toBe(result.appointmentId);
    expect(detail.conversationId).toBe(ids.conversationId);
    expect(detail.changes.email).toEqual({ from: "ancien@exemple.ca", to: "confirme@exemple.ca" });
    expect(detail.changes.categoryId.to).toBe(ids.bookedCategoryId);
  });

  it("Google indisponible : le rendez-vous est quand même créé (googleEventId reste null)", async () => {
    googleMock.createBookingEvent.mockRejectedValue(new Error("503 backend error"));
    const result = await booking.book({
      clientId: ids.client,
      conversationId: ids.conversationId,
      type: "meet",
      slotIso: SLOT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("booking failed");

    const [appt] = await testDb
      .select()
      .from(appointments)
      .where(eq(appointments.id, result.appointmentId));
    expect(appt.status).toBe("scheduled");
    expect(appt.googleEventId).toBeNull();
  });

  it("un créneau déjà réservé renvoie slot_taken (aucun doublon)", async () => {
    const first = await booking.book({
      clientId: ids.client,
      conversationId: ids.conversationId,
      type: "meet",
      slotIso: SLOT_B,
    });
    expect(first.ok).toBe(true);

    const second = await booking.book({
      clientId: ids.client,
      // Un même client peut avoir plusieurs fils ; l'id ci-dessous n'a pas
      // besoin de référencer une conversation existante — book() ne fait que
      // le stocker tel quel pour la traçabilité.
      conversationId: randomUUID(),
      type: "meet",
      slotIso: SLOT_B,
    });
    expect(second).toEqual({ ok: false, error: "slot_taken" });

    const rows = await testDb
      .select()
      .from(appointments)
      .where(eq(appointments.status, "scheduled"));
    expect(rows).toHaveLength(1);
  });

  it("créneau ISO invalide : invalid_slot, rien n'est écrit", async () => {
    const result = await booking.book({
      clientId: ids.client,
      conversationId: ids.conversationId,
      type: "meet",
      slotIso: "ceci n'est pas une date",
    });
    expect(result).toEqual({ ok: false, error: "invalid_slot" });
    expect(await testDb.select().from(appointments)).toHaveLength(0);
  });

  it("client introuvable : not_bookable", async () => {
    const result = await booking.book({
      clientId: "00000000-0000-4000-8000-000000000000",
      conversationId: ids.conversationId,
      type: "meet",
      slotIso: SLOT,
    });
    expect(result).toEqual({ ok: false, error: "not_bookable" });
  });
});
