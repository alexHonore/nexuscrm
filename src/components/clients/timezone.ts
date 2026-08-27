import { addDays, addMonths, format, startOfDay } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

/** Display timezone of the whole app (see AGENTS.md). */
export const APP_TZ = "America/Toronto";

/**
 * UTC instant of a Toronto midnight, `days` civil days after the one containing
 * `now` (DST-safe). `days = 0` is this morning, `1` tomorrow morning, and so on.
 *
 * Compte les jours CIVILS, pas des tranches de 24 h : la nuit du changement
 * d'heure dure 23 h ou 25 h, et « + 24 h » y sauterait ou répéterait un jour.
 */
export function torontoDayStart(now: Date = new Date(), days = 0): Date {
  const dayStart = addDays(startOfDay(toZonedTime(now, APP_TZ)), days);
  return fromZonedTime(format(dayStart, "yyyy-MM-dd'T'HH:mm:ss"), APP_TZ);
}

/**
 * UTC instant of a Toronto midnight, `months` calendar months after the one
 * containing `now` (DST-safe).
 *
 * Compte les mois CIVILS, pas des multiples de 30 jours : « dans trois mois »
 * le 31 janvier vaut le 30 avril, et une durée en jours y déraperait d'un
 * jour à chaque mois court. `addMonths` borne le quantième au dernier jour du
 * mois d'arrivée, ce qui est exactement la lecture attendue.
 */
export function torontoMonthStart(now: Date = new Date(), months = 0): Date {
  const dayStart = addMonths(startOfDay(toZonedTime(now, APP_TZ)), months);
  return fromZonedTime(format(dayStart, "yyyy-MM-dd'T'HH:mm:ss"), APP_TZ);
}

/**
 * UTC boundaries of "today" as seen from America/Toronto (DST-safe).
 * start <= today < end
 */
export function torontoDayRange(now: Date = new Date()): { start: Date; end: Date } {
  return { start: torontoDayStart(now, 0), end: torontoDayStart(now, 1) };
}
