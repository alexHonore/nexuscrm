/**
 * Statuts de livraison Twilio — vocabulaire PARTAGÉ entre le webhook de statut
 * (/api/webhooks/twilio/status) et la réconciliation REST (lib/jobs/reconcile).
 * Les deux chemins écrivent la même rangée `messages` : ils doivent trancher
 * une régression de statut avec la MÊME règle, sinon un rappel tardif et un
 * sondage REST se marcheraient dessus.
 *
 * Module pur (règle du dossier sms/) : aucun import Next, aucune base.
 */

/**
 * Les rappels Twilio peuvent arriver en désordre ou en double : un « sent »
 * tardif ne doit jamais écraser un « undelivered » déjà consigné — le registre
 * des messages est une pièce de conformité. Rang croissant = plus définitif.
 */
export const STATUS_RANK: Record<string, number> = {
  accepted: 1,
  queued: 1,
  scheduled: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
  canceled: 4,
};

export const rankOf = (status: string | null): number => STATUS_RANK[status ?? ""] ?? 0;

/**
 * Codes d'erreur Twilio d'échec DÉFINITIF du transporteur : 30003 (injoignable/
 * hors service), 30005 (numéro inconnu), 30006 (ligne fixe ou injoignable par
 * SMS). Les codes transitoires (30008…) ne suppriment rien.
 */
export const HARD_FAILURE_CODES = new Set([30003, 30005, 30006]);
