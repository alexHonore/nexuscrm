import type { LadderStep } from "./schema";

/**
 * Calendrier de l'échelle de relances — module PUR, horloge injectée.
 *
 * Le décalage est CUMULATIF : le barreau 0 part `delayHours` après
 * l'inscription, le barreau 1 `delayHours` après le barreau 0, et ainsi de
 * suite. Compter chaque délai depuis l'inscription rendrait le réglage
 * trompeur — mettre 24 h partout enverrait trois messages le même jour.
 *
 * Ce module ne connaît NI les heures de politesse NI les plafonds : il dit
 * quand un barreau devient dû. Le report au lendemain matin appartient à
 * l'envoi, qui l'applique déjà pour tous les messages sortants.
 */

export interface TouchPlan {
  step: number;
  /** Instant où ce barreau devient dû, heures de politesse non appliquées. */
  dueAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;

/** Calendrier complet d'une inscription — sert à l'aperçu comme au test. */
export function planLadder(ladder: LadderStep[], enrolledAt: Date): TouchPlan[] {
  const plans: TouchPlan[] = [];
  let cursor = enrolledAt.getTime();
  ladder.forEach((step, index) => {
    cursor += step.delayHours * HOUR_MS;
    plans.push({ step: index, dueAt: new Date(cursor) });
  });
  return plans;
}

/**
 * Quand le barreau `step` devient-il dû, sachant l'inscription et le dernier
 * envoi réel?
 *
 * On repart du dernier envoi RÉEL et non du calendrier théorique : un barreau
 * retardé par les heures de politesse ou par une panne de file ne doit pas
 * faire partir le suivant dans la foulée pour « rattraper ». Sans ça, deux
 * messages se suivent à quelques minutes après une interruption du dispatcher.
 */
export function nextTouchAt(
  ladder: LadderStep[],
  step: number,
  enrolledAt: Date,
  lastTouchAt: Date | null,
): Date | null {
  const rung = ladder[step];
  if (rung === undefined) return null;
  const base = step === 0 || lastTouchAt === null ? enrolledAt : lastTouchAt;
  return new Date(base.getTime() + rung.delayHours * HOUR_MS);
}

/** L'échelle est-elle terminée? */
export function ladderExhausted(ladder: LadderStep[], step: number): boolean {
  return step >= ladder.length;
}

/**
 * Le corps à envoyer pour un barreau.
 *
 * `null` signifie « laisse l'assistant rédiger ». La variante ne s'applique
 * qu'au barreau 0 : faire varier toute l'échelle rendrait le résultat du test
 * inattribuable — on ne saurait plus laquelle des trois formulations a converti.
 */
export function bodyForStep(
  ladder: LadderStep[],
  step: number,
  variantOpener: string | null,
): string | null {
  if (step === 0 && variantOpener !== null) return variantOpener;
  return ladder[step]?.body ?? null;
}
