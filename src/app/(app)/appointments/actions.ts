"use server";

import { addMinutes } from "date-fns";
import { fr as frLocale, enCA } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { and, eq, gt, lt, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { appointments, categories, clients, comments, notifications, users } from "@/db/schema";
import { diffFields, logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/guards";
import {
  bookingEventTitle,
  cancelEvent,
  createBookingEvent,
  GoogleNotConnectedError,
  validAttendeeEmail,
} from "@/lib/google";
import { formatPhone } from "@/lib/phone";
import { getSetting } from "@/lib/settings";
import { computeAvailability, durationFor } from "@/app/api/availability/slots";
import enBooking from "../../../../messages/en/booking.json";
import frBooking from "../../../../messages/fr/booking.json";
import { notifyCategoryChanged } from "@/lib/campaigns-server/match";

// ── Qualification vocabulary (stored snapshot + CRM comment log) ─────────────

export type Qualification = {
  projectType: "acheter" | "vendre" | "les_deux";
  timing?: "0_3" | "3_6" | "6_12" | "12_plus" | null;
  budget?: "lt_250k" | "250_400k" | "400_600k" | "600_800k" | "800k_1m" | "gt_1m" | null;
  financing?: "oui" | "non" | "en_demarche" | null;
  currentSituation?: "locataire" | "proprietaire" | null;
  sector?: string;
  notes?: string;
};

/**
 * Libellés recopiés dans les colonnes dénormalisées `clients.timing` /
 * `clients.budget` (texte libre affiché tel quel dans la fiche et l'export).
 * Historique : NE PAS modifier sans migrer les lignes existantes.
 */
const TIMING_LABELS: Record<string, string> = {
  "0_3": "0-3 mois",
  "3_6": "3-6 mois",
  "6_12": "6-12 mois",
  "12_plus": "12 mois +",
};
const BUDGET_LABELS: Record<string, string> = {
  lt_250k: "Moins de 250 k$",
  "250_400k": "250 k$ – 400 k$",
  "400_600k": "400 k$ – 600 k$",
  "600_800k": "600 k$ – 800 k$",
  "800k_1m": "800 k$ – 1 M$",
  gt_1m: "1 M$ et plus",
};

/**
 * Libellés EXACTS affichés par le formulaire de réservation. Ils sont lus dans
 * `messages/fr/booking.json` — la même source que
 * `src/components/booking/booking-dialog.tsx` — pour que le commentaire déposé
 * dans la fiche client se lise comme le formulaire rempli par le téléphoniste,
 * sans jamais laisser filtrer un code brut du genre « 12_plus ».
 *
 * Toujours en FR : c'est du contenu persisté et partagé par toute l'équipe, à
 * la manière de `src/components/clients/notification-content.ts` qui importe
 * lui aussi les messages directement (hors contexte de requête).
 */
const FORM_LABELS = {
  project: frBooking.qualification.project,
  timing: frBooking.qualification.timingOptions,
  budget: frBooking.qualification.budgetOptions,
  financing: frBooking.qualification.financingOptions,
  situation: frBooking.qualification.situationOptions,
  type: { meet: frBooking.slot.meet, inperson: frBooking.slot.inperson },
} as const;

/** Lookup tolérant : un code inconnu (donnée héritée) est rendu tel quel. */
function label<K extends string>(map: Record<K, string>, code: string): string {
  return (map as Record<string, string | undefined>)[code] ?? code;
}

/**
 * Textes des notifications « Google Agenda » adressées aux admins, dans la
 * langue du DESTINATAIRE (pas celle de l'auteur) — même principe que
 * `notificationContent` (`src/components/clients/notification-content.ts`),
 * les chaînes vivant ici dans `messages/{fr,en}/booking.json`.
 */
const GOOGLE_NOTIFICATIONS = { fr: frBooking.notifications, en: enBooking.notifications } as const;
type GoogleNotificationKey = keyof typeof GOOGLE_NOTIFICATIONS.fr;

function googleNotificationText(
  locale: "fr" | "en",
  key: GoogleNotificationKey,
  vars: Record<string, string>,
): { title: string; body: string } {
  const entry = GOOGLE_NOTIFICATIONS[locale][key];
  const fill = (text: string) =>
    Object.entries(vars).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, value), text);
  return { title: fill(entry.title), body: fill(entry.body) };
}

