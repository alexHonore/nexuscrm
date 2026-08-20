/**
 * Fenêtre d'envoi SMS (« quiet hours ») — heures de politesse en temps local.
 *
 * Pur et sans dépendance d'infrastructure (règle du module src/lib/sms :
 * aucun import Next.js, aucune base de données, aucune lecture d'env). Toute
 * la logique locale passe par date-fns-tz : les changements d'heure sont
 * gérés par la base tz, jamais par de l'arithmétique d'heures sur un
 * timestamp UTC.
 *
 * Sémantique de fenêtre : [start, end) en heures locales pleines — l'envoi
 * est permis dès start:00 et interdit à partir de end:00.
 */
import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { z } from "zod";

const hourWindowSchema = z
  .tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)])
  .refine(([start, end]) => start < end, "la fenêtre doit se terminer après son début");

export const quietHoursSchema = z.object({
  /** Fuseau IANA dans lequel les heures de fenêtre s'interprètent. */
  tz: z.string().min(1),
  weekday: hourWindowSchema,
  saturday: hourWindowSchema,
  sunday: hourWindowSchema,
});

export type QuietHours = z.infer<typeof quietHoursSchema>;

export const DEFAULT_QUIET_HOURS: QuietHours = {
  tz: "America/Toronto",
  weekday: [9, 20],
  saturday: [10, 20],
  sunday: [11, 19],
};

/** Fenêtre applicable pour un jour ISO (1 = lundi … 6 = samedi, 7 = dimanche). */
function windowForIsoDay(isoDay: number, cfg: QuietHours): [number, number] {
  if (isoDay === 6) return cfg.saturday;
  if (isoDay === 7) return cfg.sunday;
  return cfg.weekday;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Vrai si l'instant UTC tombe dans la fenêtre d'envoi du jour local de cfg.tz. */
export function isWithinSendWindow(date: Date, cfg: QuietHours): boolean {
  const isoDay = Number(formatInTimeZone(date, cfg.tz, "i"));
  const hour = Number(formatInTimeZone(date, cfg.tz, "H"));
  const [start, end] = windowForIsoDay(isoDay, cfg);
  return hour >= start && hour < end;
}

/**
 * Retourne `date` inchangée si elle est dans la fenêtre, sinon la prochaine
 * ouverture : le start du même jour local si l'heure locale le précède, sinon
 * le start du jour local suivant (avec la fenêtre propre à CE jour — un report
 * du vendredi 21 h tombe le samedi 10 h).
 *
 * Un jitter de 0–9 min + 0–59 s dérivé de `random` (∈ [0, 1)) étale un lot
 * différé pendant la nuit au lieu de le laisser partir en une rafale
 * synchronisée à HH:00 pile.
 */
export function nextSendTime(
  date: Date,
  cfg: QuietHours,
  random: () => number = Math.random,
): Date {
  if (isWithinSendWindow(date, cfg)) return date;

  const localDay = formatInTimeZone(date, cfg.tz, "yyyy-MM-dd");
  const hour = Number(formatInTimeZone(date, cfg.tz, "H"));
  const isoDay = Number(formatInTimeZone(date, cfg.tz, "i"));

  let openingDay = localDay;
  let [openingHour] = windowForIsoDay(isoDay, cfg);
  if (hour >= openingHour) {
    // Après la fermeture : viser l'ouverture du jour local suivant. L'ancre à
    // midi garantit qu'ajouter 24 h tombe sur le lendemain même à travers un
    // changement d'heure (les transitions ont lieu la nuit).
    const nextDayAnchor = addDays(fromZonedTime(`${localDay}T12:00:00`, cfg.tz), 1);
    openingDay = formatInTimeZone(nextDayAnchor, cfg.tz, "yyyy-MM-dd");
    const nextIsoDay = Number(formatInTimeZone(nextDayAnchor, cfg.tz, "i"));
    openingHour = windowForIsoDay(nextIsoDay, cfg)[0];
  }

  const jitterMinutes = Math.floor(random() * 10);
  const jitterSeconds = Math.floor(random() * 60);
  return fromZonedTime(
    `${openingDay}T${pad2(openingHour)}:${pad2(jitterMinutes)}:${pad2(jitterSeconds)}`,
    cfg.tz,
  );
}
