import {
  DEFAULT_LLM_TIMEOUT_MS,
  asArray,
  asRecord,
  callJson,
  numberOr,
  stringOr,
  type RetryPolicy,
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
 * Anthropic en direct — un intermédiaire de moins dans le chemin des données
 * (le prix : une deuxième clé d'API). Même interface que les autres : changer
 * de fournisseur reste un menu déroulant, sans redéploiement.
 */

const API_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
/** Quand le catalogue ne donne pas la fenêtre : valeur de référence. */
const DEFAULT_CONTEXT_TOKENS = 200_000;

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Reprise sur place d'un refus passager (429, 5xx) — voir `RetryPolicy`. */
  retry?: Partial<RetryPolicy>;
  /** Injecté par les tests : attendre pour de vrai les rendrait interminables. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Ce qu'un modèle Claude accepte, déduit de son identifiant.
 *
 * L'API a changé de dialecte en cours de route et REFUSE (400) ce qui ne
 * correspond pas au modèle appelé :
 *  · 3.7 → 4.5 : réflexion par `thinking: {type: "enabled", budget_tokens}`,
 *    incompatible avec une température autre que la valeur par défaut ;
 *  · 4.6 : réflexion ADAPTATIVE + `output_config.effort` ; `budget_tokens`
 *    déprécié ; la température est encore acceptée ;
 *  · 4.7, 4.8, 5 et suivants : adaptative seulement ; `budget_tokens` ET les
 *    paramètres d'échantillonnage (température…) font rejeter l'appel.
 * Envoyer le mauvais dialecte, c'est un `llm_error` à CHAQUE message client —
 * et `claude-sonnet-5` est le repli par défaut de tous les assistants.
 *
 * Un identifiant inconnu est traité comme un modèle récent : c'est la forme la
 * plus sobre (on n'envoie rien qu'on ne soit obligé d'envoyer).
 */
export interface AnthropicCapabilities {
  thinking: "adaptive" | "budget" | "none";
  /** `temperature` acceptée ? Faux à partir de 4.7, où elle fait rejeter l'appel. */
  sampling: boolean;
}

export function anthropicCapabilities(modelId: string): AnthropicCapabilities {
  const version = claudeVersion(modelId);
  if (version === null) return { thinking: "adaptive", sampling: false };
  const { major, minor } = version;
  if (major > 4 || (major === 4 && minor >= 7)) return { thinking: "adaptive", sampling: false };
  if (major === 4 && minor === 6) return { thinking: "adaptive", sampling: true };
  if (major === 4 || (major === 3 && minor >= 7)) return { thinking: "budget", sampling: true };
  return { thinking: "none", sampling: true };
}

/**
 * « claude-sonnet-4-5-20250929 » → 4.5 ; « claude-opus-5 » → 5.0 ;
 * « claude-3-7-sonnet-20250219 » → 3.7 ; « claude-opus-4-20250514 » → 4.0.
 * Le suffixe daté fait huit chiffres, la version mineure un ou deux : c'est ce
 * qui les distingue.
 */
function claudeVersion(modelId: string): { major: number; minor: number } | null {
  const modern = /^claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(
    modelId,
  );
  if (modern) return { major: Number(modern[1]), minor: Number(modern[2] ?? 0) };
  const legacy = /^claude-(\d+)(?:-(\d))?-(?:opus|sonnet|haiku)/.exec(modelId);
  if (legacy) return { major: Number(legacy[1]), minor: Number(legacy[2] ?? 0) };
  return null;
}

/**
 * Corps de la requête /v1/messages — exporté pour être vérifié jeton par jeton.
 *
 * Le niveau de réflexion est ENCODÉ, dans le dialecte du modèle : sans cela,
 * un assistant réglé sur « réflexion élevée » appellerait Anthropic sans rien
 * demander, et l'administrateur croirait que le modèle pèse ses décisions
 * d'outils alors que rien n'a changé.
 */
export function buildAnthropicBody(input: GenerateInput): Record<string, unknown> {
  const caps = anthropicCapabilities(input.model);
  const effort = input.reasoningEffort;
  const thinking = effort !== undefined && caps.thinking !== "none";
  const budget = thinking ? reasoningBudgetTokens(effort) : 0;
  // Avec `budget_tokens`, la température doit rester à sa valeur par défaut.
  const sampling = caps.sampling && !(thinking && caps.thinking === "budget");

  return {
    model: input.model,
    // La réflexion se paie sur `max_tokens` : le plafond configuré vise le
    // texte, le budget de réflexion s'y ajoute (voir reasoning.ts).
    max_tokens: input.maxTokens + budget,
    ...(sampling ? { temperature: input.temperature } : {}),
    system: input.system,
    messages: toAnthropicMessages(input.messages),
    tools: input.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    ...(thinking && caps.thinking === "adaptive"
      ? { thinking: { type: "adaptive" }, output_config: { effort } }
      : {}),
    ...(thinking && caps.thinking === "budget"
      ? { thinking: { type: "enabled", budget_tokens: budget } }
      : {}),
  };
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
        body: buildAnthropicBody(input),
        provider: "anthropic",
        fetchFn,
        timeoutMs,
        retry: options.retry,
        sleepFn: options.sleepFn,
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
        ...finishFields(anthropicFinishReason(root.stop_reason)),
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
        retry: options.retry,
        sleepFn: options.sleepFn,
      });
      return asArray(asRecord(json).data).map((entry) => {
        const model = asRecord(entry);
        const id = stringOr(model.id, "");
        // Le catalogue décrit depuis peu ce que chaque modèle sait faire ;
        // à défaut, l'identifiant tranche (même règle qu'à l'appel).
        const thinking = asRecord(asRecord(model.capabilities).thinking).supported;
        return {
          id,
          label: stringOr(model.display_name, id),
          contextTokens: numberOr(model.max_input_tokens, DEFAULT_CONTEXT_TOKENS),
          supportsTools: true,
          supportsReasoning:
            typeof thinking === "boolean" ? thinking : anthropicCapabilities(id).thinking !== "none",
        };
      });
    },
  };
}

/** `stop_reason` Anthropic → vocabulaire commun. */
function anthropicFinishReason(raw: unknown): FinishReason | undefined {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    case undefined:
    case null:
      return undefined;
    default:
      return "other";
  }
}

/**
 * Forme Anthropic : l'appel d'outil est un bloc `tool_use` dans le message de
 * l'assistant, et le résultat un bloc `tool_result` dans un message `user`.
 * Envoyer le résultat comme du texte libre laisse le modèle réémettre l'appel.
 *
 * Les résultats d'un même tour vont dans UN SEUL message `user` : découpés,
 * ils apprennent au modèle à ne plus paralléliser ses appels.
 */
function toAnthropicMessages(messages: LLMMessage[]): Record<string, unknown>[] {
  return groupToolResults(messages).map((turn) => {
    if (turn.kind === "tool_results") {
      return {
        role: "user",
        content: turn.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.toolCallId ?? "",
          content: result.content,
        })),
      };
    }
    const message = turn.message;
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: Record<string, unknown>[] = [];
      if (message.content !== "") blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
      }
      return { role: "assistant", content: blocks };
    }
    return { role: message.role, content: message.content };
  });
}