/**
 * Champs de la fiche client que la réservation peut réécrire — le journal
 * d'audit consigne l'avant → après (même règle que `clients/actions.ts`).
 */
const BOOKING_CLIENT_AUDIT_FIELDS = [
  "email",
  "projectType",
  "timing",
  "budget",
  "city",
  "categoryId",
] as const;

/** « jeudi 13 août 2026 à 14 h 00 » (fuseau d'affichage de l'équipe). */
function frenchWhen(date: Date, tz: string): string {
  return formatInTimeZone(date, tz, "EEEE d MMMM yyyy 'à' HH 'h' mm", { locale: frLocale });
}

/**
 * Journal déposé dans le fil de commentaires de la fiche client à la
 * réservation. Rédigé en FRANÇAIS : contrairement aux notifications (qui sont
 * écrites par destinataire via `notificationContent`), un commentaire est une
 * ligne unique, partagée par toute l'équipe — le français est la langue de
 * travail. Seules les valeurs renseignées apparaissent.
 */
function bookingCommentBody(args: {
  type: "meet" | "inperson";
  startsAt: Date;
  durationMin: number;
  location: string | null;
  clientEmail: string | null;
  qualification: Qualification;
  timezone: string;
}): string {
  const q = args.qualification;
  const lines = [
    `Rendez-vous fixé — ${FORM_LABELS.type[args.type]}, ${frenchWhen(args.startsAt, args.timezone)} (${args.durationMin} min)`,
    args.type === "inperson" && args.location ? `Lieu : ${args.location}` : null,
    "",
    `Projet : ${label(FORM_LABELS.project, q.projectType)}`,
    q.timing ? `Horizon : ${label(FORM_LABELS.timing, q.timing)}` : null,
    q.budget ? `Budget : ${label(FORM_LABELS.budget, q.budget)}` : null,
    q.financing ? `Financement préapprouvé : ${label(FORM_LABELS.financing, q.financing)}` : null,
    q.currentSituation ? `Situation : ${label(FORM_LABELS.situation, q.currentSituation)}` : null,
    q.sector ? `Secteur : ${q.sector}` : null,
    args.clientEmail ? `Courriel : ${args.clientEmail}` : null,
    q.notes ? `Notes : ${q.notes}` : null,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/**
 * Insertion « meilleur effort » d'un commentaire de journal sur la fiche
 * client. Écrit directement en base (et non via `addCommentAction`) : c'est un
 * journal, il ne doit déclencher AUCUNE notification de mention. Une erreur
 * est journalisée mais n'interrompt jamais la réservation/l'annulation.
 */
async function logClientComment(clientId: string, userId: string, body: string): Promise<void> {
  try {
    await db.insert(comments).values({ clientId, userId, body });
  } catch (err) {
    console.error("booking comment insert failed", err);
  }
}

// ── createAppointment ────────────────────────────────────────────────────────

const qualificationSchema = z.object({
  projectType: z.enum(["acheter", "vendre", "les_deux"]),
  timing: z.enum(["0_3", "3_6", "6_12", "12_plus"]).nullable().optional(),
  budget: z.enum(["lt_250k", "250_400k", "400_600k", "600_800k", "800k_1m", "gt_1m"]).nullable().optional(),
  financing: z.enum(["oui", "non", "en_demarche"]).nullable().optional(),
  currentSituation: z.enum(["locataire", "proprietaire"]).nullable().optional(),
  sector: z.string().max(200).optional().default(""),
  notes: z.string().max(2000).optional().default(""),
});

const createSchema = z.object({
  clientId: z.uuid(),
  type: z.enum(["meet", "inperson"]),
  /** ISO instant, must match a slot returned by /api/availability. */
  startsAt: z.string().min(10),
  location: z.string().max(300).optional().nullable(),
  /** Confirmed/edited client e-mail ("" clears nothing, just skips). */
  email: z.union([z.literal(""), z.email()]).optional().nullable(),
  qualification: qualificationSchema,
});

export type CreateAppointmentInput = z.infer<typeof createSchema>;

export type CreateAppointmentResult =
  | {
      ok: true;
      appointmentId: string;
      startsAt: string;
      endsAt: string;
      meetLink: string | null;
      googleSynced: boolean;
      warning: "google_not_connected" | "google_sync_failed" | null;
    }
  | {
      ok: false;
      error: "unauthenticated" | "invalid" | "not_found" | "slot_taken" | "google_error" | "unknown";
    };

async function notifyAdmins(entry: {
  actorId: string;
  type: "appointment" | "system";
  fr: { title: string; body: string };
  en: { title: string; body: string };
  link: string;
  includeActor?: boolean;
}): Promise<void> {
  const admins = await db.query.users.findMany({
    where: and(eq(users.role, "admin"), eq(users.isActive, true)),
    columns: { id: true, locale: true },
  });
  const rows = admins
    .filter((a) => entry.includeActor || a.id !== entry.actorId)
    .map((a) => ({
      userId: a.id,
      type: entry.type,
      title: a.locale === "en" ? entry.en.title : entry.fr.title,
      body: a.locale === "en" ? entry.en.body : entry.fr.body,
      link: entry.link,
    }));
  if (rows.length > 0) await db.insert(notifications).values(rows);
}

export async function createAppointment(input: CreateAppointmentInput): Promise<CreateAppointmentResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const data = parsed.data;

  const startsAt = new Date(data.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { ok: false, error: "invalid" };

  const client = await db.query.clients.findFirst({ where: eq(clients.id, data.clientId) });
  if (!client) return { ok: false, error: "not_found" };

  const settings = await getSetting("booking");
  const tz = settings.timezone || "America/Toronto";
  const duration = durationFor(settings, data.type);
  const endsAt = addMinutes(startsAt, duration);

  // ── Server-side re-validation: the slot must still be free right now. ──
  try {
    const dateStr = formatInTimeZone(startsAt, tz, "yyyy-MM-dd");
    const availability = await computeAvailability(dateStr, data.type);
    if (!availability.slots.includes(startsAt.toISOString())) {
      return { ok: false, error: "slot_taken" };
    }
  } catch (err) {
    console.error("availability recheck failed", err);
    return { ok: false, error: "google_error" };
  }

  const newEmail = data.email ? data.email.trim().toLowerCase() : null;
  // Repli sur le courriel de la fiche SEULEMENT s'il est exploitable : une
  // valeur libre (« aucun », deux adresses…) ferait rejeter l'évènement par
  // Google — on réserve alors sans ce participant plutôt que sans agenda.
  const clientEmail = newEmail ?? validAttendeeEmail(client.email);
  const location =
    data.type === "inperson"
      ? data.location?.trim() || settings.inPersonDefaultLocation || client.address || null
      : null;
  const qualification: Qualification = data.qualification;

  // ── Insert under an advisory lock so two callers cannot grab the same slot. ──
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
          userId: user.id,
          type: data.type,
          // Même libellé que l'événement Google, pour que le CRM et l'agenda concordent.
          title: bookingEventTitle(client.fullName),
          startsAt,
          endsAt,
          location,
          status: "scheduled",
          qualification,
          notes: qualification.notes || null,
        })
        .returning({ id: appointments.id });
      return row.id;
    });
  } catch (err) {
    if (err instanceof SlotTakenError) return { ok: false, error: "slot_taken" };
    console.error("appointment insert failed", err);
    return { ok: false, error: "unknown" };
  }

  // ── Google Calendar event (outside the tx — external call). ──
  let meetLink: string | null = null;
  let googleEventId: string | null = null;
  let warning: "google_not_connected" | "google_sync_failed" | null = null;
  try {
    const event = await createBookingEvent({
      type: data.type,
      startsAt,
      endsAt,
      clientName: client.fullName,
      clientEmail,
      brokerEmail: settings.brokerEmail || null,
      location,
      timezone: tz,
    });
    googleEventId = event.eventId || null;
    meetLink = event.meetLink;
    await db
      .update(appointments)
      .set({ googleEventId, meetLink })
      .where(eq(appointments.id, appointmentId));
  } catch (err) {
    warning = err instanceof GoogleNotConnectedError ? "google_not_connected" : "google_sync_failed";
    if (warning === "google_sync_failed") console.error("google event creation failed", err);
  }

  // ── Update the client record. ──
  const bookedCategory = await db.query.categories.findFirst({ where: eq(categories.key, "booked") });
  const clientPatch = {
    qualification,
    ...(newEmail && newEmail !== client.email ? { email: newEmail } : {}),
    projectType: qualification.projectType,
    ...(qualification.timing ? { timing: TIMING_LABELS[qualification.timing] } : {}),
    ...(qualification.budget ? { budget: BUDGET_LABELS[qualification.budget] } : {}),
    ...(qualification.sector ? { city: qualification.sector } : {}),
    ...(bookedCategory ? { categoryId: bookedCategory.id } : {}),
  };
  await db
    .update(clients)
    .set({ ...clientPatch, updatedAt: new Date() })
    .where(eq(clients.id, client.id));
  if (bookedCategory) notifyCategoryChanged(client.id, client.categoryId, bookedCategory.id);

  // La réservation réécrit la fiche (courriel, catégorie, projet…) : elle
  // laisse la même trace avant → après qu'une modification depuis la fiche.
  const clientChanges = diffFields(client, { ...client, ...clientPatch }, BOOKING_CLIENT_AUDIT_FIELDS);
  if (clientChanges) {
    await logAudit({
      userId: user.id,
      action: "client.update",
      entity: "client",
      entityId: client.id,
      detail: {
        fullName: client.fullName,
        phone: client.phone,
        via: "booking",
        appointmentId,
        changes: clientChanges,
      },
    });
  }

  // ── Journal dans le fil de commentaires (le courtier le relit plus tard). ──
  await logClientComment(
    client.id,
    user.id,
    bookingCommentBody({
      type: data.type,
      startsAt,
      durationMin: duration,
      location,
      clientEmail,
      qualification,
      timezone: tz,
    }),
  );

  await logAudit({
    userId: user.id,
    action: "appointment.create",
    entity: "appointment",
    entityId: appointmentId,
    detail: {
      clientId: client.id,
      type: data.type,
      startsAt: startsAt.toISOString(),
      googleEventId,
      googleSynced: googleEventId !== null,
    },
  });

  // ── Notify the admin(s). ──
  const whenFr = formatInTimeZone(startsAt, tz, "d MMM yyyy 'à' HH 'h' mm", { locale: frLocale });
  const whenEn = formatInTimeZone(startsAt, tz, "MMM d, yyyy 'at' h:mm a", { locale: enCA });
  await notifyAdmins({
    actorId: user.id,
    type: "appointment",
    fr: { title: "Nouveau rendez-vous", body: `${client.fullName} (${formatPhone(client.phone)}) — ${whenFr}` },
    en: { title: "New appointment", body: `${client.fullName} (${formatPhone(client.phone)}) — ${whenEn}` },
    link: "/appointments",
  });
  if (warning) {
    // Deux causes, deux remèdes : « non connecté » → Réglages ; « échec de
    // synchronisation » (compte connecté, mais Google a refusé l'évènement) →
    // vérifier la fiche / ajouter l'évènement à la main. Dire au courtier de
    // reconnecter un compte qui l'est déjà l'enverrait sur une fausse piste.
    const key = warning === "google_not_connected" ? "googleNotConnected" : "googleSyncFailed";
    await notifyAdmins({
      actorId: user.id,
      type: "system",
      includeActor: true,
      fr: googleNotificationText("fr", key, { name: client.fullName, when: whenFr }),
      en: googleNotificationText("en", key, { name: client.fullName, when: whenEn }),
      link: warning === "google_not_connected" ? "/admin/settings" : "/appointments",
    });
  }

  revalidatePath("/appointments");
  revalidatePath(`/clients/${client.id}`);

  return {
    ok: true,
    appointmentId,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    meetLink,
    googleSynced: googleEventId !== null,
    warning,
  };
}

