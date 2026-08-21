import type { GoalConfig, GoalStep } from "@/lib/assistants/schema";

/**
 * Chaîne de rétrogradation de l'objectif (§12.4).
 *
 * Règle centrale, et la nuance qui compte : un refus MOU (« pas cette
 * semaine », « je suis occupé ») fait descendre d'un cran — visio 30 min →
 * appel 15 min → courriel. Un refus FERME (« non merci », « arrêtez ») ne
 * touche JAMAIS la chaîne : on clôt poliment et on s'arrête. Proposer un repli
 * après un refus clair, c'est exactement le harcèlement que le cahier interdit.
 *
 * Module pur : pas de base, pas de Next, pas d'horloge.
 */

export type RungKey = "primary" | `fallback:${number}`;

export interface Rung {
  key: RungKey;
  goal: GoalStep;
  /** Position dans la chaîne : 0 = objectif principal. */
  depth: number;
  /** Vrai quand il n'y a plus rien en dessous. */
  isLast: boolean;
}

/** Nombre total de crans disponibles (principal + replis). */
export function rungCount(goal: GoalConfig): number {
  return 1 + goal.fallbacks.length;
}

/** Cran correspondant à une profondeur, borné à la fin de la chaîne. */
export function rungAtDepth(goal: GoalConfig, depth: number): Rung {
  const total = rungCount(goal);
  const clamped = Math.min(Math.max(depth, 0), total - 1);
  const isLast = clamped === total - 1;
  if (clamped === 0) {
    return { key: "primary", goal: goal.primary, depth: 0, isLast };
  }
  const index = clamped - 1;
  return { key: `fallback:${index}`, goal: goal.fallbacks[index], depth: clamped, isLast };
}

/**
 * Cran courant d'après le nombre de refus mous encaissés. Un refus mou = un
 * cran. Au-delà de la chaîne on reste sur le dernier cran (c'est le compteur
 * de tours, ou un refus ferme, qui met fin à la conversation — pas la chaîne).
 */
export function resolveRung(goal: GoalConfig, softRefusals: number): Rung {
  return rungAtDepth(goal, softRefusals);
}

/** Lit un `conversations.goal_rung` stocké. Toute valeur inconnue = principal. */
export function parseRungKey(value: string | null | undefined): number {
  if (!value || value === "primary") return 0;
  const match = /^fallback:(\d+)$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) + 1;
}

export interface DowngradeResult {
  /** Cran à appliquer après la classification de ce tour. */
  rung: Rung;
  /** Vrai si on vient de descendre d'un cran (à journaliser en agent_events). */
  downgraded: boolean;
  /** Nouveau compteur de refus mous à persister. */
  softRefusals: number;
  /** Vrai quand un refus mou arrive alors qu'il n'y a plus de repli. */
  exhausted: boolean;
}

/**
 * Applique le verdict du classifieur au cran courant.
 *
 * `refusal`:
 *  - "none" → rien ne bouge ;
 *  - "soft" → un cran plus bas (et `exhausted` si on était déjà au dernier) ;
 *  - "hard" → la chaîne n'est PAS touchée ; l'appelant clôt la conversation.
 */
export function applyRefusal(
  goal: GoalConfig,
  currentSoftRefusals: number,
  refusal: "none" | "soft" | "hard",
): DowngradeResult {
  if (refusal !== "soft") {
    return {
      rung: resolveRung(goal, currentSoftRefusals),
      downgraded: false,
      softRefusals: currentSoftRefusals,
      exhausted: false,
    };
  }

  const before = resolveRung(goal, currentSoftRefusals);
  const next = currentSoftRefusals + 1;
  const after = resolveRung(goal, next);
  return {
    rung: after,
    downgraded: after.depth > before.depth,
    softRefusals: next,
    // Un refus mou sans repli restant : plus rien à proposer, il faut clore.
    exhausted: before.isLast,
  };
}

/** Champs de qualification exigés avant de réserver, pour le cran donné. */
export function requiredFieldsFor(rung: Rung): string[] {
  return rung.goal.requiredFields;
}

/** Un cran qui réserve un rendez-vous a besoin de disponibilités réelles. */
export function rungNeedsSlots(rung: Rung): boolean {
  return (
    rung.goal.type === "video_meeting" ||
    rung.goal.type === "in_person_meeting" ||
    rung.goal.type === "phone_call"
  );
}
