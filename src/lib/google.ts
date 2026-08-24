import "server-only";
import { randomUUID } from "crypto";
import { google, type calendar_v3 } from "googleapis";
import { z } from "zod";
import { decryptSecret } from "@/lib/crypto";
import { getSetting } from "@/lib/settings";

/**
 * Google Calendar event colour palette (`event.colorId`, values "1".."11").
 * 1 Lavender · 2 Sage · 3 Grape · 4 Flamingo · 5 Banana · 6 Tangerine ·
 * 7 Peacock · 8 Graphite · 9 Blueberry · 10 Basil · 11 Tomato
 * Ref. https://developers.google.com/workspace/calendar/api/v3/reference/colors
 *
 * Le courtier veut repérer le type de rencontre d'un coup d'œil :
 *   visio Google Meet  → jaune  (Banana)
 *   visite en personne → orange (Tangerine)
 */
export const EVENT_COLOR_ID_BY_TYPE = {
  meet: "5", // Banana — jaune
  inperson: "6", // Tangerine — orange
} as const;

/**
 * Signature du courtier, ajoutée à la fin de chaque titre d'évènement.
 * TODO: à terme, lire le nom depuis les réglages (`getSetting("booking")`)
 * plutôt que de le coder en dur ici.
 */
export const BROKER_DISPLAY_NAME = "Alex-Honoré";

/** Prénom = premier mot du nom complet ("" si le nom est vide). */
function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

/**
 * Titre de l'évènement : « 1re Rencontre avec <Prénom> - Alex-Honoré ».
 * Sans prénom exploitable, on retombe sur « 1re Rencontre - Alex-Honoré »
 * (jamais de « undefined » ni de tiret orphelin).
 */
export function bookingEventTitle(clientFullName: string): string {
  const first = firstNameOf(clientFullName);
  return first
    ? `1re Rencontre avec ${first} - ${BROKER_DISPLAY_NAME}`
    : `1re Rencontre - ${BROKER_DISPLAY_NAME}`;
}

/** Thrown when the admin has not connected his Google account yet. */
export class GoogleNotConnectedError extends Error {
  constructor() {
    super("Google Calendar is not connected");
    this.name = "GoogleNotConnectedError";
  }
}

/**
 * Levée quand Google répond 200 à FreeBusy mais signale une erreur POUR le
 * calendrier demandé (`calendars[id].errors`, ex. `notFound` : agenda
 * supprimé, partage retiré, identifiant périmé). Ce n'est PAS une absence de
 * connexion : `computeAvailability` doit la laisser remonter (fail closed)
 * au lieu de prendre la liste `busy` vide pour « toute la journée est libre ».
 */
export class GoogleCalendarUnavailableError extends Error {
  constructor(
    readonly calendarId: string,
    readonly reasons: string[],
  ) {
    super(
      `Google FreeBusy failed for calendar ${calendarId}: ${reasons.length > 0 ? reasons.join(", ") : "missing"}`,
    );
    this.name = "GoogleCalendarUnavailableError";
  }
}

/**
 * Courriel acceptable comme participant d'un évènement Google, ou `null`.
 * `clients.email` est du texte libre (import, webhook, fiche) : « aucun »,
 * « a@x.com, b@y.com » ou une phrase dictée au texteur feraient rejeter TOUT
 * l'évènement par Google (400 « Invalid attendee email ») — on l'écarte plutôt
 * que de perdre l'agenda et le lien Meet.
 */
export function validAttendeeEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return z.email().safeParse(trimmed).success ? trimmed : null;
}

/** Name of the short-lived httpOnly cookie carrying the OAuth state nonce. */
export const GOOGLE_STATE_COOKIE = "google_oauth_state";

/** Scopes: calendar read/write + identity (email shown in the admin settings). */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "openid",
  "email",
];

