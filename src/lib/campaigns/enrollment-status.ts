/**
 * État d'inscription — constantes et prédicat PARTAGÉS entre le serveur
 * (`campaigns-server/enrollment-admin.ts`) et l'affichage client (l'onglet
 * « Inscriptions » de l'éditeur de campagne). Module PUR : aucun import
 * serveur, pour qu'un composant client puisse le lire.
 *
 * Le schéma est gelé (pas de statut « en pause » dédié) : une pause manuelle
 * se lit sur trois champs — inscription vivante, `next_touch_at` à null (donc
 * invisible au planificateur), `end_reason` marqué. Cette lecture doit être la
 * MÊME des deux côtés, sinon un fil affiché « en pause » serait relancé, ou un
 * fil relancé afficherait « en pause ». Une seule copie, ici.
 */

/** Marqueur porté par `end_reason` d'une inscription mise en pause à la main. */
export const PAUSED_REASON = "paused_by_admin";
/** Motif de retrait manuel — inscription close par l'administrateur. */
export const REMOVED_REASON = "removed_by_admin";

const IN_FLIGHT = new Set(["pending", "active"]);

/** L'inscription peut-elle encore recevoir des messages (hors pause) ? */
export function enrollmentInFlight(status: string): boolean {
  return IN_FLIGHT.has(status);
}

/**
 * Vrai si l'inscription est en pause MANUELLE : vivante, retirée de la file
 * (`nextTouchAt` null), marquée. `nextTouchAt` accepté en `Date`, chaîne ISO
 * (côté client) ou null.
 */
export function enrollmentPaused(e: {
  status: string;
  nextTouchAt: Date | string | null;
  endReason: string | null;
}): boolean {
  return enrollmentInFlight(e.status) && e.nextTouchAt == null && e.endReason === PAUSED_REASON;
}
