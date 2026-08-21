import {
  asArray,
  asRecord,
  callJson,
  numberOr,
  parseToolArguments,
  stringOr,
} from "./http";
import type { GenerateInput, LLMResult, ToolCall, ToolDef } from "./types";

/**
 * Corps commun OpenAI / OpenRouter : même forme de requête (`chat/completions`)
 * et de réponse (`choices[].message`). OpenRouter y ajoute son objet `provider`
 * et deux en-têtes ; c'est la seule divergence, passée en paramètre.
 */

export function toOpenAiTools(tools: ToolDef[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/**
 * Traduit un message maison vers la forme OpenAI.
 *
 * Un `tool` devient un vrai message `role: "tool"` porteur de son
 * `tool_call_id`, et l'assistant qui a émis l'appel le déclare dans
 * `tool_calls`. Sans ce couple, le modèle ne relie pas le résultat à sa
 * demande : il redemande.
 */
function toOpenAiMessage(message: GenerateInput["messages"][number]): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      // OpenAI accepte un contenu vide quand des appels d'outils sont présents.
      content: message.content === "" ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

export function buildChatBody(input: GenerateInput): Record<string, unknown> {
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    messages: [
      { role: "system", content: input.system },
      ...input.messages.map(toOpenAiMessage),
    ],
    tools: toOpenAiTools(input.tools),
  };
}

export function parseChatResponse(json: unknown, requestedModel: string, latencyMs: number): LLMResult {
  const root = asRecord(json);
  const choice = asRecord(asArray(root.choices)[0]);
  const message = asRecord(choice.message);

  const toolCalls: ToolCall[] = asArray(message.tool_calls).map((entry, index) => {
    const call = asRecord(entry);
    const fn = asRecord(call.function);
    return {
      id: stringOr(call.id, `call_${index}`),
      name: stringOr(fn.name, ""),
      arguments: parseToolArguments(fn.arguments),
    };
  });

  // Certains fournisseurs renvoient `content` en tableau de blocs : le traiter
  // comme vide effacerait le brouillon ET ferait passer tous les garde-fous.
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : asArray(content)
          .map((part) => stringOr(asRecord(part).text, ""))
          .join("");

  const usage = asRecord(root.usage);
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: numberOr(usage.prompt_tokens, 0),
      outputTokens: numberOr(usage.completion_tokens, 0),
      ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
    },
    latencyMs,
    modelServed: stringOr(root.model, requestedModel),
    ...(typeof root.provider === "string" ? { upstreamProvider: root.provider } : {}),
    raw: json,
  };
}

export interface ChatCallOptions {
  url: string;
  headers: Record<string, string>;
  provider: "openrouter" | "openai";
  fetchFn: typeof fetch;
  timeoutMs: number;
  extraBody?: Record<string, unknown>;
}

export async function chatCompletion(
  input: GenerateInput,
  options: ChatCallOptions,
): Promise<LLMResult> {
  const { json, latencyMs } = await callJson({
    url: options.url,
    headers: options.headers,
    body: { ...buildChatBody(input), ...(options.extraBody ?? {}) },
    provider: options.provider,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });
  return parseChatResponse(json, input.model, latencyMs);
}
