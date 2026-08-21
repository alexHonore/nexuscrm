/**
 * Interface de réservation — CONTRAT framework-agnostique (aucun import
 * Next.js, aucun accès `db` ici : c'est ce qui permettra, plus tard, de
 * substituer une autre implémentation — ex. Cal.com — sans toucher à
 * l'agent SMS qui consomme `BookingProvider`).
 *
 * L'implémentation réelle (adossée au système de réservation existant du
 * CRM — Google Agenda) vit dans `src/lib/booking/internal.ts`.
 */

export type BookingAppointmentType = "meet" | "inperson";

/** Un créneau proposable, avec son libellé humain prêt à afficher. */
export interface BookingSlot {
  /** Instant ISO (UTC) du début du créneau. */
  iso: string;
  /** Libellé humain en FRANÇAIS, ex. « jeudi 14 h », « vendredi 18 h 30 ». */
  label: string;
}

/**
 * Contrainte exprimée par la personne — « je peux juste la fin de semaine »,
 * « seulement le matin ».
 *
 * Sans elle, `getSlots` rendait toujours les MÊMES premiers créneaux libres :
 * quelqu'un qui demandait la fin de semaine s'entendait répondre « aucun
 * créneau la fin de semaine » alors que le samedi était grand ouvert — il
 * arrivait simplement après les deux premiers créneaux de semaine.
 */
export const SLOT_PREFERENCES = [
  "any",
  "weekend",
  "weekday",
  "morning",
  "afternoon",
  "evening",
] as const;
export type SlotPreference = (typeof SLOT_PREFERENCES)[number];

/** Un jour de la semaine (0 = dimanche) satisfait-il la contrainte? */
export function dayMatchesPreference(weekday: number, preference: SlotPreference): boolean {
  if (preference === "weekend") return weekday === 0 || weekday === 6;
  if (preference === "weekday") return weekday >= 1 && weekday <= 5;
  return true;
}

/**
 * Une heure locale satisfait-elle la contrainte? Bornes volontairement
 * larges : « le matin » veut dire avant midi, « le soir » à partir de 17 h.
 */
export function hourMatchesPreference(hour: number, preference: SlotPreference): boolean {
  if (preference === "morning") return hour < 12;
  if (preference === "afternoon") return hour >= 12 && hour < 17;
  if (preference === "evening") return hour >= 17;
  return true;
}

export interface GetSlotsInput {
  type: BookingAppointmentType;
  /** Nombre de créneaux souhaités (le brief : 2 ou 3 en pratique). */
  count: number;
  /** Point de départ ISO de la recherche ; par défaut, maintenant. */
  fromIso?: string;
  /** Contrainte de la personne ; « any » par défaut. */
  preference?: SlotPreference;
}

export interface GetSlotsResult {
  slots: BookingSlot[];
  /**
   * Vrai quand une contrainte était demandée et qu'AUCUN créneau n'y répond
   * dans la fenêtre explorée. L'appelant peut alors le dire honnêtement — et
   * proposer autre chose — au lieu de laisser croire que l'agenda est vide.
   */
  preferenceUnavailable?: boolean;
  /**
   * Faux quand le compte Google Agenda du courtier n'est PAS connecté. Dans
   * ce cas `slots` est TOUJOURS vide (voir la garantie documentée sur
   * `internal.ts::getSlots`) : un texteur autonome ne doit jamais offrir
   * d'heure alors qu'il ne « voit » pas l'agenda réel du courtier.
   */
  googleConnected: boolean;
}

export interface BookInput {
  clientId: string;
  /** Fil SMS d'origine — stocké dans le rendez-vous pour la traçabilité. */
  conversationId: string;
  type: BookingAppointmentType;
  /** Un des `iso` renvoyés par `getSlots` — jamais une heure inventée. */
  slotIso: string;
  /** Courriel confirmé par la personne, si recueilli. */
  email?: string;
}

export type BookResult =
  | { ok: true; appointmentId: string; startsAtIso: string }
  | {
      ok: false;
      /**
       * slot_taken   : le créneau (valide) n'est plus libre à la revalidation ;
       * google_error : l'agenda Google est injoignable, ou vient de se
       *                déconnecter, au moment de la revalidation — on ne
       *                réserve jamais à l'aveugle ;
       * invalid_slot : `slotIso` n'est pas une date exploitable ;
       * not_bookable : rien à réserver (client introuvable, ou aucun
       *                utilisateur du CRM à qui rattacher le rendez-vous).
       */
      error: "slot_taken" | "google_error" | "invalid_slot" | "not_bookable";
    };

/** Contrat que doit remplir tout moteur de réservation branché à l'agent SMS. */
export interface BookingProvider {
  getSlots(input: GetSlotsInput): Promise<GetSlotsResult>;
  book(input: BookInput): Promise<BookResult>;
}

// ── Aides pures (testables sans base de données) ─────────────────────────────

import { addDays } from "date-fns";
import { fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Libellé humain FRANÇAIS d'un créneau, dans le fuseau `tz` — ex. « jeudi
 * 14 h », « vendredi 18 h 30 ». Les minutes ne sont montrées que si elles
 * sont non nulles (« 14 h », jamais « 14 h 00 »). Fonction PURE : aucune
 * dépendance à la base ou à Next.js, donc testable directement.
 */
export function formatSlotLabel(date: Date, tz: string): string {
  const weekday = formatInTimeZone(date, tz, "EEEE", { locale: fr });
  const hourMinute = formatInTimeZone(date, tz, "H:mm", { locale: fr });
  const [hour, minute] = hourMinute.split(":");
  const suffix = minute === "00" ? "" : ` ${minute}`;
  return `${weekday} ${hour} h${suffix}`;
}

/**
 * Les `n` prochains jours OUVRABLES (lundi à vendredi) à partir de la date
 * calendaire de `fromIso`, en chaînes « AAAA-MM-JJ ». Arithmétique calendaire
 * PURE (comme `isRealDate`/le calcul de jour de semaine dans
 * `computeAvailability`) : on avance une chaîne de date ancrée à minuit UTC,
 * jamais un instant réel, pour ne jamais glisser d'un jour autour d'un
 * changement d'heure. Utilitaire exporté pour d'éventuels appelants (ex.
 * relances, rapports) — `getSlots` (internal.ts) ne s'en sert PAS : les
 * réglages de réservation peuvent inclure des fins de semaine.
 */
export function nextBusinessDays(fromIso: string, n: number): string[] {
  const parsed = new Date(fromIso);
  if (Number.isNaN(parsed.getTime()) || n <= 0) return [];

  let cursor = new Date(`${parsed.toISOString().slice(0, 10)}T00:00:00Z`);
  const out: string[] = [];
  while (out.length < n) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor = addDays(cursor, 1);
  }
  return out;
}
