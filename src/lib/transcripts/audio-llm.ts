import { callJson } from "@/lib/llm/http";
import { parseChatResponse } from "@/lib/llm/openai-compatible";
import { OPENROUTER_DEFAULT_BASE_URL, toOpenRouterProvider } from "@/lib/llm/openrouter";
import type { LLMResult } from "@/lib/llm/types";

/**
 * Appel multimodal AUDIO vers OpenRouter — hors de `LLMProvider.generate`,
 * dont le contrat (`content: string`) est volontairement texte-seulement et
 * partagé par quatre fournisseurs. Ici, un seul chemin suffit : OpenRouter est
 * le seul fournisseur câblé dont le routage impose deny + ZDR, et un
 * enregistrement d'appel (voix, noms, projets de déménagement de Québécois)
 * est ce qu'on a de plus sensible à envoyer.
 *
 * Le corps réutilise le dialecte OpenAI (`input_audio` dans un contenu en
 * tableau) et la réponse repasse par `parseChatResponse` : mêmes jetons, même
 * `usage.cost` réel — la page de consommation additionne des chiffres de même
 * nature que ceux des tours d'agent.
 */

/** L'audio d'un appel de 45 min prend du temps à mâcher — bien plus que 60 s. */
export const AUDIO_LLM_TIMEOUT_MS = 180_000;

export interface AudioGenerateInput {
  apiKey: string;
  baseUrl?: string;
  referer?: string;
  title?: string;
  model: string;
  system: string;
  userText: string;
  audio: { base64: string; format: "mp3" | "wav" };
  maxTokens: number;
  temperature: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export async function generateFromAudio(input: AudioGenerateInput): Promise<LLMResult> {
  const baseUrl = (input.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/$/, "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
    ...(input.referer ? { "HTTP-Referer": input.referer } : {}),
    ...(input.title ? { "X-Title": input.title, "X-OpenRouter-Title": input.title } : {}),
  };
  const body = {
    model: input.model,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    messages: [
      { role: "system", content: input.system },
      {
        role: "user",
        content: [
          { type: "text", text: input.userText },
          { type: "input_audio", input_audio: { data: input.audio.base64, format: input.audio.format } },
        ],
      },
    ],
    // Mêmes exigences que le moteur SMS (openrouter.ts) : deny ET zdr — deux
    // contrôles distincts — et pas de reroutage silencieux vers un hébergeur
    // dont le chemin de données n'a pas été validé.
    provider: toOpenRouterProvider({ dataCollection: "deny", zdr: true, allowFallbacks: false }),
    // Sans cette demande explicite, OpenRouter ne renvoie pas `usage.cost` et
    // la page de consommation sous-compterait (constat du 2026-08-26).
    usage: { include: true },
  };
  const { json, latencyMs } = await callJson({
    url: `${baseUrl}/chat/completions`,
    headers,
    body,
    provider: "openrouter",
    fetchFn: input.fetchFn ?? fetch,
    timeoutMs: input.timeoutMs ?? AUDIO_LLM_TIMEOUT_MS,
    // UNE seule reprise ici, là où le moteur SMS en accorde deux : un appel
    // audio tient déjà jusqu'à 180 s et le job dispose de 300 s. Le job, lui,
    // est de toute façon remis en file après une erreur passagère.
    retry: { attempts: 2 },
  });
  return parseChatResponse(json, input.model, latencyMs);
}
