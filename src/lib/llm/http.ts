import { LLMProviderError, type ProviderId } from "./types";

/**
 * Transport partagé des fournisseurs LLM : délai plafonné, erreurs normalisées.
 *
 * Un appel qui pend n'est pas une erreur visible — sans plafond il bloquerait
 * le tour d'agent (et, en phase 4, le job du dispatcher) jusqu'à l'expiration
 * de la fonction. `retryable` distingue ce qui mérite un repli (5xx, 429,
 * délai — et 402 : le COMPTE est à sec, pas la requête ; un autre fournisseur
 * peut répondre) de ce qui ne le mérite pas (400, 401 : la requête est
 * fautive, la rejouer ailleurs ne ferait que doubler la facture).
 */

export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

export interface HttpCallInput {
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  provider: ProviderId;
  fetchFn: typeof fetch;
  timeoutMs: number;
}

/** Retourne le JSON parsé et la latence mesurée. Lève un LLMProviderError. */
export async function callJson(
  input: HttpCallInput,
): Promise<{ json: unknown; latencyMs: number }> {
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await input.fetchFn(input.url, {
      method: input.method ?? "POST",
      headers: { "Content-Type": "application/json", ...input.headers },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new LLMProviderError(
        `llm_timeout after ${input.timeoutMs}ms`,
        input.provider,
        undefined,
        true,
      );
    }
    throw new LLMProviderError(
      err instanceof Error ? err.message : String(err),
      input.provider,
      undefined,
      true,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new LLMProviderError(
      `llm_http_${res.status}: ${describeError(text)}`,
      input.provider,
      res.status,
      res.status >= 500 || res.status === 429 || res.status === 402,
    );
  }

  try {
    return { json: JSON.parse(text), latencyMs: Date.now() - startedAt };
  } catch {
    throw new LLMProviderError("llm_malformed_response", input.provider, res.status, false);
  }
}

/** Message d'erreur du fournisseur, sans jamais relayer un corps entier. */
function describeError(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") return error.slice(0, 200);
      if (error !== null && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message.slice(0, 200);
      }
      if (typeof record.message === "string") return record.message.slice(0, 200);
    }
  } catch {
    // corps non JSON
  }
  return text.slice(0, 200);
}

/** Arguments d'outil : parfois une chaîne JSON, parfois un objet. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Un modèle qui bafouille ses arguments ne doit pas faire tomber le tour :
    // l'appelant validera par zod et traitera l'absence d'argument.
    return {};
  }
}

/** Accès sûr à un sous-objet d'une réponse JSON non typée. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}
