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
 * Le verdict est rendu — clos par l'assistant, refus ferme ou désabonnement.
 * Il n'y a RIEN à répondre : ces fils ont leur onglet (demande d'Alex,
 * 2026-08-25) et ne comptent jamais dans « à traiter ».
 */
export const OUTCOME_REASONS = [
  "closed_goal_reached",
  "closed_disqualified",
  "closed_not_interested",
  "hard_refusal",
  "optout",
] as const;

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
 * Les quatre états exclusifs d'un fil — voir `CONVERSATION_STATE_LOOK`.
 * L'ordre des tests est l'ordre de PRIORITÉ : un fil fini est fini même si
 * `needsAttention` est resté vrai (le moteur le laisse vrai pour dater le
 * verdict), et un fil à traiter le reste même si l'IA est coupée.
 */
export type ConversationState = "attention" | "human" | "ai" | "finished";

export function conversationStateOf(row: {
  needsAttention: boolean;
  attentionReason: string | null;
  aiEnabled: boolean;
}): ConversationState {
  if (row.attentionReason !== null && OUTCOME.has(row.attentionReason)) return "finished";
  if (row.needsAttention) return "attention";
  if (!row.aiEnabled) return "human";
  return "ai";
}
