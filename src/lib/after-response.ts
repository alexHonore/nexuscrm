import { after } from "next/server";

/**
 * Exécuter du travail APRÈS avoir répondu.
 *
 * `after()` de Next est la bonne primitive en production : la plateforme garde
 * la fonction en vie jusqu'à la fin du travail, ce qu'une promesse détachée ne
 * garantit pas sur un runtime serverless.
 *
 * Mais `after()` exige un contexte de requête et LÈVE en dehors — c'est-à-dire
 * dès qu'un test, un script ou un job appelle le gestionnaire de route
 * directement. Refuser de travailler pour cette raison serait absurde : le
 * travail est le même, seul le mécanisme de survie change. On retombe donc sur
 * une exécution détachée, et on la garde traçable pour que les tests puissent
 * l'attendre au lieu de courir après.
 */

const pending = new Set<Promise<void>>();

export function runAfterResponse(work: () => Promise<void>): void {
  const guarded = async () => {
    try {
      await work();
    } catch (err) {
      // Ce travail est secondaire par définition : il ne doit jamais remonter
      // et faire échouer une réponse déjà envoyée.
      console.error(
        JSON.stringify({
          at: "after-response",
          event: "work_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  // Le travail démarre UNE seule fois, quel que soit le mécanisme de survie :
  // c'est cette même promesse qu'on confie à `after()` et, s'il lève (hors
  // contexte de requête), qu'on garde traçable. Avant, `after(guarded())`
  // évaluait l'appel AVANT que `after()` puisse refuser — et le repli relançait
  // le travail une seconde fois, en parallèle, sans jamais attendre la première.
  const promise: Promise<void> = guarded().finally(() => pending.delete(promise));
  try {
    after(promise);
  } catch {
    pending.add(promise);
  }
}

/**
 * Attendre le travail détaché. Utilisé par les tests, qui appellent les
 * gestionnaires hors contexte de requête ; sans ce point d'attente, ils
 * observeraient un état à moitié écrit.
 */
export async function flushAfterResponse(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}
