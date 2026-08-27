import {
  LLMProviderError,
  type GenerateInput,
  type LLMProvider,
  type LLMResult,
  type ProviderId,
} from "./types";

/**
 * La CHAÎNE de modèles : le principal, puis les replis, dans l'ordre.
 *
 * Le repli est NOTRE affaire, pas celle du routeur : `allow_fallbacks: false`
 * chez OpenRouter fait remonter la panne, et c'est ici qu'on décide de rejouer
 * le tour ailleurs. Une erreur non rejouable (400, 401 : la requête est
 * fautive) remonte telle quelle — la rejouer ailleurs ne ferait que doubler la
 * facture.
 *
 * Deux étages, à ne pas confondre :
 *   · `http.ts` reprend le MÊME modèle quand l'amont est encombré (429, 5xx) —
 *     un embouteillage de deux secondes ne mérite pas de changer de modèle ;
 *   · ce module change de MODÈLE quand le premier reste indisponible (délai
 *     dépassé, compte à sec, encombrement qui dure). Trois crans de repli sont
 *     possibles : un incident chez OpenRouter ne doit pas faire taire
 *     l'assistant parce qu'un seul remplaçant était prévu.
 */

export interface ModelRung {
  provider: ProviderId;
  model: string;
}

export interface ChainDeps {
  /** Résout un fournisseur. Lève quand la clé n'est pas configurée. */
  resolve: (provider: ProviderId) => LLMProvider;
  now?: () => number;
}

export interface ChainOptions {
  /**
   * Horodatage au-delà duquel plus aucune tentative n'est ENGAGÉE. Sert à la
   * suite de garde-fous : mieux vaut consigner « budget épuisé » que se faire
   * tuer au milieu par l'expiration de la fonction.
   */
  deadline?: number | null;
}

export interface RungFailure {
  /** 0 = modèle principal, 1..n = replis dans l'ordre. */
  rung: number;
  provider: ProviderId;
  model: string;
  error: string;
}

export interface ChainOutcome {
  result: LLMResult;
  rung: number;
  used: ModelRung;
  /** Ce qui a échoué AVANT le cran qui a répondu — pour la trace. */
  failures: RungFailure[];
}

/**
 * Toute la chaîne a échoué.
 *
 * La panne PRIMAIRE reste le diagnostic : le repli par défaut est `anthropic`
 * et sa clé absente faisait dire « llm_provider_unconfigured » à chaque
 * alerte pendant que la vraie cause (crédits OpenRouter épuisés,
 * llm_http_402) restait invisible. Les crans suivants s'ANNOTENT derrière.
 */
export class LLMChainError extends Error {
  constructor(
    readonly failures: RungFailure[],
    readonly retryable: boolean,
  ) {
    super(chainMessage(failures));
    this.name = "LLMChainError";
  }
}

function chainMessage(failures: RungFailure[]): string {
  if (failures.length === 0) return "llm_chain_empty";
  const [primary, ...rest] = failures;
  const annotations = rest.map((f) => ` (repli ${f.rung} ${f.provider}/${f.model} : ${f.error})`);
  return primary.error + annotations.join("");
}

/** Le message d'une erreur, quelle que soit sa forme. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Appelle le premier cran qui répond.
 *
 * `chain[0]` est le modèle principal ; les suivants sont ses replis. L'objet
 * de routage est propre à OpenRouter : il ne part pas chez un fournisseur
 * direct, qui le refuserait ou l'ignorerait.
 */
export async function generateWithChain(
  chain: readonly ModelRung[],
  input: Omit<GenerateInput, "model">,
  deps: ChainDeps,
  options: ChainOptions = {},
): Promise<ChainOutcome> {
  if (chain.length === 0) throw new LLMChainError([], false);
  const now = deps.now ?? Date.now;
  const failures: RungFailure[] = [];

  for (const [rung, target] of chain.entries()) {
    if (options.deadline != null && now() > options.deadline) {
      failures.push({
        rung,
        provider: target.provider,
        model: target.model,
        error: "budget de temps épuisé — cran non tenté",
      });
      break;
    }

    let provider: LLMProvider;
    try {
      provider = deps.resolve(target.provider);
    } catch (err) {
      // Clé absente : ce cran-là n'existe pas, les suivants peuvent exister.
      failures.push({ rung, provider: target.provider, model: target.model, error: describe(err) });
      continue;
    }

    try {
      const result = await provider.generate({
        ...input,
        model: target.model,
        routing: target.provider === "openrouter" ? input.routing : undefined,
      });
      return { result, rung, used: target, failures };
    } catch (err) {
      failures.push({ rung, provider: target.provider, model: target.model, error: describe(err) });
      // Requête fautive : changer de modèle ne la rendra pas valide.
      if (err instanceof LLMProviderError && !err.retryable) throw new LLMChainError(failures, false);
    }
  }

  throw new LLMChainError(failures, true);
}
