import { DEFAULT_LLM_TIMEOUT_MS, asArray, asRecord, callJson, stringOr } from "./http";
import { chatCompletion } from "./openai-compatible";
import { reasoningBudgetTokens } from "./reasoning";
import type { GenerateInput, LLMProvider, LLMResult, ModelDescriptor } from "./types";

/**
 * OpenAI en direct — présent pour que le choix du fournisseur reste un menu
 * déroulant. Même interface, aucun objet de routage.
 */

const API_BASE = "https://api.openai.com/v1";
/** Non exposé par /v1/models : valeur de référence pour l'affichage. */
const DEFAULT_CONTEXT_TOKENS = 128_000;

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Modèle de raisonnement OpenAI (séries o, gpt-5 et suivantes) : il REFUSE
 * `max_tokens` (il veut `max_completion_tokens`) et toute température autre
 * que la valeur par défaut, et c'est à lui seul que `reasoning_effort` s'adresse
 * — l'envoyer à un modèle classique fait rejeter la requête. Les variantes
 * « -chat » de gpt-5 sont des modèles classiques.
 */
export function isOpenAiReasoningModel(modelId: string): boolean {
  return /^(o\d|gpt-[5-9])/.test(modelId) && !modelId.includes("-chat");
}

export function createOpenAiProvider(options: OpenAiOptions): LLMProvider {
  const baseUrl = (options.baseUrl ?? API_BASE).replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const headers = { Authorization: `Bearer ${options.apiKey}` };

  return {
    id: "openai",

    async generate(input: GenerateInput): Promise<LLMResult> {
      const reasoning = isOpenAiReasoningModel(input.model);
      const effort = input.reasoningEffort;
      const extraBody = reasoning && effort ? { reasoning_effort: effort } : undefined;
      return chatCompletion(input, {
        url: `${baseUrl}/chat/completions`,
        headers,
        provider: "openai",
        fetchFn,
        timeoutMs,
        bodyOptions: {
          // Accepté par tous les modèles OpenAI, exigé par ceux qui raisonnent.
          maxTokensField: "max_completion_tokens",
          includeTemperature: !reasoning,
          // Un modèle de raisonnement réfléchit même sans consigne (effort
          // « medium » par défaut chez OpenAI) et le compte sur le même
          // plafond : sans marge, 300 jetons rendent une réponse vide.
          extraOutputTokens: reasoning ? reasoningBudgetTokens(effort ?? "medium") : 0,
        },
        ...(extraBody ? { extraBody } : {}),
      });
    },

    async listModels(): Promise<ModelDescriptor[]> {
      const { json } = await callJson({
        url: `${baseUrl}/models`,
        method: "GET",
        headers,
        provider: "openai",
        fetchFn,
        timeoutMs,
      });
      return asArray(asRecord(json).data).map((entry) => {
        const model = asRecord(entry);
        const id = stringOr(model.id, "");
        return {
          id,
          label: id,
          contextTokens: DEFAULT_CONTEXT_TOKENS,
          supportsTools: /^(gpt-|o\d)/.test(id),
          supportsReasoning: isOpenAiReasoningModel(id),
        };
      });
    },
  };
}
