/**
 * L'état d'un fil de conversation — le modèle que la boîte de réception AFFICHE.
 *
 * Avant lui, l'écran devinait : `needsAttention` par-ci, `aiEnabled` par-là,
 * et un motif `attentionReason` en texte libre. Un fil clos portait la puce
 * « IA en pause », un désabonnement côtoyait un nouveau message dans le même
 * onglet, et personne ne savait dire si un fil « attendait une réponse » ou
 * « était fini ». Ici, la règle est écrite UNE fois : quatre états exclusifs,
 * et chaque motif rangé par ce qu'il y a à FAIRE.
 *
 * Les motifs sont écrits par le moteur (`src/lib/agent/runtime.ts`,
 * `src/lib/sms-server/inbound.ts`, `src/lib/jobs/handlers/send-sms.ts`) en
 * texte libre — cette liste est le miroir côté écran, et les tests vérifient
 * qu'elle couvre les libellés (`messages/<locale>/conversations.json`) et le
 * vocabulaire visuel (`ATTENTION_LOOK`).
 */

/** Le client attend un HUMAIN : la réponse est le travail. */
export const REPLY_REASONS = [
  "inbound",
  "client_wants_human",
  "handoff",
  "guardrail",
  "booking_failed",
  "max_turns",
  "no_assistant",
  "goal_chain_exhausted",
] as const;

/** Une PANNE a laissé le client sans réponse : réparer (ou rejouer), puis répondre. */
export const ENGINE_REASONS = [
  "llm_error",
  "no_text",
  "blocked_output",
  "guardrail_unavailable",
  "send_failed",
  "truncated",
  "content_filter",
] as const;

/**
 * Le contact a dit NON — refus ferme, « pas intéressé », ou STOP. Ces fils ont
 * leur propre vue (demande d'Alex, 2026-08-25 au soir) : un « non » explicite
 * ne se mélange ni aux fils à traiter, ni aux conclusions heureuses.
 */
export const REFUSED_REASONS = ["hard_refusal", "optout", "closed_not_interested"] as const;

/**
 * Le motif écrit par le bouton « Clore » de la boîte — le SEUL de tous les
 * motifs qu'aucune machine n'écrit jamais.
 *
 * Un fil « entre vos mains » n'avait aucune sortie : sa pastille est déjà
 * tombée (rien à « marquer traité »), et « rendre à l'IA » n'existe pas quand
 * aucun assistant ne tient le fil. La section grossissait donc sans fin. Clore
 * ne fait taire personne : le prochain message du client réécrit
 * `attentionReason` (« Nouveau message », voir `sms-server/inbound.ts`) et
 * ramène le fil dans « à traiter ».
 */
export const HUMAN_CLOSED_REASON = "closed_by_human";

/**
 * Conclu sans refus : l'objectif est atteint, la personne n'était pas dans la
 * cible — ou un humain a décidé que le fil était fini. Rien à faire, rien de
 * fâcheux.
 */
export const CONCLUDED_REASONS = [
  "closed_goal_reached",
  "closed_disqualified",
  HUMAN_CLOSED_REASON,
] as const;

/**
 * Le verdict est rendu — quelle qu'en soit la couleur. Il n'y a RIEN à
 * répondre : ces motifs ne comptent jamais dans « à traiter ».
 */
export const OUTCOME_REASONS = [...REFUSED_REASONS, ...CONCLUDED_REASONS] as const;

export const ATTENTION_REASONS = [
  ...REPLY_REASONS,
  ...ENGINE_REASONS,
  ...OUTCOME_REASONS,
] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** Ce qu'il y a à faire : répondre, réparer, ou rien (c'est fini). */
export type AttentionKind = "reply" | "engine" | "outcome";

const ENGINE = new Set<string>(ENGINE_REASONS);
const OUTCOME = new Set<string>(OUTCOME_REASONS);

/**
 * Un motif inconnu (le moteur en gagnera d'autres) tombe côté « répondre » :
 * mieux vaut demander un humain pour rien que classer une demande réelle dans
 * les pannes — ou pire, dans les fils finis.
 */
export function attentionKindOf(reason: string): AttentionKind {
  if (OUTCOME.has(reason)) return "outcome";
  if (ENGINE.has(reason)) return "engine";
  return "reply";
}

