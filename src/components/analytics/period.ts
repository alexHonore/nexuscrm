import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/**
 * Bornes de période en fuseau America/Toronto — utilisables côté serveur et client.
 * Une période est [fromUtc, toUtcExclusive) : le début du premier jour (Toronto)
 * jusqu'au début du lendemain du dernier jour (Toronto), en UTC.
 */

export const APP_TZ = "America/Toronto";

export type PeriodPreset = "7" | "30" | "90" | "custom";

export type Period = {
  preset: PeriodPreset;
  /** Premier jour inclus, YYYY-MM-DD (Toronto). */
  fromStr: string;
  /** Dernier jour inclus, YYYY-MM-DD (Toronto). */
  toStr: string;
  fromUtc: Date;
  toUtcExclusive: Date;
  /** Nombre de jours inclus. */
  dayCount: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Garde-fou : une plage personnalisée ne dépasse pas 2 ans. */
const MAX_DAYS = 731;

/** Date du jour (Toronto) au format YYYY-MM-DD. */
export function todayStr(now: Date = new Date()): string {
  return formatInTimeZone(now, APP_TZ, "yyyy-MM-dd");
}

/** Début (UTC) du jour Toronto donné en YYYY-MM-DD. */
export function dayStartUtc(dateStr: string): Date {
  return fromZonedTime(`${dateStr}T00:00:00`, APP_TZ);
}

/** Décale une date YYYY-MM-DD de n jours (arithmétique de calendrier, sans DST). */
export function shiftDateStr(dateStr: string, days: number): string {
  const anchor = new Date(`${dateStr}T12:00:00Z`);
  return formatInTimeZone(addDays(anchor, days), "UTC", "yyyy-MM-dd");
}

function daysBetween(fromStr: string, toStr: string): number {
  const a = new Date(`${fromStr}T12:00:00Z`).getTime();
  const b = new Date(`${toStr}T12:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Résout les paramètres d'URL (?period=&from=&to=) en période bornée Toronto. Défaut : 30 jours. */
export function resolvePeriod(params: {
  period?: string;
  from?: string;
  to?: string;
}): Period {
  const today = todayStr();

  if (
    params.period === "custom" &&
    params.from &&
    params.to &&
    DATE_RE.test(params.from) &&
    DATE_RE.test(params.to)
  ) {
    let fromStr = params.from;
    let toStr = params.to;
    if (fromStr > toStr) [fromStr, toStr] = [toStr, fromStr];
    if (daysBetween(fromStr, toStr) > MAX_DAYS) fromStr = shiftDateStr(toStr, -(MAX_DAYS - 1));
    return {
      preset: "custom",
      fromStr,
      toStr,
      fromUtc: dayStartUtc(fromStr),
      toUtcExclusive: dayStartUtc(shiftDateStr(toStr, 1)),
      dayCount: daysBetween(fromStr, toStr),
    };
  }

  const preset: PeriodPreset =
    params.period === "7" || params.period === "90" ? params.period : "30";
  const days = Number(preset);
  const fromStr = shiftDateStr(today, -(days - 1));
  return {
    preset,
    fromStr,
    toStr: today,
    fromUtc: dayStartUtc(fromStr),
    toUtcExclusive: dayStartUtc(shiftDateStr(today, 1)),
    dayCount: days,
  };
}

/** Liste des jours YYYY-MM-DD entre deux bornes incluses. */
export function listDays(fromStr: string, toStr: string): string[] {
  const out: string[] = [];
  let cur = fromStr;
  let guard = 0;
  while (cur <= toStr && guard < MAX_DAYS + 1) {
    out.push(cur);
    cur = shiftDateStr(cur, 1);
    guard += 1;
  }
  return out;
}