class SlotTakenError extends Error {
  constructor() {
    super("slot taken");
    this.name = "SlotTakenError";
  }
}

// ── cancelAppointment ────────────────────────────────────────────────────────

export type CancelAppointmentResult =
  | { ok: true }
  | { ok: false; error: "unauthenticated" | "not_found" | "forbidden" | "unknown" };

export async function cancelAppointment(appointmentId: string): Promise<CancelAppointmentResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (!z.uuid().safeParse(appointmentId).success) return { ok: false, error: "not_found" };

  const appt = await db.query.appointments.findFirst({
    where: eq(appointments.id, appointmentId),
    with: { client: { columns: { id: true, fullName: true } } },
  });
  if (!appt) return { ok: false, error: "not_found" };

  // Owner (the caller who booked it) or admin only.
  if (user.role !== "admin" && appt.userId !== user.id) {
    return { ok: false, error: "forbidden" };
  }
  if (appt.status === "cancelled") return { ok: true };

  // Best effort on the Google side — local cancellation always proceeds.
  if (appt.googleEventId) {
    try {
      await cancelEvent(appt.googleEventId);
    } catch (err) {
      console.error("google event cancellation failed", err);
    }
  }

  try {
    await db
      .update(appointments)
      .set({ status: "cancelled" })
      .where(and(eq(appointments.id, appt.id), ne(appointments.status, "cancelled")));
  } catch (err) {
    console.error("appointment cancellation failed", err);
    return { ok: false, error: "unknown" };
  }

  await logAudit({
    userId: user.id,
    action: "appointment.cancel",
    entity: "appointment",
    entityId: appt.id,
    detail: {
      clientId: appt.clientId,
      startsAt: appt.startsAt.toISOString(),
      googleEventId: appt.googleEventId,
    },
  });

  const settings = await getSetting("booking");
  const tz = settings.timezone || "America/Toronto";
  const whenFr = formatInTimeZone(appt.startsAt, tz, "d MMM yyyy 'à' HH 'h' mm", { locale: frLocale });
  const whenEn = formatInTimeZone(appt.startsAt, tz, "MMM d, yyyy 'at' h:mm a", { locale: enCA });

  // ── Journal dans le fil de commentaires (même règle « meilleur effort »). ──
  await logClientComment(
    appt.clientId,
    user.id,
    `Rendez-vous annulé — ${FORM_LABELS.type[appt.type]}, ${frenchWhen(appt.startsAt, tz)}`,
  );

  await notifyAdmins({
    actorId: user.id,
    type: "appointment",
    fr: { title: "Rendez-vous annulé", body: `${appt.client.fullName} — ${whenFr}` },
    en: { title: "Appointment cancelled", body: `${appt.client.fullName} — ${whenEn}` },
    link: "/appointments",
  });

  revalidatePath("/appointments");
  revalidatePath(`/clients/${appt.clientId}`);
  return { ok: true };
}
