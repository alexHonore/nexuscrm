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

export interface LLMResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  latencyMs: number;
  /** What actually answered — differs from the request on a router. */
  modelServed: string;
  /** Router's served-by upstream, e.g. "Anthropic", "Google Vertex". */
  upstreamProvider?: string;
  /** Raw provider response — persisted in agent_turn_traces.raw_response. */
  raw: unknown;
}

export interface GenerateInput {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tools?: ToolDef[];
  model: string;
  maxTokens: number;
  temperature: number;
  /** OpenRouter `provider` routing object; ignored by direct providers. */
  routing?: Record<string, unknown>;
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
  ) {
    super(message);
    this.name = "LLMProviderError";
  }
}
