import "server-only";

/**
 * Implémentation RÉELLE de `BookingProvider`, adossée au système de
 * réservation existant du CRM (Google Agenda + `appointments`) — l'opérateur
 * a choisi de NE PAS utiliser Cal.com : l'agent SMS réserve exactement là où
 * réservent déjà les téléphonistes.
 *
 * Pourquoi ce fichier n'appelle PAS `createAppointment`
 * (`src/app/(app)/appointments/actions.ts`) directement : cette action est
 * une Server Action couplée à une session HTTP — elle commence par
 * `getCurrentUser()`, qui lit le cookie `nexus_session` via `next/headers`.
 * L'agent SMS tourne hors requête (dispatcher/cron, `runTurn` dans
 * `lib/agent/runtime.ts`) : il n'existe AUCUNE session à lire. Reproduire
 * `createAppointment` ici est donc la bonne route — pas une duplication de
 * confort — et on reprend EXACTEMENT son verrou consultatif (874511) et sa
 * fenêtre de chevauchement (tampon des réglages) pour que les deux chemins de
 * réservation (humain et agent) ne puissent jamais double-réserver un
 * créneau. Le rendez-vous Google est créé de la même façon, HORS transaction,
 * en best-effort.
 */
import { addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointments, categories, clients, users } from "@/db/schema";
import { computeAvailability, durationFor } from "@/app/api/availability/slots";
import { logAudit } from "@/lib/audit";
import { bookingEventTitle, createBookingEvent, GoogleNotConnectedError } from "@/lib/google";
import { getSetting } from "@/lib/settings";
import { notifyCategoryChanged } from "@/lib/campaigns-server/match";
import {
  formatSlotLabel,
  type BookInput,
  type BookResult,
  type BookingProvider,
  type BookingSlot,
  type GetSlotsInput,
  type GetSlotsResult,
} from "./provider";

/** Nombre de jours explorés avant d'abandonner (le brief : 14 jours). */
const MAX_LOOKAHEAD_DAYS = 14;

/**
 * Disponibilités RÉELLES du courtier, en avançant jour par jour (chaînes de
 * date Toronto) à partir d'aujourd'hui (ou `fromIso`), jusqu'à réunir `count`
 * créneaux ou épuiser `MAX_LOOKAHEAD_DAYS`.
 *
 * GARANTIE CRITIQUE : `computeAvailability` dégrade silencieusement en
 * « données locales seulement » quand le compte Google Agenda du courtier
 * n'est PAS connecté (`googleConnected: false`) — et renvoie quand même des
 * créneaux, calculés sans savoir ce qui est réellement occupé sur l'agenda
 * du courtier. C'est le bon comportement pour un ÉCRAN consulté par un
 * humain (le téléphoniste voit l'avertissement), mais un texteur AUTONOME ne
 * doit JAMAIS proposer une heure dans ces conditions : il enverrait une
 * confirmation qui engage le courtier sans que personne ne l'ait vérifié.
 * Dès qu'un jour de la fenêtre revient déconnecté, on renvoie donc
 * IMMÉDIATEMENT `{ slots: [], googleConnected: false }` — y compris les
 * créneaux déjà accumulés les jours précédents sont abandonnés, pour ne
 * jamais mélanger une offre « de confiance » avec une offre « à l'aveugle ».
 *
 * Une panne Google RÉELLE (réseau, quota…) plutôt qu'une simple absence de
 * connexion fait ÉCHOUER `computeAvailability` (fail closed, voir
 * `src/app/api/availability/slots.ts`) : cette fonction ne l'attrape PAS et
 * laisse l'exception remonter — à l'appelant (voir `lib/agent/runtime.ts`)
 * de décider quoi faire (aujourd'hui : ne proposer aucune heure).
 */
