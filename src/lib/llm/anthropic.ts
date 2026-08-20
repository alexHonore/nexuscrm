import {
  DEFAULT_LLM_TIMEOUT_MS,
  asArray,
  asRecord,
  callJson,
  numberOr,
  stringOr,
} from "./http";
import type { GenerateInput, LLMProvider, LLMResult, ModelDescriptor, ToolCall } from "./types";

/**
 * Anthropic en direct — un intermédiaire de moins dans le chemin des données
 * (le prix : une deuxième clé d'API). Même interface que les autres : changer
 * de fournisseur reste un menu déroulant, sans redéploiement.
 */

const API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic n'expose pas la fenêtre par modèle : valeur de référence. */
const DEFAULT_CONTEXT_TOKENS = 200_000;

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function createAnthropicProvider(options: AnthropicOptions): LLMProvider {
  const baseUrl = (options.baseUrl ?? API_BASE).replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const headers = { "x-api-key": options.apiKey, "anthropic-version": ANTHROPIC_VERSION };

  return {
    id: "anthropic",

    async generate(input: GenerateInput): Promise<LLMResult> {
      const { json, latencyMs } = await callJson({
        url: `${baseUrl}/messages`,
        headers,
        body: {
          model: input.model,
          max_tokens: input.maxTokens,
          temperature: input.temperature,
          system: input.system,
          messages: input.messages,
          tools: input.tools?.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        },
        provider: "anthropic",
        fetchFn,
        timeoutMs,
      });

      const root = asRecord(json);
      const blocks = asArray(root.content).map(asRecord);
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => stringOr(block.text, ""))
        .join("");
      const toolCalls: ToolCall[] = blocks
        .filter((block) => block.type === "tool_use")
        .map((block, index) => ({
          id: stringOr(block.id, `call_${index}`),
          name: stringOr(block.name, ""),
          arguments: asRecord(block.input),
        }));

      const usage = asRecord(root.usage);
      return {
        text,
        toolCalls,
        usage: {
          inputTokens: numberOr(usage.input_tokens, 0),
          outputTokens: numberOr(usage.output_tokens, 0),
        },
        latencyMs,
        modelServed: stringOr(root.model, input.model),
        raw: json,
      };
    },

    async listModels(): Promise<ModelDescriptor[]> {
      const { json } = await callJson({
        url: `${baseUrl}/models`,
        method: "GET",
        headers,
        provider: "anthropic",
        fetchFn,
        timeoutMs,
      });
      return asArray(asRecord(json).data).map((entry) => {
        const model = asRecord(entry);
        const id = stringOr(model.id, "");
        return {
          id,
          label: stringOr(model.display_name, id),
          contextTokens: DEFAULT_CONTEXT_TOKENS,
          supportsTools: true,
        };
      });
    },
  };
}
