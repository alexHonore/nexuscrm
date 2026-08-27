import "server-only";
import { addMinutes } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { freeBusy, GoogleNotConnectedError, type BusyInterval } from "@/lib/google";
import { getSetting, type BookingSettings } from "@/lib/settings";

/** Grid step between two candidate starts. */
export const SLOT_STEP_MIN = 30;

export type AppointmentType = "meet" | "inperson";

export type AvailabilityResult = {
  /** ISO (UTC) start instants of the free slots, ascending. */
  slots: string[];
  /** Slot duration in minutes for the requested type. */
  duration: number;
  /** False when the admin has not connected Google Calendar (slots = local data only). */
  googleConnected: boolean;
  /** Bookable weekdays (0 = Sunday … 6 = Saturday) from the booking settings. */
  days: number[];
  /** IANA timezone the day window is computed in. */
  timezone: string;
  /** Default location suggested for in-person appointments. */
  defaultLocation: string;
};

export function durationFor(settings: BookingSettings, type: AppointmentType): number {
  return type === "meet" ? settings.meetDurationMin : settings.inPersonDurationMin;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Vrai seulement si la date existe VRAIMENT au calendrier : « 2026-02-30 »
 * passe la regex mais provoque un débordement de mois (Invalid Date plus loin,
 * puis une requête SQL invalide).
 */
export function isRealDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

function overlaps(slotStart: Date, slotEnd: Date, busy: BusyInterval[], bufferMin: number): boolean {
  return busy.some(
    (b) =>
      slotStart.getTime() < b.end.getTime() + bufferMin * 60_000 &&
      slotEnd.getTime() > b.start.getTime() - bufferMin * 60_000,
  );
}

/**
 * Free slots for one calendar day (interpreted in the booking timezone).
 * Sources subtracted: Google FreeBusy on the admin calendar (+buffer),
 * locally stored scheduled appointments (+buffer), past/too-soon starts.
 */
export async function computeAvailability(
  date: string,
  type: AppointmentType,
  opts?: { excludeAppointmentId?: string },
): Promise<AvailabilityResult> {
  const settings = await getSetting("booking");
  const tz = settings.timezone || "America/Toronto";
  const duration = durationFor(settings, type);

  const base: Omit<AvailabilityResult, "slots" | "googleConnected"> = {
    duration,
    days: settings.days,
    timezone: tz,
    defaultLocation: settings.inPersonDefaultLocation,
  };

  if (!isRealDate(date)) return { ...base, slots: [], googleConnected: true };

  // Weekday of a calendar date is independent of timezone.
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (!settings.days.includes(weekday)) {
    return { ...base, slots: [], googleConnected: true };
  }

  const windowStart = fromZonedTime(`${date}T${settings.startHour}:00`, tz);
  const windowEnd = fromZonedTime(`${date}T${settings.endHour}:00`, tz);
  const dayStart = fromZonedTime(`${date}T00:00:00`, tz);
  // Minuit local du LENDEMAIN, par arithmétique calendaire sur la chaîne de
  // date (jamais `addDays` sur l'instant : il compte 24 h dans le fuseau du
  // PROCESSUS — UTC en production — et rate la 25e heure du jour de retour à
  // l'heure normale, donc tout évènement Google de 23 h à minuit ce jour-là).
  const nextDate = new Date(`${date}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const dayEnd = fromZonedTime(`${nextDate.toISOString().slice(0, 10)}T00:00:00`, tz);
  if (windowEnd <= windowStart) return { ...base, slots: [], googleConnected: true };

  // 1) Google busy blocks (whole day so the buffer never misses an edge).
  let googleConnected = true;
  let busy: BusyInterval[] = [];
  try {
    busy = await freeBusy(dayStart, dayEnd);
  } catch (err) {
    if (err instanceof GoogleNotConnectedError) {
      googleConnected = false;
    } else {
      // Google unreachable — fail closed rather than double-booking silently.
      throw err;
    }
  }

  // 2) Locally stored scheduled appointments (covers Google propagation lag).
  const conditions = [
    eq(appointments.status, "scheduled"),
    lt(appointments.startsAt, dayEnd),
    gt(appointments.endsAt, dayStart),
  ];
  if (opts?.excludeAppointmentId) {
    conditions.push(ne(appointments.id, opts.excludeAppointmentId));
  }
  const local = await db
    .select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments)
    .where(and(...conditions));
  busy = busy.concat(local.map((a) => ({ start: a.startsAt, end: a.endsAt })));

  // 3) Walk the 30-min grid. Le préavis vient des réglages (admin) : un
  // créneau plus proche que `minNoticeMin` n'est jamais offert ni réservable.
  const minStart = addMinutes(new Date(), settings.minNoticeMin);
  const slots: string[] = [];
  for (
    let start = windowStart;
    addMinutes(start, duration) <= windowEnd;
    start = addMinutes(start, SLOT_STEP_MIN)
  ) {
    if (start < minStart) continue;
    const end = addMinutes(start, duration);
    if (overlaps(start, end, busy, settings.bufferMin)) continue;
    slots.push(start.toISOString());
  }

  return { ...base, slots, googleConnected };
}
