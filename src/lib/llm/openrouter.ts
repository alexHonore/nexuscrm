import { asArray, asRecord, callJson, numberOr, stringOr, type RetryPolicy } from "./http";
import { DEFAULT_LLM_TIMEOUT_MS } from "./http";
import { chatCompletion } from "./openai-compatible";
import { reasoningBudgetTokens } from "./reasoning";
import type { GenerateInput, LLMProvider, LLMResult, ModelDescriptor } from "./types";

/**
 * OpenRouter — un proxy : une intégration, tous les modèles, échange par
 * simple menu déroulant. En échange : un saut réseau de plus et UN
 * intermédiaire de plus à inscrire dans une évaluation Loi 25.
 *
 * Confidentialité non négociable pour cette charge (noms, numéros, budgets et
 * projets de déménagement de Québécois) : `data_collection: "deny"` ET
 * `zdr: true` — ce ne sont PAS le même contrôle (ZDR = pas de rétention chez
 * l'hébergeur ; deny = pas d'entraînement dessus) — et `allow_fallbacks: false`
 * pour qu'une panne remonte au lieu d'être silencieusement reroutée vers un
 * fournisseur dont on n'a pas validé le chemin de données.
 */

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  /** En-tête HTTP-Referer — identifie l'app dans le tableau de bord. */
  referer?: string;
  title?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Reprise sur place d'un refus passager (429, 5xx) — voir `RetryPolicy`. */
  retry?: Partial<RetryPolicy>;
  /** Injecté par les tests : attendre pour de vrai les rendrait interminables. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Traduit l'objet routing camelCase de la config vers les noms d'OpenRouter. */
export function toOpenRouterProvider(
  routing: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!routing) return undefined;
  const provider: Record<string, unknown> = {};
  if (typeof routing.dataCollection === "string") provider.data_collection = routing.dataCollection;
  if (typeof routing.zdr === "boolean") provider.zdr = routing.zdr;
  if (typeof routing.allowFallbacks === "boolean") provider.allow_fallbacks = routing.allowFallbacks;
  const only = routing.only;
  if (Array.isArray(only) && only.length > 0) provider.only = only;
  return Object.keys(provider).length > 0 ? provider : undefined;
}

export function createOpenRouterProvider(options: OpenRouterOptions): LLMProvider {
  const baseUrl = (options.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    ...(options.referer ? { "HTTP-Referer": options.referer } : {}),
    ...(options.title ? { "X-Title": options.title, "X-OpenRouter-Title": options.title } : {}),
  };

  return {
    id: "openrouter",

    async generate(input: GenerateInput): Promise<LLMResult> {
      const provider = toOpenRouterProvider(input.routing);
      // Le niveau de réflexion n'est transmis que s'il est demandé : l'envoyer
      // à un modèle qui ne le gère pas fait rejeter la requête entière.
      const reasoning = input.reasoningEffort ? { effort: input.reasoningEffort } : undefined;
      const extraBody = {
        ...(provider ? { provider } : {}),
        ...(reasoning ? { reasoning } : {}),
        // Sans cette demande EXPLICITE, OpenRouter ne renvoie pas `usage.cost` :
        // 77 % des traces de prod n'avaient AUCUN coût, et la page de
        // consommation montrait 0,92 $ pendant que le compte en avait brûlé
        // 7,14 $ (constat du 2026-08-26). Le comptage local des jetons ne
        // remplace pas ce chiffre — c'est le routeur qui connaît le prix réel
        // du fournisseur servi.
        usage: { include: true },
      };
      return chatCompletion(input, {
        url: `${baseUrl}/chat/completions`,
        headers,
        provider: "openrouter",
        fetchFn,
        timeoutMs,
        retry: options.retry,
        sleepFn: options.sleepFn,
        // Le routeur taille le budget de réflexion EN PROPORTION de max_tokens
        // (chez Anthropic, « high » en prend ~80 %) : sans marge, un plafond de
        // 300 jetons laisse une soixantaine de jetons de texte — coupé net.
        bodyOptions: { extraOutputTokens: reasoningBudgetTokens(input.reasoningEffort) },
        ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
      });
    },

    async listModels(): Promise<ModelDescriptor[]> {
      const { json } = await callJson({
        url: `${baseUrl}/models`,
        method: "GET",
        headers,
        provider: "openrouter",
        fetchFn,
        timeoutMs,
        retry: options.retry,
        sleepFn: options.sleepFn,
      });
      return asArray(asRecord(json).data).map((entry) => {
        const model = asRecord(entry);
        const pricing = asRecord(model.pricing);
        const perMTok = (value: unknown): number | undefined => {
          const n = Number(value);
          return Number.isFinite(n) ? n * 1_000_000 : undefined;
        };
        const supported = asArray(model.supported_parameters).filter(
          (p): p is string => typeof p === "string",
        );
        // Modalités d'entrée du catalogue — c'est ce qui distingue un modèle
        // capable d'écouter un enregistrement d'appel d'un modèle texte.
        const modalities = asArray(asRecord(model.architecture).input_modalities).filter(
          (m): m is string => typeof m === "string",
        );
        const inputPrice = perMTok(pricing.prompt);
        const outputPrice = perMTok(pricing.completion);
        return {
          id: stringOr(model.id, ""),
          label: stringOr(model.name, stringOr(model.id, "")),
          contextTokens: numberOr(model.context_length, 0),
          supportsTools: supported.includes("tools"),
          supportsReasoning: supported.includes("reasoning"),
          supportsAudio: modalities.includes("audio"),
          ...(inputPrice === undefined ? {} : { inputPerMTok: inputPrice }),
          ...(outputPrice === undefined ? {} : { outputPerMTok: outputPrice }),
        };
      });
    },
  };
}
