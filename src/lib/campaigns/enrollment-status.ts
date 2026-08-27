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
/**
 * Motif de clôture d'une échelle allée jusqu'à son dernier barreau, écrit par
 * `runTouch`. C'est le SEUL motif de clôture qu'une relance peut rouvrir : il
 * dit « on a tout dit », pas « cette personne ne veut plus ».
 */
export const LADDER_EXHAUSTED_REASON = "ladder_exhausted";

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

/** Pourquoi une inscription terminée ne se relance PAS. */
export type ReopenRefusal =
  /** Encore en vol (ou en pause) : le geste s'appelle « Reprendre », pas « Relancer ». */
  | "not_closed"
  /** Close pour autre chose qu'une échelle finie — un refus ne se repêche jamais. */
  | "not_ladder_end"
  /** Échelle finie, mais rien de neuf : la campagne n'a pas grandi depuis. */
  | "nothing_new";

export type ReopenDecision = { allowed: true } | { allowed: false; refusal: ReopenRefusal };

/**
 * Peut-on RELANCER cette inscription terminée, c'est-à-dire la remettre en vol
 * au barreau où elle s'est arrêtée parce que l'échelle a GRANDI depuis ?
 *
 * Une seule porte : l'échelle est allée jusqu'au bout (`completed` +
 * `ladder_exhausted`) et la campagne compte désormais plus de barreaux que
 * cette inscription n'en a consommés. Tout le reste — un désabonnement, un
 * « ne pas appeler », une réponse, un rendez-vous, un retrait, une sortie
 * d'audience — n'est pas une échelle finie et ne se relance jamais : ce sont
 * des décisions PRISES SUR LA PERSONNE, et rallonger une échelle ne les annule
 * pas.
 *
 * Le `step` n'est jamais rembobiné : les barreaux déjà tracés
 * (`campaign_touches`, unique sur `(inscription, barreau)`) ne repartent pas.
 * Relancer, c'est envoyer la SUITE, pas recommencer.
 *
 * ⚠️ Ce prédicat autorise le BOUTON, jamais l'envoi. Un STOP arrivé APRÈS la
 * clôture laisse l'inscription intacte — `markEnrollmentsStopped` ne touche que
 * les inscriptions en vol — alors que la suppression, elle, est bien écrite.
 * Le serveur revérifie donc tout au moment de relancer
 * (`campaigns-server/reopen.ts`), et c'est lui qui décide.
 */
export function enrollmentReopenable(
  e: { status: string; step: number; endedAt: Date | string | null; endReason: string | null },
  opts: { ladderLength: number },
): ReopenDecision {
  // Une inscription en vol n'a rien à rouvrir ; une pause manuelle non plus —
  // elle porte `end_reason` sans être close, et c'est « Reprendre » qui la sort
  // de la file d'attente.
  if (enrollmentInFlight(e.status) || e.endedAt == null) {
    return { allowed: false, refusal: "not_closed" };
  }
  if (e.status !== "completed" || e.endReason !== LADDER_EXHAUSTED_REASON) {
    return { allowed: false, refusal: "not_ladder_end" };
  }
  // Rien de neuf : la remettre en vol la ferait re-clôturer au premier cycle
  // (`canSendTouch` refuse « échelle épuisée »), en réécrivant `ended_at` avec
  // la date du jour — une perte d'histoire pour zéro message.
  if (e.step >= opts.ladderLength) return { allowed: false, refusal: "nothing_new" };
  return { allowed: true };
}