export function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants");
  }
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/google/callback`;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Build the Google consent URL (offline access → refresh token). */
export function buildConsentUrl(state: string): string {
  return getOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
  });
}

/** Exchange the OAuth code; returns the refresh token + account email. */
export async function exchangeCode(code: string): Promise<{ refreshToken: string; email: string | null }> {
  const auth = getOAuthClient();
  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google n'a pas retourné de refresh_token (retirer l'accès dans le compte Google puis réessayer)");
  }
  auth.setCredentials(tokens);
  const info = await google.oauth2({ version: "v2", auth }).userinfo.get();
  return { refreshToken: tokens.refresh_token, email: info.data.email ?? null };
}

/** Best-effort revocation of the stored refresh token (used on disconnect). */
export async function revokeStoredToken(): Promise<void> {
  try {
    const settings = await getSetting("google");
    if (!settings.refreshTokenEnc) return;
    await getOAuthClient().revokeToken(decryptSecret(settings.refreshTokenEnc));
  } catch {
    // best effort — the setting is cleared regardless
  }
}

/**
 * Authenticated calendar_v3 client on the admin's account.
 * Throws GoogleNotConnectedError when no refresh token is stored.
 */
export async function getAuthedCalendar(): Promise<{
  calendar: calendar_v3.Calendar;
  calendarId: string;
}> {
  const settings = await getSetting("google");
  if (!settings.refreshTokenEnc) throw new GoogleNotConnectedError();
  const auth = getOAuthClient();
  auth.setCredentials({ refresh_token: decryptSecret(settings.refreshTokenEnc) });
  return {
    calendar: google.calendar({ version: "v3", auth }),
    calendarId: settings.calendarId || "primary",
  };
}

export type BusyInterval = { start: Date; end: Date };

/** Busy intervals of the admin's calendar between timeMin and timeMax. */
export async function freeBusy(timeMin: Date, timeMax: Date): Promise<BusyInterval[]> {
  const { calendar, calendarId } = await getAuthedCalendar();
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: calendarId }],
    },
  });
  // Google may key the response by the resolved calendar email instead of "primary".
  const calendars = res.data.calendars ?? {};
  const entry = calendars[calendarId] ?? Object.values(calendars)[0];
  // Google répond 200 même quand il n'a PAS pu calculer l'agenda demandé
  // (`errors: [{ reason: "notFound" }]`, `busy: []`). Une liste vide ici ne
  // veut pas dire « libre » : on échoue, l'appelant ferme la réservation.
  if (!entry || (entry.errors?.length ?? 0) > 0) {
    throw new GoogleCalendarUnavailableError(
      calendarId,
      (entry?.errors ?? []).map((e) => e.reason ?? e.domain ?? "unknown"),
    );
  }
  return (entry.busy ?? [])
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: new Date(b.start as string), end: new Date(b.end as string) }));
}

export type BookingEventInput = {
  type: keyof typeof EVENT_COLOR_ID_BY_TYPE;
  startsAt: Date;
  endsAt: Date;
  /** Nom complet du client — seul le prénom apparaît dans le titre. */
  clientName: string;
  clientEmail?: string | null;
  /**
   * Courriel du courtier (réglages de réservation) — invité comme participant.
   * S'il diffère du compte Google connecté, Google lui envoie une vraie
   * invitation ; s'il EST l'organisateur, l'évènement est déjà sur son agenda.
   */
  brokerEmail?: string | null;
  location?: string | null;
  /** IANA timezone used for the event start/end (booking settings). */
  timezone?: string;
};

export type BookingEventResult = {
  eventId: string;
  meetLink: string | null;
  htmlLink: string | null;
};

/**
 * Participants de l'évènement : client + courtier, dédoublonnés (insensible à
 * la casse). Un courriel client mal formé est IGNORÉ (voir
 * `validAttendeeEmail`) : mieux vaut un évènement sans ce participant que pas
 * d'évènement du tout.
 */
export function bookingEventAttendees(
  clientEmail?: string | null,
  brokerEmail?: string | null,
): { email: string }[] {
  const client = validAttendeeEmail(clientEmail);
  const attendees = client ? [{ email: client }] : [];
  if (brokerEmail && brokerEmail.toLowerCase() !== (client ?? "").toLowerCase()) {
    attendees.push({ email: brokerEmail });
  }
  return attendees;
}

/**
 * Insert the appointment on the admin's calendar.
 * meet → Google Meet conference is created (conferenceDataVersion: 1);
 * inperson → plain event with a location. Invitations are e-mailed (sendUpdates: all).
 *
 * Volontairement SANS description : le courtier consulte la fiche client dans
 * le CRM (un commentaire y consigne la qualification). On omet complètement le
 * champ `description` — l'API le laisse alors vide, ce qui est plus propre
 * qu'une chaîne vide.
 */
export async function createBookingEvent(input: BookingEventInput): Promise<BookingEventResult> {
  const { calendar, calendarId } = await getAuthedCalendar();
  const tz = input.timezone ?? "America/Toronto";

  const attendees = bookingEventAttendees(input.clientEmail, input.brokerEmail);

  const requestBody: calendar_v3.Schema$Event = {
    summary: bookingEventTitle(input.clientName),
    colorId: EVENT_COLOR_ID_BY_TYPE[input.type],
    start: { dateTime: input.startsAt.toISOString(), timeZone: tz },
    end: { dateTime: input.endsAt.toISOString(), timeZone: tz },
    reminders: { useDefault: true },
    ...(attendees.length > 0 ? { attendees } : {}),
    ...(input.type === "meet"
      ? {
          conferenceData: {
            createRequest: {
              requestId: randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : {}),
    ...(input.type === "inperson" && input.location ? { location: input.location } : {}),
  };

  const res = await calendar.events.insert({
    calendarId,
    requestBody,
    conferenceDataVersion: input.type === "meet" ? 1 : 0,
    sendUpdates: "all",
  });

  const meetLink =
    res.data.hangoutLink ??
    res.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    null;

  return {
    eventId: res.data.id ?? "",
    meetLink: input.type === "meet" ? meetLink : null,
    htmlLink: res.data.htmlLink ?? null,
  };
}

/**
 * Delete the event on the admin's calendar (guests are notified).
 *
 * LIMITE CONNUE : `appointments` ne mémorise que `googleEventId`, pas le
 * calendrier où l'évènement a été créé. Si l'admin a changé de calendrier
 * (réglages, ou reconnexion qui remet « primary ») entre la réservation et
 * l'annulation, Google répond 404 sur le calendrier COURANT et l'évènement
 * reste sur l'ancien — les invités ne sont pas prévenus. On le consigne au
 * lieu de le taire ; la vraie correction demande une colonne
 * `appointments.google_calendar_id` (schéma gelé).
 */
export async function cancelEvent(eventId: string): Promise<void> {
  const { calendar, calendarId } = await getAuthedCalendar();
  try {
    await calendar.events.delete({ calendarId, eventId, sendUpdates: "all" });
  } catch (err) {
    // Already deleted on Google's side → treat as success.
    const status = (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
    if (status === 404 || status === 410) {
      console.warn("google event not found on the configured calendar (already deleted, or created on another calendar)", {
        calendarId,
        eventId,
        status,
      });
      return;
    }
    throw err;
  }
}
