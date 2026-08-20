import { DEFAULT_LLM_TIMEOUT_MS, asArray, asRecord, callJson, stringOr } from "./http";
import { chatCompletion } from "./openai-compatible";
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

export function createOpenAiProvider(options: OpenAiOptions): LLMProvider {
  const baseUrl = (options.baseUrl ?? API_BASE).replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const headers = { Authorization: `Bearer ${options.apiKey}` };

  return {
    id: "openai",

    async generate(input: GenerateInput): Promise<LLMResult> {
      return chatCompletion(input, {
        url: `${baseUrl}/chat/completions`,
        headers,
        provider: "openai",
        fetchFn,
        timeoutMs,
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
          supportsTools: id.startsWith("gpt-") || id.startsWith("o"),
        };
      });
    },
  };
}
