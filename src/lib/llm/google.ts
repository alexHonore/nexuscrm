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
 * Google en direct — le moins cher et le plus rapide : c'est le fournisseur
 * naturel du CLASSIFIEUR (intention, refus, extraction de qualification),
 * pendant qu'un modèle plus fort rédige. Mélanger les deux est la
 * configuration prévue, pas un cas limite.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GoogleOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function createGoogleProvider(options: GoogleOptions): LLMProvider {
  const baseUrl = (options.baseUrl ?? API_BASE).replace(/\/$/, "");
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const headers = { "x-goog-api-key": options.apiKey };

  return {
    id: "google",

    async generate(input: GenerateInput): Promise<LLMResult> {
      const { json, latencyMs } = await callJson({
        url: `${baseUrl}/models/${input.model}:generateContent`,
        headers,
        body: {
          system_instruction: { parts: [{ text: input.system }] },
          contents: input.messages.map((message) => ({
            // Google : « model » et « user » seulement ; un résultat d'outil
            // est un `functionResponse` porté par un tour `user`.
            role: message.role === "assistant" ? "model" : "user",
            parts: toGoogleParts(message),
          })),
          tools:
            input.tools && input.tools.length > 0
              ? [
                  {
                    function_declarations: input.tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    })),
                  },
                ]
              : undefined,
          generationConfig: { temperature: input.temperature, maxOutputTokens: input.maxTokens },
        },
        provider: "google",
        fetchFn,
        timeoutMs,
      });

      const root = asRecord(json);
      const candidate = asRecord(asArray(root.candidates)[0]);
      const parts = asArray(asRecord(candidate.content).parts).map(asRecord);

      const text = parts
        .filter((part) => typeof part.text === "string")
        .map((part) => stringOr(part.text, ""))
        .join("");
      const toolCalls: ToolCall[] = parts
        .filter((part) => part.functionCall !== undefined)
        .map((part, index) => {
          const call = asRecord(part.functionCall);
          return {
            // Google ne renvoie pas d'identifiant d'appel : on en synthétise un.
            id: `call_${index}`,
            name: stringOr(call.name, ""),
            arguments: asRecord(call.args),
          };
        });

      const usage = asRecord(root.usageMetadata);
      return {
        text,
        toolCalls,
        usage: {
          inputTokens: numberOr(usage.promptTokenCount, 0),
          outputTokens: numberOr(usage.candidatesTokenCount, 0),
        },
        latencyMs,
        modelServed: stringOr(root.modelVersion, input.model),
        raw: json,
      };
    },

    async listModels(): Promise<ModelDescriptor[]> {
      const { json } = await callJson({
        url: `${baseUrl}/models`,
        method: "GET",
        headers,
        provider: "google",
        fetchFn,
        timeoutMs,
      });
      return asArray(asRecord(json).models).map((entry) => {
        const model = asRecord(entry);
        const id = stringOr(model.name, "").replace(/^models\//, "");
        const methods = asArray(model.supportedGenerationMethods).filter(
          (m): m is string => typeof m === "string",
        );
        return {
          id,
          label: stringOr(model.displayName, id),
          contextTokens: numberOr(model.inputTokenLimit, 0),
          supportsTools: methods.includes("generateContent"),
        };
      });
    },
  };
}

/**
 * Parts Google. Un appel devient `functionCall`, un résultat
 * `functionResponse` — le texte libre ne relie rien à rien.
 */
function toGoogleParts(message: GenerateInput["messages"][number]): Record<string, unknown>[] {
  if (message.role === "tool") {
    return [
      {
        functionResponse: {
          name: message.name ?? message.toolCallId ?? "tool",
          response: { result: message.content },
        },
      },
    ];
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    const parts: Record<string, unknown>[] = [];
    if (message.content !== "") parts.push({ text: message.content });
    for (const call of message.toolCalls) {
      parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
    }
    return parts;
  }
  return [{ text: message.content }];
}
