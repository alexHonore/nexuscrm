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
/**
 * Motif de retrait AUTOMATIQUE : la campagne ne vise plus la catégorie du
 * client, qui vient d'en changer.
 *
 * Le statut qui l'accompagne est `excluded`, comme le retrait manuel — et pour
 * la même raison. Ce n'est pas `stopped` : un arrêt compte comme la
 * contrepartie des réponses dans le bilan (désabonnement, refus ferme), et un
 * classement de pipeline n'est pas un refus de la personne. Ce n'est pas non
 * plus `completed` : l'échelle n'a rien terminé du tout, et la fiche client
 * afficherait « Terminée » pour une campagne qu'on vient de lui retirer.
 * « Écartée » est le mot juste, et c'est déjà celui du geste équivalent fait à
 * la main (`removeEnrollment`).
 */
export const LEFT_AUDIENCE_REASON = "left_audience";

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
