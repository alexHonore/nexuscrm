/**
 * La période observée.
 *
 * Module PUR. Deux choix qui se paient plus tard s'ils sont mal faits :
 *
 *  · **La borne haute est EXCLUSIVE.** Deux fenêtres accolées ne doivent pas
 *    compter deux fois la même minute — sinon le « delta » du code 30003, qui
 *    compare la fenêtre à la précédente, invente une hausse à chaque
 *    chargement.
 *  · **La fenêtre précédente a EXACTEMENT la même durée**, collée juste avant.
 *    Comparer sept jours à trente ne dirait rien sur une dérive.
 */
import type { DeliverabilityRange } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fenêtres offertes à l'écran. 7 jours par défaut : c'est le rythme auquel un opérateur téléphonique révise sa note. */
export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];
export const DEFAULT_RANGE_DAYS: RangeDays = 7;

export function parseRangeDays(value: string | null | undefined): RangeDays {
  const n = Number(value);
  return (RANGE_DAYS as readonly number[]).includes(n) ? (n as RangeDays) : DEFAULT_RANGE_DAYS;
}

export function rangeOf(days: number, now: Date): DeliverabilityRange {
  const toUtcExclusive = now;
  const fromUtc = new Date(now.getTime() - days * DAY_MS);
  return {
    fromUtc,
    toUtcExclusive,
    days,
    previousFromUtc: new Date(fromUtc.getTime() - days * DAY_MS),
  };
}
