/**
 * LLM provider contracts — framework-agnostic (mission-brief rule: lifts into
 * another repo unchanged). No Next.js imports, no database client, no env
 * reads: keys and fetch arrive injected through each provider's factory.
 */

export type ProviderId = "openrouter" | "anthropic" | "google" | "openai";

export interface ModelDescriptor {
  /** "anthropic/claude-sonnet-5" on openrouter, "claude-sonnet-5" direct. */
  id: string;
  label: string;
  contextTokens: number;
  supportsTools: boolean;
  /** Le modèle accepte-t-il un niveau de réflexion? Décide de l'étape « effort ». */
  supportsReasoning?: boolean;
  /**
   * Le modèle accepte-t-il l'AUDIO en entrée (`input_audio`)? Seul OpenRouter
   * publie cette modalité dans son catalogue ; absent = inconnu, pas « non ».
   */
  supportsAudio?: boolean;
  /** USD per million tokens — informative; billing reads response usage. */
  inputPerMTok?: number;
  outputPerMTok?: number;
}

/** Tool offered to the model — provider impls translate to their native shape. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Provider-assigned id when it exists, else synthesized (google). */
  id: string;
  name: string;
  /** Parsed arguments — zod-validated by the caller before any handler runs. */
  arguments: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** USD as reported by the provider (openrouter) — absent elsewhere. */
  costUsd?: number;
}

/**
 * Pourquoi le modèle s'est arrêté, dans un vocabulaire commun aux fournisseurs.
 *
 * `length` est le cas qui compte : la réponse a été coupée par le plafond de
 * jetons. Sans ce signal, un brouillon tronqué en pleine phrase passe les
 * garde-fous et part tel quel au client, et une réponse vide (tout le budget
 * mangé par la réflexion) devient une escalade « sans texte » inexplicable.
 */
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "other";

export interface LLMResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  latencyMs: number;
  /** What actually answered — differs from the request on a router. */
  modelServed: string;
  /** Router's served-by upstream, e.g. "Anthropic", "Google Vertex". */
  upstreamProvider?: string;
  /** Motif d'arrêt normalisé — absent si le fournisseur ne l'a pas dit. */
  finishReason?: FinishReason;
  /** Vrai quand le plafond de jetons a coupé la réponse (`finishReason: "length"`). */
  truncated?: boolean;
  /** Raw provider response — persisted in agent_turn_traces.raw_response. */
  raw: unknown;
}

/**
 * Un message du fil, y compris les RÉSULTATS D'OUTILS.
 *
 * Le rôle `tool` n'est pas un détail de confort : sans lui, un résultat d'outil
 * doit être maquillé en message `user`, et le modèle ne voit jamais que son
 * propre appel a abouti. Il le réémet alors au tour suivant et n'écrit rien —
 * c'est exactement ce qui faisait répondre « (aucun texte) » après un
 * `update_qualification`.
 */
export interface LLMMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** `assistant` : les appels que ce tour a émis. */
  toolCalls?: ToolCall[];
  /** `tool` : l'appel auquel ce résultat répond. */
  toolCallId?: string;
  /** `tool` : le nom de l'outil — exigé par certains fournisseurs. */
  name?: string;
}

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Reprise sur LE MÊME modèle après un refus passager (429, 5xx).
 *
 * Le contrat vit ici plutôt que dans le transport parce qu'il voyage avec
 * l'APPEL : c'est la configuration de l'assistant qui le décide, pas la clé
 * qui a servi à construire le fournisseur. Valeurs par défaut et mise en
 * œuvre : `http.ts`.
 */
export interface RetryPolicy {
  /** Tentatives TOTALES, reprises comprises. 1 = aucune reprise. */
  attempts: number;
  baseDelayMs: number;
  /** Plafond d'UNE attente, `Retry-After` de l'amont compris. */
  maxDelayMs: number;
  /** Plafond de l'attente CUMULÉE d'un appel — non réglable, voir `http.ts`. */
  maxTotalDelayMs: number;
}

export interface GenerateInput {
  system: string;
  messages: LLMMessage[];
  tools?: ToolDef[];
  /**
   * Niveau de réflexion. Plus d'effort = meilleures décisions d'outil, mais
   * plus de jetons facturés ET plus de latence — sur un SMS, une réponse qui
   * met huit secondes de plus se remarque.
   */
  reasoningEffort?: ReasoningEffort;
  model: string;
  maxTokens: number;
  temperature: number;
  /** OpenRouter `provider` routing object; ignored by direct providers. */
  routing?: Record<string, unknown>;
  /**
   * Reprise d'un refus passager, POUR CET APPEL — voir `RetryPolicy`.
   *
   * Elle voyage avec l'appel et non avec le fournisseur : le fournisseur est
   * construit à partir de l'environnement (une clé), la politique vient de la
   * configuration de l'assistant. Absente = les défauts du transport.
   */
  retry?: Partial<RetryPolicy>;
}

export interface LLMProvider {
  id: ProviderId;
  /** Cached ~6h by the caller; OpenRouter hits /models. */
  listModels(): Promise<ModelDescriptor[]>;
  generate(input: GenerateInput): Promise<LLMResult>;
}

/** Thrown on transport/HTTP failures — carries what retry logic needs. */
export class LLMProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly status?: number,
    readonly retryable = false,
    /**
     * Attente demandée par l'amont (en-tête `Retry-After`), en millisecondes.
     * Un 429 dit souvent COMBIEN de temps attendre : reprendre plus tôt ne
     * fait que consommer un deuxième refus.
     */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LLMProviderError";
  }
}
