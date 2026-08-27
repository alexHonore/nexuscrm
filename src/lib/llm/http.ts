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

/**
 * Reprise sur LE MÊME modèle, avant tout repli.
 *
 * « openai/gpt-5.6-luna is temporarily rate-limited upstream. Please retry
 * shortly » : l'amont demande littéralement une reprise, et sans elle un
 * embouteillage de deux secondes faisait échouer une fixture de la suite (donc
 * bloquait l'activation) ou escaladait une conversation vers un humain. Un
 * refus 429 ou 5xx n'a rien produit : le rejouer ne coûte rien de plus.
 *
 * Ce qui n'est PAS repris ici : le délai dépassé (l'amont peut être en train
 * de rédiger — payer deux fois, et 3 × 60 s dépasse le temps de la fonction)
 * et le 402 (le compte est à sec : attendre n'y changera rien). Ces deux-là
 * sont l'affaire du repli, qui change de modèle — voir `route.ts`.
 */
export interface RetryPolicy {
  /** Tentatives TOTALES, reprises comprises. 1 = aucune reprise. */
  attempts: number;
  baseDelayMs: number;
  /** Plafond d'attente, `Retry-After` de l'amont compris. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 800,
  maxDelayMs: 10_000,
};

export interface HttpCallInput {
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  provider: ProviderId;
  fetchFn: typeof fetch;
  timeoutMs: number;
  /** Politique de reprise — défauts ci-dessus si absente. */
  retry?: Partial<RetryPolicy>;
  /** Injecté par les tests : attendre pour de vrai rendrait la suite interminable. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Un embouteillage passager, par opposition à une requête fautive. */
function isCongestion(status: number | undefined): boolean {
  return status !== undefined && (status === 429 || status >= 500);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Attente avant la reprise `attempt` (1 = première reprise) : progression
 * géométrique, bruitée de ±25 % pour ne pas relancer douze conversations à la
 * milliseconde près, et remplacée par `Retry-After` quand l'amont l'a dit.
 */
function delayFor(attempt: number, policy: RetryPolicy, retryAfterMs: number | undefined): number {
  const base = retryAfterMs ?? policy.baseDelayMs * Math.pow(3, attempt - 1);
  const jittered = retryAfterMs === undefined ? base * (0.75 + Math.random() * 0.5) : base;
  return Math.round(Math.min(policy.maxDelayMs, jittered));
}

/**
 * Retourne le JSON parsé et la latence mesurée. Lève un LLMProviderError.
 *
 * Un refus passager (429, 5xx) est rejoué sur place avant de remonter : voir
 * `RetryPolicy`. La latence retournée est celle de la tentative qui a abouti.
 */
export async function callJson(
  input: HttpCallInput,
): Promise<{ json: unknown; latencyMs: number }> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...input.retry };
  const wait = input.sleepFn ?? sleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptJson(input);
    } catch (err) {
      const congested =
        err instanceof LLMProviderError && err.retryable && isCongestion(err.status);
      if (!congested || attempt >= policy.attempts) throw err;
      await wait(delayFor(attempt, policy, (err as LLMProviderError).retryAfterMs));
    }
  }
}

/** UNE tentative — sans reprise ni attente. */
async function attemptJson(input: HttpCallInput): Promise<{ json: unknown; latencyMs: number }> {
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
      retryAfterMs(res.headers),
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LLMProviderError("llm_malformed_response", input.provider, res.status, false);
  }

  // OpenRouter renvoie parfois l'erreur DANS un 200 : {"error":{"message":
  // "…rate-limited upstream…","code":429}}. Traitée comme un succès, la
  // réponse « sans choices » donnait un texte vide — le tour partait en
  // « l'assistant n'a rien écrit » (escalade) au lieu d'être rejoué, et 80
  // fils ont fini chez un humain pendant l'incident du 2026-08-25.
  const embedded = embeddedError(json);
  if (embedded !== null) {
    throw new LLMProviderError(
      `llm_upstream_${embedded.code ?? "error"}: ${embedded.message.slice(0, 200)}`,
      input.provider,
      embedded.code,
      // Code inconnu : une erreur maquillée en 200 est une bizarrerie d'amont,
      // la rejouer est le pari raisonnable. Codes connus : même règle que plus
      // haut (5xx, 429, 408, 402 = repli ; 4xx restants = requête fautive).
      embedded.code === undefined ||
        embedded.code >= 500 ||
        embedded.code === 429 ||
        embedded.code === 408 ||
        embedded.code === 402,
      retryAfterMs(res.headers),
    );
  }

  return { json, latencyMs: Date.now() - startedAt };
}

/**
 * `Retry-After` en millisecondes — secondes ou date HTTP, les deux formes
 * existent. Une valeur illisible vaut « rien dit », pas zéro.
 */
function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** L'erreur qu'un relais glisse dans un corps 2xx, ou null si le corps est sain. */
function embeddedError(json: unknown): { message: string; code?: number } | null {
  if (json === null || typeof json !== "object") return null;
  const error = (json as Record<string, unknown>).error;
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return { message: error };
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : JSON.stringify(record).slice(0, 200);
    const rawCode = record.code ?? record.status;
    const code =
      typeof rawCode === "number"
        ? rawCode
        : typeof rawCode === "string" && /^\d{3}$/.test(rawCode)
          ? Number(rawCode)
          : undefined;
    return code === undefined ? { message } : { message, code };
  }
  return null;
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