/**
 * Un texto SORTANT qui n'a pas atteint le client — la matière de la vue
 * « Échecs », et la bulle rouge du fil (`sms-thread-card`). Une seule liste
 * pour les deux : deux définitions du mot « échec » finiraient par afficher
 * deux nombres différents du même fait.
 *
 * Une ANNULATION n'en fait pas partie : un envoi retenu à la main est une
 * décision, pas une panne. « unknown » (délai réseau, Twilio a peut-être
 * livré) y est, lui : personne ne sait si le client l'a reçu, et c'est
 * exactement ce qu'un écran d'échecs doit montrer.
 */
export const FAILED_SEND_STATUSES = ["failed", "undelivered", "skipped", "unknown"] as const;

/**
 * Plus large d'un cran : tout sortant qui n'a PAS atteint le client, panne ou
 * pas — la matière de la vue « Échecs ».
 *
 * `dry_run` s'y ajoute parce qu'en mode essai rien ne part, et qu'un écran
 * annonçant « aucun envoi perdu » pendant qu'aucun message ne sort est le pire
 * mensonge que cette vue puisse faire. Ce n'est pas une panne — la carte le dit
 * en toutes lettres (« Simulation (mode essai) ») — mais c'est bien un client
 * qui n'a rien reçu. Même choix que `NEVER_LEFT_STATUSES` de
 * `src/lib/deliverability/status-classes.ts`, pour la même raison.
 *
 * En mode réel, aucune rangée ne porte ce statut : la vue est identique.
 */
export const UNREACHED_SEND_STATUSES = [...FAILED_SEND_STATUSES, "dry_run"] as const;

/**
 * Les cinq états exclusifs d'un fil — voir `CONVERSATION_STATE_LOOK`.
 * L'ordre des tests est l'ordre de PRIORITÉ : un fil fini est fini même si
 * `needsAttention` est resté vrai (le moteur le laisse vrai pour dater le
 * verdict), et un fil à traiter le reste même si l'IA est coupée.
 *
 *  · `attention` — une action humaine attend.
 *  · `human` — un humain tient la plume (IA en pause), sans urgence.
 *  · `ai` — l'assistant mène le fil ; le plus souvent, il a écrit et le
 *    client n'a pas encore répondu.
 *  · `refused` — le contact a dit non (refus, pas intéressé, STOP).
 *  · `concluded` — conclu sans refus (objectif atteint, hors cible).
 */
export type ConversationState = "attention" | "human" | "ai" | "refused" | "concluded";

const REFUSED = new Set<string>(REFUSED_REASONS);

/**
 * Ce que l'assistant a FAIT sur un fil — la conclusion visible de son travail.
 *
 * Le moteur journalise chaque outil exécuté (`agent_events`), mais un journal
 * n'est pas une réponse à « qu'a-t-il fait ? ». Ici, les événements sont
 * réduits aux six actes qui comptent pour un humain qui parcourt la boîte :
 * réservé, classé, qualifié, rappel posé, note laissée, transféré. Les
 * lectures (fiche, notes, disponibilités) ne sont pas des actes — les montrer
 * noierait les vrais.
 */
export const CONVERSATION_DEEDS = [
  "booked",
  "categorized",
  "qualified",
  "followup",
  "note",
  "transferred",
] as const;

export type ConversationDeed = (typeof CONVERSATION_DEEDS)[number];

/** L'ordre d'affichage = l'ordre de la liste : le rendez-vous d'abord. */
const DEED_OF_ITEM: Record<string, ConversationDeed> = {
  book_meeting: "booked",
  set_category: "categorized",
  auto_categorized: "categorized",
  update_qualification: "qualified",
  schedule_followup: "followup",
  followup_created: "followup",
  add_client_comment: "note",
  transfer_assistant: "transferred",
  transfer: "transferred",
};

/**
 * Réduit un événement du moteur (nom d'outil réussi, ou type d'événement) à
 * son acte — null pour tout ce qui n'en est pas un.
 */
export function deedOf(item: string): ConversationDeed | null {
  return DEED_OF_ITEM[item] ?? null;
}

export function conversationStateOf(row: {
  needsAttention: boolean;
  attentionReason: string | null;
  aiEnabled: boolean;
}): ConversationState {
  if (row.attentionReason !== null && OUTCOME.has(row.attentionReason)) {
    return REFUSED.has(row.attentionReason) ? "refused" : "concluded";
  }
  if (row.needsAttention) return "attention";
  if (!row.aiEnabled) return "human";
  return "ai";
}
