import { LLMProviderError, type GenerateInput, type LLMProvider, type LLMResult } from "./types";

/**
 * Sélection générateur/classifieur et repli explicite.
 *
 * Le repli est NOTRE affaire, pas celle du routeur : `allow_fallbacks: false`
 * chez OpenRouter fait remonter la panne, et c'est ici qu'on décide, une seule
 * fois, de rejouer le tour chez le fournisseur direct. Une erreur non
 * rejouable (400, 401 : la requête est fautive) remonte telle quelle — la
 * rejouer ailleurs ne ferait que doubler la facture.
 */

export interface FallbackInput extends GenerateInput {
  /** Identifiant du modèle CHEZ LE REPLI (les ids diffèrent d'un routeur à un direct). */
  fallbackModel?: string;
}

export async function generateWithFallback(
  primary: LLMProvider,
  fallback: LLMProvider | null,
  input: FallbackInput,
): Promise<{ result: LLMResult; usedFallback: boolean }> {
  try {
    return { result: await primary.generate(input), usedFallback: false };
  } catch (err) {
    const retryable = err instanceof LLMProviderError && err.retryable;
    if (!retryable || fallback === null) throw err;
    const result = await fallback.generate({
      ...input,
      model: input.fallbackModel ?? input.model,
      // L'objet de routage est propre à OpenRouter : il n'a pas de sens ailleurs.
      routing: undefined,
    });
    return { result, usedFallback: true };
  }
}
