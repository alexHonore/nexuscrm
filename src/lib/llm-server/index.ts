/**
 * Câblage serveur des fournisseurs LLM — LE SEUL endroit où l'environnement
 * rencontre `src/lib/llm`. La lib, elle, ne connaît que ses clés injectées.
 */
import "server-only";
import { createAnthropicProvider } from "@/lib/llm/anthropic";
import { createGoogleProvider } from "@/lib/llm/google";
import { createOpenAiProvider } from "@/lib/llm/openai";
import { createOpenRouterProvider } from "@/lib/llm/openrouter";
import type { LLMProvider, ModelDescriptor, ProviderId } from "@/lib/llm/types";

/** Clé absente = configuration incomplète, pas une panne silencieuse. */
export class LlmUnconfiguredError extends Error {
  constructor(readonly provider: ProviderId) {
    super(`llm_provider_unconfigured: ${provider}`);
    this.name = "LlmUnconfiguredError";
  }
}

function requireKey(value: string | undefined, provider: ProviderId): string {
  if (!value) throw new LlmUnconfiguredError(provider);
  return value;
}

export function getLlmProvider(id: ProviderId): LLMProvider {
  const env = process.env;
  switch (id) {
    case "openrouter":
      return createOpenRouterProvider({
        apiKey: requireKey(env.OPENROUTER_API_KEY, "openrouter"),
        baseUrl: env.OPENROUTER_BASE_URL,
        referer: env.OPENROUTER_SITE_URL ?? env.NEXT_PUBLIC_APP_URL,
        title: env.OPENROUTER_APP_NAME ?? "Nexus",
      });
    case "anthropic":
      return createAnthropicProvider({ apiKey: requireKey(env.ANTHROPIC_API_KEY, "anthropic") });
    case "google":
      return createGoogleProvider({ apiKey: requireKey(env.GOOGLE_API_KEY, "google") });
    case "openai":
      return createOpenAiProvider({ apiKey: requireKey(env.OPENAI_API_KEY, "openai") });
  }
}

/** Fournisseurs dont la clé est présente — pour griser les autres dans l'UI. */
export function configuredProviders(): ProviderId[] {
  const env = process.env;
  const available: ProviderId[] = [];
  if (env.OPENROUTER_API_KEY) available.push("openrouter");
  if (env.ANTHROPIC_API_KEY) available.push("anthropic");
  if (env.GOOGLE_API_KEY) available.push("google");
  if (env.OPENAI_API_KEY) available.push("openai");
  return available;
}

// ── Catalogue de modèles, en cache 6 h ───────────────────────────────────────

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const catalogCache = new Map<ProviderId, { at: number; models: ModelDescriptor[] }>();

/**
 * Liste des modèles d'un fournisseur, mise en cache six heures : le catalogue
 * bouge lentement et l'appeler à chaque ouverture du sélecteur est du gaspillage.
 */
export async function getModelCatalog(
  id: ProviderId,
  now: () => number = Date.now,
): Promise<ModelDescriptor[]> {
  const cached = catalogCache.get(id);
  if (cached && now() - cached.at < CATALOG_TTL_MS) return cached.models;

  const models = await getLlmProvider(id).listModels();
  catalogCache.set(id, { at: now(), models });
  return models;
}

/** Réservé aux tests — vide le cache mémoire. */
export function _resetCatalogCache(): void {
  catalogCache.clear();
}