async function getSlots(input: GetSlotsInput): Promise<GetSlotsResult> {
  const settings = await getSetting("booking");
  const tz = settings.timezone || "America/Toronto";

  const requested = input.fromIso ? new Date(input.fromIso) : new Date();
  const anchorInstant = Number.isNaN(requested.getTime()) ? new Date() : requested;
  // Chaîne de date Toronto de départ ; toute la suite avance cette CHAÎNE,
  // jamais l'instant (arithmétique calendaire pure — même précaution que
  // `computeAvailability`), pour ne jamais glisser d'un jour autour d'un
  // changement d'heure.
  const anchorDateStr = formatInTimeZone(anchorInstant, tz, "yyyy-MM-dd");
  const anchorMidnightUtc = new Date(`${anchorDateStr}T00:00:00Z`);

  const slots: BookingSlot[] = [];
  for (let i = 0; i < MAX_LOOKAHEAD_DAYS && slots.length < input.count; i++) {
    const dateStr = new Date(anchorMidnightUtc.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const availability = await computeAvailability(dateStr, input.type);

    if (!availability.googleConnected) {
      return { slots: [], googleConnected: false };
    }

    for (const iso of availability.slots) {
      if (slots.length >= input.count) break;
      slots.push({ iso, label: formatSlotLabel(new Date(iso), tz) });
    }
  }

  return { slots, googleConnected: true };
}

/** Même erreur de contrôle de concurrence que `createAppointment`. */
class SlotTakenError extends Error {
  constructor() {
    super("créneau déjà réservé");
    this.name = "SlotTakenError";
  }
}

/**
 * Utilisateur du CRM à qui rattacher un rendez-vous réservé par l'agent
 * (`appointments.user_id`, NOT NULL — aucune session n'existe dans ce
 * contexte). Priorité au téléphoniste déjà assigné au client ; à défaut, le
 * premier admin actif (le courtier lui-même, en pratique — c'est en son nom
 * que l'agent réserve). `null` si vraiment personne n'existe : la
 * réservation est alors refusée (`not_bookable`) plutôt que de violer la
 * contrainte NOT NULL.
 */
async function resolveOwnerId(assignedToId: string | null): Promise<string | null> {
  if (assignedToId) {
    // L'assigne doit etre ACTIF : un rendez-vous attribue a un telephoniste
    // desactive n'apparait sur le tableau de personne.
    const assignee = await db.query.users.findFirst({
      where: and(eq(users.id, assignedToId), eq(users.isActive, true)),
      columns: { id: true },
    });
    if (assignee) return assignee.id;
  }
  const admin = await db.query.users.findFirst({
    where: and(eq(users.role, "admin"), eq(users.isActive, true)),
    orderBy: asc(users.createdAt),
  });
  return admin?.id ?? null;
}

/**
 * Réserve le rendez-vous — revalidation, insertion sous verrou consultatif,
 * évènement Google en best-effort, bascule du client en catégorie « booked ».
 * Voir le commentaire d'en-tête du fichier pour le choix de ne PAS appeler
 * `createAppointment`.
 */
async function book(input: BookInput): Promise<BookResult> {
  const startsAt = new Date(input.slotIso);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: "invalid_slot" };

  const client = await db.query.clients.findFirst({ where: eq(clients.id, input.clientId) });
  if (!client) return { ok: false, error: "not_bookable" };

  const ownerId = await resolveOwnerId(client.assignedToId);
  if (!ownerId) return { ok: false, error: "not_bookable" };

  const settings = await getSetting("booking");
  const tz = settings.timezone || "America/Toronto";
  const duration = durationFor(settings, input.type);
  const endsAt = addMinutes(startsAt, duration);

  // ── Revalidation : le créneau offert peut dater de plusieurs échanges SMS
  // — il doit être ENCORE libre maintenant. Un Google qui vient de se
  // déconnecter ENTRE l'offre et la confirmation est traité comme une panne
  // (`google_error`), jamais comme une disponibilité locale : on ne réserve
  // jamais à l'aveugle (même garantie que `getSlots`).
  let availability: Awaited<ReturnType<typeof computeAvailability>>;
  try {
    const dateStr = formatInTimeZone(startsAt, tz, "yyyy-MM-dd");
    availability = await computeAvailability(dateStr, input.type);
  } catch (err) {
    console.error("[booking/internal] revalidation de la disponibilité impossible", err);
    return { ok: false, error: "google_error" };
  }
  if (!availability.googleConnected) return { ok: false, error: "google_error" };
  if (!availability.slots.includes(startsAt.toISOString())) {
    return { ok: false, error: "slot_taken" };
  }

  const newEmail = input.email?.trim().toLowerCase() || null;
  const clientEmail = newEmail ?? client.email;
  const location =
    input.type === "inperson" ? settings.inPersonDefaultLocation || client.address || null : null;

  // ── Insertion sous le MÊME verrou consultatif (874511) et la MÊME fenêtre
  // de chevauchement (tampon des réglages) que `createAppointment` : deux
  // réservations concurrentes sur le même créneau — agent contre agent, ou
  // agent contre téléphoniste — ne peuvent jamais toutes les deux réussir.
  let appointmentId: string;
  try {
    appointmentId = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(874511)`);
      const bufferMs = settings.bufferMin * 60_000;
      const conflicts = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.status, "scheduled"),
            lt(appointments.startsAt, new Date(endsAt.getTime() + bufferMs)),
            gt(appointments.endsAt, new Date(startsAt.getTime() - bufferMs)),
          ),
        )
        .limit(1);
      if (conflicts.length > 0) throw new SlotTakenError();

      const [row] = await tx
        .insert(appointments)
        .values({
          clientId: client.id,
          userId: ownerId,
          type: input.type,
          // Même libellé que la réservation manuelle, pour que le CRM et
          // l'agenda concordent.
          title: bookingEventTitle(client.fullName),
          startsAt,
          endsAt,
          location,
          status: "scheduled",
          // Traçabilité : on retrouve le fil SMS d'origine depuis la fiche
          // client (le brief demande notes OU qualification — les deux ici,
          // l'un lisible tel quel, l'autre exploitable par programme).
          qualification: { source: "sms_agent", conversationId: input.conversationId },
          notes: `Réservé automatiquement par l'agent SMS (conversation ${input.conversationId}).`,
        })
        .returning({ id: appointments.id });
      return row.id;
    });
  } catch (err) {
    if (err instanceof SlotTakenError) return { ok: false, error: "slot_taken" };
    console.error("[booking/internal] insertion du rendez-vous échouée", err);
    return { ok: false, error: "not_bookable" };
  }

  // ── Évènement Google Agenda — HORS transaction (appel réseau externe),
  // en best-effort EXACTEMENT comme `createAppointment` : un échec ici ne
  // fait jamais perdre le rendez-vous déjà persisté (`googleEventId` reste
  // `null`, le CRM reste la source de vérité).
  try {
    const event = await createBookingEvent({
      type: input.type,
      startsAt,
      endsAt,
      clientName: client.fullName,
      clientEmail,
      brokerEmail: settings.brokerEmail || null,
      location,
      timezone: tz,
    });
    await db
      .update(appointments)
      .set({ googleEventId: event.eventId || null, meetLink: event.meetLink })
      .where(eq(appointments.id, appointmentId));
  } catch (err) {
    if (!(err instanceof GoogleNotConnectedError)) {
      console.error("[booking/internal] création de l'évènement Google échouée", err);
    }
  }

  // ── Bascule le client en catégorie « booked » (même comportement que la
  // réservation manuelle) et confirme le courriel recueilli, le cas échéant.
  const bookedCategory = await db.query.categories.findFirst({ where: eq(categories.key, "booked") });
  await db
    .update(clients)
    .set({
      ...(newEmail && newEmail !== client.email ? { email: newEmail } : {}),
      ...(bookedCategory ? { categoryId: bookedCategory.id } : {}),
      updatedAt: new Date(),
    })
    .where(eq(clients.id, client.id));
  // Le passage en « Rendez-vous » est un changement de catégorie comme un
  // autre : les campagnes « changement de catégorie » doivent le voir.
  if (bookedCategory) notifyCategoryChanged(client.id, client.categoryId, bookedCategory.id);

  await logAudit({
    userId: ownerId,
    action: "appointment.create",
    entity: "appointment",
    entityId: appointmentId,
    detail: {
      clientId: client.id,
      type: input.type,
      startsAt: startsAt.toISOString(),
      conversationId: input.conversationId,
      source: "sms_agent",
    },
  });

  return { ok: true, appointmentId, startsAtIso: startsAt.toISOString() };
}

/** Fabrique — c'est cette implémentation que `lib/agent/runtime.ts` consomme. */
export function getInternalBookingProvider(): BookingProvider {
  return { getSlots, book };
}
