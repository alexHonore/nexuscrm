import "server-only";
import { randomUUID } from "crypto";
import { google, type calendar_v3 } from "googleapis";
import { decryptSecret } from "@/lib/crypto";
import { formatPhone } from "@/lib/phone";
import { getSetting } from "@/lib/settings";

/** Thrown when the admin has not connected his Google account yet. */
export class GoogleNotConnectedError extends Error {
  constructor() {
    super("Google Calendar is not connected");
    this.name = "GoogleNotConnectedError";
  }
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
  return (entry?.busy ?? [])
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: new Date(b.start as string), end: new Date(b.end as string) }));
}

export type BookingEventInput = {
  type: "meet" | "inperson";
  startsAt: Date;
  endsAt: Date;
  clientName: string;
  clientPhone: string;
  clientEmail?: string | null;
  callerName: string;
  qualificationSummary?: string | null;
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
 * Insert the appointment on the admin's calendar.
 * meet → Google Meet conference is created (conferenceDataVersion: 1);
 * inperson → plain event with a location. Invitations are e-mailed (sendUpdates: all).
 */
export async function createBookingEvent(input: BookingEventInput): Promise<BookingEventResult> {
  const { calendar, calendarId } = await getAuthedCalendar();
  const tz = input.timezone ?? "America/Toronto";

  const descriptionLines = [
    `Client : ${input.clientName}`,
    `Téléphone : ${formatPhone(input.clientPhone)}`,
    input.clientEmail ? `Courriel : ${input.clientEmail}` : null,
    input.type === "inperson" && input.location ? `Lieu : ${input.location}` : null,
    "",
    input.qualificationSummary ? `— Qualification —\n${input.qualificationSummary}` : null,
    "",
    `Réservé par ${input.callerName} via Groupe Nexus CRM`,
  ].filter((l): l is string => l !== null);

  const requestBody: calendar_v3.Schema$Event = {
    summary: `RDV — ${input.clientName} (Groupe Nexus)`,
    description: descriptionLines.join("\n"),
    start: { dateTime: input.startsAt.toISOString(), timeZone: tz },
    end: { dateTime: input.endsAt.toISOString(), timeZone: tz },
    reminders: { useDefault: true },
    ...(input.clientEmail ? { attendees: [{ email: input.clientEmail }] } : {}),
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

/** Delete the event on the admin's calendar (guests are notified). */
export async function cancelEvent(eventId: string): Promise<void> {
  const { calendar, calendarId } = await getAuthedCalendar();
  try {
    await calendar.events.delete({ calendarId, eventId, sendUpdates: "all" });
  } catch (err) {
    // Already deleted on Google's side → treat as success.
    const status = (err as { code?: number; status?: number })?.code ?? (err as { status?: number })?.status;
    if (status === 404 || status === 410) return;
    throw err;
  }
}
