import {
  DEFAULT_LLM_TIMEOUT_MS,
  asArray,
  asRecord,
  callJson,
  numberOr,
  stringOr,
} from "./http";
import { groupToolResults } from "./messages";
import { finishFields, reasoningBudgetTokens } from "./reasoning";
import type {
  FinishReason,
  GenerateInput,
  LLMMessage,
  LLMProvider,
  LLMResult,
  ModelDescriptor,
  ToolCall,
} from "./types";

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

/**
 * Un modèle Gemini qui sait réfléchir, d'après son identifiant — repli quand le
 * catalogue ne le dit pas lui-même. La réflexion arrive avec la génération 2.5
 * (avant, `thinkingConfig` fait rejeter l'appel) ; un alias « -latest » pointe
 * forcément sur une génération qui réfléchit.
 */
export function isGoogleThinkingModel(modelId: string): boolean {
  return /gemini-(2\.5|[3-9])/.test(modelId) || /^gemini-[a-z-]+-latest$/.test(modelId);
}

/**
 * Corps de `generateContent` — exporté pour être vérifié champ par champ.
 *
 * Le niveau de réflexion devient `thinkingConfig.thinkingBudget`, envoyé
 * seulement s'il est demandé : sans consigne, le modèle garde son réglage par
 * défaut (et un modèle sans réflexion n'est pas dérangé). Le budget s'ajoute à
 * `maxOutputTokens` : la réflexion se compte sur le même plafond que le texte,
 * et 300 jetons de SMS seraient mangés avant le premier mot.
 */
export function buildGoogleBody(input: GenerateInput): Record<string, unknown> {
  const budget = reasoningBudgetTokens(input.reasoningEffort);
  return {
    system_instruction: { parts: [{ text: input.system }] },
    contents: toGoogleContents(input.messages),
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
    generationConfig: {
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens + budget,
      ...(budget > 0 ? { thinkingConfig: { thinkingBudget: budget } } : {}),
    },
  };
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
        body: buildGoogleBody(input),
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
        ...finishFields(googleFinishReason(candidate.finishReason, toolCalls.length > 0)),
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
        // Le catalogue porte un drapeau `thinking` ; à défaut, l'identifiant
        // tranche. Sans ce drapeau, l'étape « réflexion » du sélecteur ne
        // s'ouvrirait jamais pour un modèle Google direct.
        const thinking = model.thinking;
        return {
          id,
          label: stringOr(model.displayName, id),
          contextTokens: numberOr(model.inputTokenLimit, 0),
          supportsTools: methods.includes("generateContent"),
          supportsReasoning: typeof thinking === "boolean" ? thinking : isGoogleThinkingModel(id),
        };
      });
    },
  };
}

/** `finishReason` du candidat → vocabulaire commun. */
function googleFinishReason(raw: unknown, hasToolCalls: boolean): FinishReason | undefined {
  switch (raw) {
    case "STOP":
      // Google dit « STOP » même quand le tour se termine sur des appels d'outils.
      return hasToolCalls ? "tool_calls" : "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter";
    case undefined:
    case null:
      return undefined;
    default:
      return "other";
  }
}

/**
 * Contenus Google. « model » et « user » seulement ; un résultat d'outil est un
 * `functionResponse` porté par un tour `user`, et TOUS les résultats d'un même
 * tour vont dans LE MÊME contenu — un tour par résultat fait rejeter la
 * requête quand le modèle a émis deux appels en parallèle.
 */
function toGoogleContents(messages: LLMMessage[]): Record<string, unknown>[] {
  return groupToolResults(messages).map((turn) => {
    if (turn.kind === "tool_results") {
      return {
        role: "user",
        parts: turn.results.map((result) => ({
          functionResponse: {
            name: result.name ?? result.toolCallId ?? "tool",
            response: { result: result.content },
          },
        })),
      };
    }
    const message = turn.message;
    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: toGoogleParts(message),
    };
  });
}

/**
 * Parts Google. Un appel devient `functionCall` — le texte libre ne relie rien
 * à rien.
 */
function toGoogleParts(message: LLMMessage): Record<string, unknown>[] {
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
