/**
 * Unitaire — les quatre fournisseurs LLM derrière UNE seule interface.
 * Aucun réseau : `fetchFn` est toujours injecté.
 *
 * L'exigence centrale du cahier (§21) : la MÊME fixture, passée par OpenRouter
 * ou par Anthropic en direct, ressort dans la MÊME forme normalisée d'appels
 * d'outils. C'est ce qui permet de changer de fournisseur par menu déroulant
 * sans toucher au moteur.
 *
 * Et, depuis la revue : le niveau de réflexion est ENCODÉ chez chaque
 * fournisseur direct, dans son dialecte, vérifié sur le corps exact de la
 * requête — un effort « élevé » qui n'arrive jamais au modèle est pire qu'un
 * effort absent, parce que l'administrateur croit qu'il agit.
 */
import { describe, expect, it } from "vitest";
import { createOpenRouterProvider, toOpenRouterProvider } from "@/lib/llm/openrouter";
import {
  anthropicCapabilities,
  buildAnthropicBody,
  createAnthropicProvider,
} from "@/lib/llm/anthropic";
import { buildGoogleBody, createGoogleProvider, isGoogleThinkingModel } from "@/lib/llm/google";
import { createOpenAiProvider, isOpenAiReasoningModel } from "@/lib/llm/openai";
import { UTILITY_MODEL_BY_PROVIDER } from "@/lib/llm/defaults";
import { groupToolResults } from "@/lib/llm/messages";
import { REASONING_BUDGET_TOKENS } from "@/lib/llm/reasoning";
import { generateWithChain } from "@/lib/llm/route";
import {
  LLMProviderError,
  type GenerateInput,
  type LLMMessage,
  type LLMProvider,
  type ProviderId,
} from "@/lib/llm/types";

// ── Faux transport ───────────────────────────────────────────────────────────

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function makeFetch(status: number, payload: unknown) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  };
  return { fetchFn, calls };
}

const GET_SLOTS_TOOL = {
  name: "get_slots",
  description: "Retourne les disponibilités réelles du courtier",
  parameters: { type: "object", properties: { count: { type: "number" } } },
};

const INPUT: GenerateInput = {
  system: "Tu es un assistant de suivi.",
  messages: [{ role: "user", content: "Oui allo" }],
  tools: [GET_SLOTS_TOOL],
  model: "anthropic/claude-sonnet-5",
  maxTokens: 300,
  temperature: 0.6,
  routing: { dataCollection: "deny", zdr: true, allowFallbacks: false, only: [] },
};

/**
 * Un tour où l'assistant a émis DEUX appels en parallèle, et où le moteur
 * renvoie un message `tool` par résultat — exactement ce que fait runtime.ts.
 */
const PARALLEL_TOOL_MESSAGES: LLMMessage[] = [
  { role: "user", content: "Oui allo" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "c1", name: "update_qualification", arguments: { intent: "sell" } },
      { id: "c2", name: "get_slots", arguments: { count: 2 } },
    ],
  },
  { role: "tool", toolCallId: "c1", name: "update_qualification", content: "ok" },
  { role: "tool", toolCallId: "c2", name: "get_slots", content: "jeudi 14h" },
];

// ── OpenRouter ───────────────────────────────────────────────────────────────

describe("createOpenRouterProvider", () => {
  const openRouterAnswer = {
    model: "anthropic/claude-sonnet-5",
    provider: "Anthropic",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: "Parfait!",
          tool_calls: [
            { id: "tc_1", function: { name: "get_slots", arguments: '{"count":2}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0021 },
  };

  it("assemble la requête : URL, Bearer, en-têtes d'identification, outils", async () => {
    const { fetchFn, calls } = makeFetch(200, openRouterAnswer);
    const provider = createOpenRouterProvider({
      apiKey: "sk-or-test",
      referer: "https://groupe-nexus.vercel.app",
      title: "Nexus",
      fetchFn,
    });

    await provider.generate(INPUT);

    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-or-test");
    expect(calls[0].headers["HTTP-Referer"]).toBe("https://groupe-nexus.vercel.app");
    expect(calls[0].headers["X-Title"]).toBe("Nexus");
    expect(calls[0].headers["X-OpenRouter-Title"]).toBe("Nexus");

    const messages = calls[0].body.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: INPUT.system });
    const tools = calls[0].body.tools as { type: string; function: { name: string } }[];
    expect(tools[0].function.name).toBe("get_slots");
    // Sans effort demandé : ni `reasoning`, ni marge sur le plafond.
    expect(calls[0].body.reasoning).toBeUndefined();
    expect(calls[0].body.max_tokens).toBe(300);
    // Le COÛT est demandé à chaque appel : sans `usage.include`, OpenRouter
    // ne renvoie pas `usage.cost` et la consommation IA se croit à ~1/8 de la
    // dépense réelle du compte (constat du 2026-08-26).
    expect(calls[0].body.usage).toEqual({ include: true });
  });

  it("traduit le routage en noms OpenRouter — deny + ZDR + aucun reroutage", async () => {
    const { fetchFn, calls } = makeFetch(200, openRouterAnswer);
    const provider = createOpenRouterProvider({ apiKey: "k", fetchFn });

    await provider.generate(INPUT);

    expect(calls[0].body.provider).toEqual({
      data_collection: "deny",
      zdr: true,
      allow_fallbacks: false,
    });
  });

  it("encode l'effort de réflexion ET ajoute le budget au plafond", async () => {
    // Le routeur taille la réflexion en proportion de max_tokens : sans marge,
    // 300 jetons à effort élevé laissent une soixantaine de jetons de texte.
    const { fetchFn, calls } = makeFetch(200, openRouterAnswer);
    await createOpenRouterProvider({ apiKey: "k", fetchFn }).generate({
      ...INPUT,
      reasoningEffort: "high",
    });
    expect(calls[0].body.reasoning).toEqual({ effort: "high" });
    expect(calls[0].body.max_tokens).toBe(300 + REASONING_BUDGET_TOKENS.high);
  });

  it("normalise la réponse, y compris le modèle RÉELLEMENT servi et le motif d'arrêt", async () => {
    const { fetchFn } = makeFetch(200, openRouterAnswer);
    const provider = createOpenRouterProvider({ apiKey: "k", fetchFn });

    const result = await provider.generate({ ...INPUT, model: "openrouter/auto" });

    expect(result.text).toBe("Parfait!");
    expect(result.toolCalls).toEqual([{ id: "tc_1", name: "get_slots", arguments: { count: 2 } }]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.0021 });
    // Sur un routeur, « quel modèle a répondu » n'est pas « lequel ai-je demandé ».
    expect(result.modelServed).toBe("anthropic/claude-sonnet-5");
    expect(result.upstreamProvider).toBe("Anthropic");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.truncated).toBe(false);
  });

  it("une réponse coupée par le plafond est SIGNALÉE tronquée", async () => {
    const { fetchFn } = makeFetch(200, {
      model: "anthropic/claude-sonnet-5",
      choices: [{ finish_reason: "length", message: { content: "Jeudi 14h ou vend" } }],
      usage: { prompt_tokens: 1, completion_tokens: 300 },
    });
    const result = await createOpenRouterProvider({ apiKey: "k", fetchFn }).generate(INPUT);
    expect(result.finishReason).toBe("length");
    expect(result.truncated).toBe(true);
  });

  it("un fournisseur muet sur le motif d'arrêt ne pose ni vrai ni faux", async () => {
    const { fetchFn } = makeFetch(200, {
      choices: [{ message: { content: "Parfait!" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const result = await createOpenRouterProvider({ apiKey: "k", fetchFn }).generate(INPUT);
    expect(result.finishReason).toBeUndefined();
    expect(result.truncated).toBeUndefined();
  });

  it("liste les modèles avec support d'outils et prix par million de jetons", async () => {
    const { fetchFn } = makeFetch(200, {
      data: [
        {
          id: "anthropic/claude-sonnet-5",
          name: "Claude Sonnet 5",
          context_length: 200000,
          supported_parameters: ["tools", "temperature"],
          pricing: { prompt: "0.000003", completion: "0.000015" },
        },
        { id: "vieux/modele", context_length: 8000, supported_parameters: ["temperature"] },
      ],
    });
    const models = await createOpenRouterProvider({ apiKey: "k", fetchFn }).listModels();

    expect(models[0]).toMatchObject({
      id: "anthropic/claude-sonnet-5",
      label: "Claude Sonnet 5",
      contextTokens: 200000,
      supportsTools: true,
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
    // Un agent à sept outils sur un modèle sans outils échoue en silence :
    // le drapeau doit être visible, pas deviné.
    expect(models[1].supportsTools).toBe(false);
  });

  it("toOpenRouterProvider omet une liste `only` vide", () => {
    expect(toOpenRouterProvider({ zdr: true, only: [] })).toEqual({ zdr: true });
    expect(toOpenRouterProvider({ zdr: true, only: ["anthropic"] })).toEqual({
      zdr: true,
      only: ["anthropic"],
    });
    expect(toOpenRouterProvider(undefined)).toBeUndefined();
  });
});

// ── Anthropic ────────────────────────────────────────────────────────────────

describe("createAnthropicProvider", () => {
  const anthropicAnswer = {
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "Parfait!" },
      { type: "tool_use", id: "tc_1", name: "get_slots", input: { count: 2 } },
    ],
    usage: { input_tokens: 120, output_tokens: 30 },
  };

  it("assemble la requête au format Anthropic (x-api-key, version, input_schema)", async () => {
    const { fetchFn, calls } = makeFetch(200, anthropicAnswer);
    const provider = createAnthropicProvider({ apiKey: "sk-ant-test", fetchFn });

    await provider.generate({ ...INPUT, model: "claude-sonnet-5" });

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].body.system).toBe(INPUT.system);
    const tools = calls[0].body.tools as { name: string; input_schema: unknown }[];
    expect(tools[0]).toMatchObject({ name: "get_slots", input_schema: GET_SLOTS_TOOL.parameters });
  });

  it("normalise blocs texte et tool_use, et le motif d'arrêt", async () => {
    const { fetchFn } = makeFetch(200, anthropicAnswer);
    const result = await createAnthropicProvider({ apiKey: "k", fetchFn }).generate({
      ...INPUT,
      model: "claude-sonnet-5",
    });

    expect(result.text).toBe("Parfait!");
    expect(result.toolCalls).toEqual([{ id: "tc_1", name: "get_slots", arguments: { count: 2 } }]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(result.modelServed).toBe("claude-sonnet-5");
    expect(result.upstreamProvider).toBeUndefined();
    expect(result.finishReason).toBe("tool_calls");
    expect(result.truncated).toBe(false);
  });

  it("stop_reason max_tokens → tronqué ; end_turn → complet", async () => {
    const cut = await createAnthropicProvider({
      apiKey: "k",
      fetchFn: makeFetch(200, {
        model: "claude-sonnet-5",
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "Jeudi 14h ou vend" }],
        usage: { input_tokens: 1, output_tokens: 300 },
      }).fetchFn,
    }).generate({ ...INPUT, model: "claude-sonnet-5" });
    expect(cut.finishReason).toBe("length");
    expect(cut.truncated).toBe(true);

    const done = await createAnthropicProvider({
      apiKey: "k",
      fetchFn: makeFetch(200, {
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Parfait!" }],
        usage: { input_tokens: 1, output_tokens: 3 },
      }).fetchFn,
    }).generate({ ...INPUT, model: "claude-sonnet-5" });
    expect(done.finishReason).toBe("stop");
    expect(done.truncated).toBe(false);
  });

  it("les résultats d'appels parallèles vont dans UN SEUL message user", async () => {
    const { fetchFn, calls } = makeFetch(200, anthropicAnswer);
    await createAnthropicProvider({ apiKey: "k", fetchFn }).generate({
      ...INPUT,
      model: "claude-sonnet-5",
      messages: PARALLEL_TOOL_MESSAGES,
    });
    const messages = calls[0].body.messages as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "ok" },
      { type: "tool_result", tool_use_id: "c2", content: "jeudi 14h" },
    ]);
  });

  it("liste les modèles : fenêtre et réflexion lues du catalogue, identifiant en repli", async () => {
    const { fetchFn } = makeFetch(200, {
      data: [
        {
          id: "claude-sonnet-5",
          display_name: "Claude Sonnet 5",
          max_input_tokens: 1000000,
          capabilities: { thinking: { supported: true } },
        },
        { id: "claude-3-5-haiku-20241022", display_name: "Claude Haiku 3.5" },
        { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
      ],
    });
    const models = await createAnthropicProvider({ apiKey: "k", fetchFn }).listModels();
    expect(models[0]).toEqual({
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      contextTokens: 1000000,
      supportsTools: true,
      supportsReasoning: true,
    });
    expect(models[1]).toMatchObject({ contextTokens: 200000, supportsReasoning: false });
    expect(models[2]).toMatchObject({ supportsReasoning: true });
  });
});

describe("Anthropic — dialecte de réflexion selon le modèle", () => {
  const withEffort = (model: string, reasoningEffort: GenerateInput["reasoningEffort"]) =>
    buildAnthropicBody({ ...INPUT, model, reasoningEffort });

  it("reconnaît la génération d'un identifiant, daté ou non", () => {
    expect(anthropicCapabilities("claude-sonnet-5")).toEqual({ thinking: "adaptive", sampling: false });
    expect(anthropicCapabilities("claude-opus-4-8")).toEqual({ thinking: "adaptive", sampling: false });
    expect(anthropicCapabilities("claude-opus-4-7")).toEqual({ thinking: "adaptive", sampling: false });
    expect(anthropicCapabilities("claude-sonnet-4-6")).toEqual({ thinking: "adaptive", sampling: true });
    expect(anthropicCapabilities("claude-haiku-4-5")).toEqual({ thinking: "budget", sampling: true });
    expect(anthropicCapabilities("claude-sonnet-4-5-20250929")).toEqual({ thinking: "budget", sampling: true });
    expect(anthropicCapabilities("claude-opus-4-1-20250805")).toEqual({ thinking: "budget", sampling: true });
    // Suffixe daté de huit chiffres ≠ version mineure : 4.0, pas 4.20250514.
    expect(anthropicCapabilities("claude-opus-4-20250514")).toEqual({ thinking: "budget", sampling: true });
    expect(anthropicCapabilities("claude-3-7-sonnet-20250219")).toEqual({ thinking: "budget", sampling: true });
    expect(anthropicCapabilities("claude-3-5-haiku-20241022")).toEqual({ thinking: "none", sampling: true });
    // Inconnu : la forme la plus sobre.
    expect(anthropicCapabilities("claude-nova-6")).toEqual({ thinking: "adaptive", sampling: false });
  });

  it("modèle récent : réflexion ADAPTATIVE + output_config.effort, jamais budget_tokens", () => {
    const body = withEffort("claude-sonnet-5", "high");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
    // La réflexion se paie sur max_tokens : le plafond du texte reste 300.
    expect(body.max_tokens).toBe(300 + REASONING_BUDGET_TOKENS.high);
    // Les paramètres d'échantillonnage font rejeter l'appel sur 4.7+ et 5.
    expect(body).not.toHaveProperty("temperature");
  });

  it("modèle récent sans effort : rien d'ajouté — et toujours pas de température", () => {
    const body = withEffort("claude-sonnet-5", undefined);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_tokens).toBe(300);
  });

  it("4.6 : adaptative, ET la température reste acceptée", () => {
    const body = withEffort("claude-sonnet-4-6", "low");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.temperature).toBe(0.6);
  });

  it("ancien modèle : budget_tokens, plafond relevé d'autant, température omise", () => {
    const body = withEffort("claude-haiku-4-5", "medium");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: REASONING_BUDGET_TOKENS.medium });
    expect(body.max_tokens).toBe(300 + REASONING_BUDGET_TOKENS.medium);
    expect(body).not.toHaveProperty("output_config");
    // Avec budget_tokens, toute température autre que la valeur par défaut est refusée.
    expect(body).not.toHaveProperty("temperature");
    // Le budget respecte le minimum d'Anthropic (1024).
    expect(REASONING_BUDGET_TOKENS.low).toBeGreaterThanOrEqual(1024);
  });

  it("ancien modèle sans effort : température envoyée, aucune réflexion", () => {
    const body = withEffort("claude-haiku-4-5", undefined);
    expect(body.temperature).toBe(0.6);
    expect(body).not.toHaveProperty("thinking");
    expect(body.max_tokens).toBe(300);
  });

  it("modèle sans réflexion : l'effort est ignoré plutôt que de faire rejeter l'appel", () => {
    const body = withEffort("claude-3-5-haiku-20241022", "high");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(body.temperature).toBe(0.6);
    expect(body.max_tokens).toBe(300);
  });
});

// ── §21 : parité entre fournisseurs ──────────────────────────────────────────

describe("§21 — parité des fournisseurs", () => {
  it("la même fixture ressort identique par OpenRouter et par Anthropic direct", async () => {
    const viaRouter = await createOpenRouterProvider({
      apiKey: "k",
      fetchFn: makeFetch(200, {
        model: "anthropic/claude-sonnet-5",
        provider: "Anthropic",
        choices: [
          {
            message: {
              content: "Jeudi 14h ou vendredi 18h30?",
              tool_calls: [{ id: "a", function: { name: "get_slots", arguments: '{"count":2}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }).fetchFn,
    }).generate(INPUT);

    const viaDirect = await createAnthropicProvider({
      apiKey: "k",
      fetchFn: makeFetch(200, {
        model: "claude-sonnet-5",
        content: [
          { type: "text", text: "Jeudi 14h ou vendredi 18h30?" },
          { type: "tool_use", id: "b", name: "get_slots", input: { count: 2 } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }).fetchFn,
    }).generate({ ...INPUT, model: "claude-sonnet-5" });

    const normalise = (r: { text: string; toolCalls: { name: string; arguments: unknown }[] }) => ({
      text: r.text,
      toolCalls: r.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
    });
    expect(normalise(viaRouter)).toEqual(normalise(viaDirect));
    expect(viaRouter.usage.inputTokens).toBe(viaDirect.usage.inputTokens);
  });
});

// ── Google ───────────────────────────────────────────────────────────────────

describe("createGoogleProvider", () => {
  const googleAnswer = {
    modelVersion: "gemini-flash-latest",
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [{ text: "Parfait!" }, { functionCall: { name: "get_slots", args: { count: 2 } } }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
  };

  it("assemble system_instruction, contents et function_declarations", async () => {
    const { fetchFn, calls } = makeFetch(200, googleAnswer);
    const provider = createGoogleProvider({ apiKey: "goog-test", fetchFn });

    const result = await provider.generate({
      ...INPUT,
      model: "gemini-flash-latest",
      messages: [
        { role: "user", content: "Oui allo" },
        { role: "assistant", content: "Bonjour!" },
      ],
    });

    expect(calls[0].url).toContain("/models/gemini-flash-latest:generateContent");
    expect(calls[0].headers["x-goog-api-key"]).toBe("goog-test");
    const contents = calls[0].body.contents as { role: string }[];
    // « assistant » devient « model » côté Google.
    expect(contents.map((c) => c.role)).toEqual(["user", "model"]);
    const tools = calls[0].body.tools as { function_declarations: { name: string }[] }[];
    expect(tools[0].function_declarations[0].name).toBe("get_slots");
    // Sans effort : pas de thinkingConfig, plafond inchangé.
    expect(calls[0].body.generationConfig).toEqual({ temperature: 0.6, maxOutputTokens: 300 });

    expect(result.text).toBe("Parfait!");
    expect(result.toolCalls).toEqual([{ id: "call_0", name: "get_slots", arguments: { count: 2 } }]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    // Google dit « STOP » même quand le tour se termine sur un appel d'outil.
    expect(result.finishReason).toBe("tool_calls");
  });

  it("encode l'effort en thinkingConfig.thinkingBudget et relève maxOutputTokens", () => {
    const body = buildGoogleBody({ ...INPUT, model: "gemini-2.5-flash", reasoningEffort: "medium" });
    expect(body.generationConfig).toEqual({
      temperature: 0.6,
      maxOutputTokens: 300 + REASONING_BUDGET_TOKENS.medium,
      thinkingConfig: { thinkingBudget: REASONING_BUDGET_TOKENS.medium },
    });
  });

  it("les résultats d'appels parallèles vont dans UN SEUL tour user, en autant de functionResponse", async () => {
    // Gemini exige autant de functionResponse que de functionCall DANS LE MÊME
    // tour ; un tour par résultat fait rejeter la deuxième requête (400).
    const { fetchFn, calls } = makeFetch(200, googleAnswer);
    await createGoogleProvider({ apiKey: "k", fetchFn }).generate({
      ...INPUT,
      model: "gemini-2.5-flash",
      messages: PARALLEL_TOOL_MESSAGES,
    });
    const contents = calls[0].body.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[1].parts).toEqual([
      { functionCall: { name: "update_qualification", args: { intent: "sell" } } },
      { functionCall: { name: "get_slots", args: { count: 2 } } },
    ]);
    expect(contents[2].parts).toEqual([
      { functionResponse: { name: "update_qualification", response: { result: "ok" } } },
      { functionResponse: { name: "get_slots", response: { result: "jeudi 14h" } } },
    ]);
  });

  it("finishReason MAX_TOKENS → tronqué", async () => {
    const { fetchFn } = makeFetch(200, {
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "Jeudi 14h ou" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 300 },
    });
    const result = await createGoogleProvider({ apiKey: "k", fetchFn }).generate({
      ...INPUT,
      model: "gemini-2.5-flash",
    });
    expect(result.finishReason).toBe("length");
    expect(result.truncated).toBe(true);
  });

  it("liste les modèles en retirant le préfixe models/ — réflexion lue du catalogue ou déduite", async () => {
    const { fetchFn } = makeFetch(200, {
      models: [
        {
          name: "models/gemini-flash-latest",
          displayName: "Gemini Flash",
          inputTokenLimit: 1000000,
          supportedGenerationMethods: ["generateContent"],
        },
        {
          name: "models/gemini-2.0-flash",
          displayName: "Gemini 2.0 Flash",
          inputTokenLimit: 1000000,
          supportedGenerationMethods: ["generateContent"],
          thinking: false,
        },
        {
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          inputTokenLimit: 1000000,
          supportedGenerationMethods: ["generateContent"],
          thinking: true,
        },
      ],
    });
    const models = await createGoogleProvider({ apiKey: "k", fetchFn }).listModels();
    expect(models[0]).toEqual({
      id: "gemini-flash-latest",
      label: "Gemini Flash",
      contextTokens: 1000000,
      supportsTools: true,
      // Un alias « -latest » pointe forcément sur une génération qui réfléchit.
      supportsReasoning: true,
    });
    expect(models[1].supportsReasoning).toBe(false);
    expect(models[2].supportsReasoning).toBe(true);
  });

  it("reconnaît une génération qui réfléchit d'après l'identifiant", () => {
    expect(isGoogleThinkingModel("gemini-2.5-flash")).toBe(true);
    expect(isGoogleThinkingModel("gemini-3-pro-preview")).toBe(true);
    expect(isGoogleThinkingModel("gemini-flash-latest")).toBe(true);
    expect(isGoogleThinkingModel("gemini-2.0-flash")).toBe(false);
    expect(isGoogleThinkingModel("gemini-1.5-pro")).toBe(false);
  });
});

// ── OpenAI ───────────────────────────────────────────────────────────────────

describe("createOpenAiProvider", () => {
  const openAiAnswer = {
    model: "gpt-5",
    choices: [{ finish_reason: "stop", message: { content: "Parfait!" } }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  };

  it("utilise Bearer et n'envoie AUCUN objet de routage", async () => {
    const { fetchFn, calls } = makeFetch(200, openAiAnswer);
    await createOpenAiProvider({ apiKey: "sk-oa", fetchFn }).generate({ ...INPUT, model: "gpt-5" });

    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-oa");
    expect(calls[0].body.provider).toBeUndefined();
  });

  it("modèle de raisonnement : max_completion_tokens, reasoning_effort, PAS de température", async () => {
    // gpt-5 / o-séries rejettent `max_tokens` et toute température non
    // défaut : chaque tour finissait en 400 « llm_error ».
    const { fetchFn, calls } = makeFetch(200, openAiAnswer);
    await createOpenAiProvider({ apiKey: "k", fetchFn }).generate({
      ...INPUT,
      model: "gpt-5",
      reasoningEffort: "high",
    });
    const body = calls[0].body;
    expect(body.max_completion_tokens).toBe(300 + REASONING_BUDGET_TOKENS.high);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body.reasoning_effort).toBe("high");
  });

  it("modèle de raisonnement sans effort : marge « medium » (il réfléchit quand même), pas de reasoning_effort", async () => {
    const { fetchFn, calls } = makeFetch(200, openAiAnswer);
    await createOpenAiProvider({ apiKey: "k", fetchFn }).generate({ ...INPUT, model: "o4-mini" });
    const body = calls[0].body;
    expect(body.max_completion_tokens).toBe(300 + REASONING_BUDGET_TOKENS.medium);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("modèle classique : température conservée, effort ignoré plutôt que rejeté", async () => {
    const { fetchFn, calls } = makeFetch(200, { ...openAiAnswer, model: "gpt-4.1" });
    await createOpenAiProvider({ apiKey: "k", fetchFn }).generate({
      ...INPUT,
      model: "gpt-4.1",
      reasoningEffort: "high",
    });
    const body = calls[0].body;
    expect(body.max_completion_tokens).toBe(300);
    expect(body.temperature).toBe(0.6);
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("finish_reason length → tronqué", async () => {
    const { fetchFn } = makeFetch(200, {
      model: "gpt-5",
      choices: [{ finish_reason: "length", message: { content: "" } }],
      usage: { prompt_tokens: 5, completion_tokens: 300 },
    });
    const result = await createOpenAiProvider({ apiKey: "k", fetchFn }).generate({
      ...INPUT,
      model: "gpt-5",
    });
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("");
  });

  it("reconnaît les modèles de raisonnement par identifiant", () => {
    for (const id of ["o3", "o4-mini", "o1-pro", "gpt-5", "gpt-5-mini", "gpt-5.1", "gpt-5-codex"]) {
      expect(isOpenAiReasoningModel(id), id).toBe(true);
    }
    for (const id of ["gpt-4o", "gpt-4.1-mini", "gpt-5-chat-latest", "omni-moderation-latest"]) {
      expect(isOpenAiReasoningModel(id), id).toBe(false);
    }
  });

  it("liste les modèles avec le drapeau de réflexion — sinon l'étape « effort » ne s'ouvre jamais", async () => {
    const { fetchFn } = makeFetch(200, {
      data: [{ id: "gpt-5-mini" }, { id: "gpt-4.1" }, { id: "omni-moderation-latest" }],
    });
    const models = await createOpenAiProvider({ apiKey: "k", fetchFn }).listModels();
    expect(models[0]).toMatchObject({ supportsTools: true, supportsReasoning: true });
    expect(models[1]).toMatchObject({ supportsTools: true, supportsReasoning: false });
    expect(models[2]).toMatchObject({ supportsTools: false, supportsReasoning: false });
  });
});

// ── Regroupement des résultats d'outils ──────────────────────────────────────

describe("groupToolResults", () => {
  it("regroupe les `tool` consécutifs et laisse le reste tel quel", () => {
    const turns = groupToolResults(PARALLEL_TOOL_MESSAGES);
    expect(turns.map((t) => t.kind)).toEqual(["message", "message", "tool_results"]);
    const last = turns[2];
    expect(last.kind === "tool_results" && last.results.map((r) => r.toolCallId)).toEqual(["c1", "c2"]);
  });

  it("deux séries séparées par un tour assistant restent deux séries", () => {
    const turns = groupToolResults([
      ...PARALLEL_TOOL_MESSAGES,
      { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "get_slots", arguments: {} }] },
      { role: "tool", toolCallId: "c3", name: "get_slots", content: "vendredi" },
    ]);
    expect(turns.map((t) => t.kind)).toEqual([
      "message",
      "message",
      "tool_results",
      "message",
      "tool_results",
    ]);
  });
});

// ── Modèle utilitaire par fournisseur ────────────────────────────────────────

describe("UTILITY_MODEL_BY_PROVIDER", () => {
  it("chaque fournisseur reçoit un identifiant QUI LUI APPARTIENT", () => {
    // Quand seule la clé Google (ou OpenAI) est configurée, envoyer un
    // identifiant Claude faisait échouer chaque « créer avec l'IA » sur un 404.
    expect(UTILITY_MODEL_BY_PROVIDER.openrouter).toMatch(/^[a-z0-9-]+\/[^/]+$/);
    expect(UTILITY_MODEL_BY_PROVIDER.anthropic).toMatch(/^claude-/);
    expect(UTILITY_MODEL_BY_PROVIDER.google).toMatch(/^gemini-/);
    expect(UTILITY_MODEL_BY_PROVIDER.openai).not.toMatch(/claude|gemini|\//);
  });
});

// ── Erreurs et repli ─────────────────────────────────────────────────────────

describe("erreurs normalisées", () => {
  it("500 → rejouable, 400 → non rejouable", async () => {
    // `attempts: 1` : ce test porte sur la CLASSIFICATION de l'erreur, pas sur
    // la reprise (testée plus bas) — sans ça il attendrait les reprises.
    const server = createOpenRouterProvider({
      apiKey: "k",
      retry: { attempts: 1 },
      fetchFn: makeFetch(500, { error: { message: "upstream down" } }).fetchFn,
    });
    await expect(server.generate(INPUT)).rejects.toMatchObject({
      name: "LLMProviderError",
      status: 500,
      retryable: true,
    });

    const client = createOpenRouterProvider({
      apiKey: "k",
      fetchFn: makeFetch(400, { error: { message: "bad model" } }).fetchFn,
    });
    await expect(client.generate(INPUT)).rejects.toMatchObject({ status: 400, retryable: false });
  });

  it("une erreur GLISSÉE dans un 200 est une ERREUR, jamais un texte vide", async () => {
    // OpenRouter répond parfois {"error":{code:429,…}} avec un statut HTTP
    // 200. Traitée comme un succès, la réponse « sans choices » donnait un
    // brouillon vide : le tour partait en « l'assistant n'a rien écrit »
    // (escalade) au lieu d'être rejoué — 80 fils pendant l'incident du
    // 2026-08-25.
    const throttled = createOpenRouterProvider({
      apiKey: "k",
      retry: { attempts: 1 },
      fetchFn: makeFetch(200, {
        error: { message: "openai/gpt-5.6-luna is temporarily rate-limited upstream", code: 429 },
      }).fetchFn,
    });
    await expect(throttled.generate(INPUT)).rejects.toMatchObject({
      name: "LLMProviderError",
      status: 429,
      retryable: true,
    });

    // Un code non rejouable embarqué garde sa classification.
    const refused = createOpenRouterProvider({
      apiKey: "k",
      fetchFn: makeFetch(200, { error: { message: "moderation refusal", code: 403 } }).fetchFn,
    });
    await expect(refused.generate(INPUT)).rejects.toMatchObject({ status: 403, retryable: false });
  });

  it("402 (crédits épuisés) → rejouable : le COMPTE est à sec, pas la requête", async () => {
    // L'incident du 2026-08-25 : OpenRouter à court de crédits — un repli
    // configuré chez un autre fournisseur doit avoir sa chance.
    const broke = createOpenRouterProvider({
      apiKey: "k",
      fetchFn: makeFetch(402, { error: { message: "This request requires more credits" } }).fetchFn,
    });
    await expect(broke.generate(INPUT)).rejects.toMatchObject({
      status: 402,
      retryable: true,
    });
  });

  it("un appel qui pend est abandonné et devient rejouable", async () => {
    const fetchFn: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
      });
    const provider = createAnthropicProvider({ apiKey: "k", fetchFn, timeoutMs: 20 });

    await expect(provider.generate({ ...INPUT, model: "claude-sonnet-5" })).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("une réponse 2xx illisible n'est pas rejouable", async () => {
    const provider = createOpenAiProvider({
      apiKey: "k",
      fetchFn: makeFetch(200, "pas du json").fetchFn,
    });
    await expect(provider.generate({ ...INPUT, model: "gpt-5" })).rejects.toMatchObject({
      message: "llm_malformed_response",
      retryable: false,
    });
  });
});

// ── Reprise sur place (transport) ────────────────────────────────────────────

describe("reprise d'un refus passager", () => {
  const ANSWER = {
    model: "anthropic/claude-sonnet-5",
    choices: [{ finish_reason: "stop", message: { content: "Bonjour Marie!" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  /** Répond `status` les `failures` premières fois, puis 200. */
  function flakyFetch(status: number, failures: number, payload: unknown, headers: HeadersInit = {}) {
    let seen = 0;
    const fetchFn: typeof fetch = async () => {
      seen += 1;
      if (seen <= failures) {
        return new Response(JSON.stringify({ error: { message: "rate-limited upstream" } }), {
          status,
          headers,
        });
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    return { fetchFn, seen: () => seen };
  }

  it("un 429 est rejoué sur le MÊME modèle et finit par aboutir", async () => {
    // Le message exact vu en production : « temporarily rate-limited upstream.
    // Please retry shortly ». Sans reprise, une fixture de la suite virait au
    // rouge (« erreur du modèle : llm_upstream_429 ») pour deux secondes
    // d'embouteillage, et l'assistant devenait inactivable.
    const waits: number[] = [];
    const flaky = flakyFetch(429, 2, ANSWER);
    const provider = createOpenRouterProvider({
      apiKey: "k",
      fetchFn: flaky.fetchFn,
      sleepFn: async (ms) => void waits.push(ms),
    });

    const result = await provider.generate(INPUT);

    expect(result.text).toBe("Bonjour Marie!");
    expect(flaky.seen()).toBe(3);
    // Attente croissante : deux appels collés ne feraient que consommer deux
    // refus de plus.
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });

  it("une erreur GLISSÉE dans un 200 est reprise elle aussi", async () => {
    let seen = 0;
    const fetchFn: typeof fetch = async () => {
      seen += 1;
      return new Response(
        JSON.stringify(
          seen === 1 ? { error: { message: "rate-limited upstream", code: 429 } } : ANSWER,
        ),
        { status: 200 },
      );
    };
    const provider = createOpenRouterProvider({ apiKey: "k", fetchFn, sleepFn: async () => {} });

    expect((await provider.generate(INPUT)).text).toBe("Bonjour Marie!");
    expect(seen).toBe(2);
  });

  it("`Retry-After` de l'amont l'emporte sur notre progression", async () => {
    const waits: number[] = [];
    const flaky = flakyFetch(429, 1, ANSWER, { "retry-after": "2" });
    const provider = createOpenRouterProvider({
      apiKey: "k",
      fetchFn: flaky.fetchFn,
      sleepFn: async (ms) => void waits.push(ms),
    });

    await provider.generate(INPUT);
    expect(waits).toEqual([2000]);
  });

  it("une requête FAUTIVE n'est jamais rejouée — la facture doublerait pour rien", async () => {
    const flaky = flakyFetch(400, 5, ANSWER);
    const provider = createOpenRouterProvider({
      apiKey: "k",
      fetchFn: flaky.fetchFn,
      sleepFn: async () => {},
    });

    await expect(provider.generate(INPUT)).rejects.toMatchObject({ status: 400 });
    expect(flaky.seen()).toBe(1);
  });

  it("un compte à sec (402) n'est pas repris : attendre n'y change rien", async () => {
    const flaky = flakyFetch(402, 5, ANSWER);
    const provider = createOpenRouterProvider({
      apiKey: "k",
      fetchFn: flaky.fetchFn,
      sleepFn: async () => {},
    });

    await expect(provider.generate(INPUT)).rejects.toMatchObject({ status: 402 });
    expect(flaky.seen()).toBe(1);
  });

  it("un amont durablement encombré finit par remonter, sans boucler", async () => {
    const flaky = flakyFetch(429, 99, ANSWER);
    const provider = createOpenRouterProvider({
      apiKey: "k",
      fetchFn: flaky.fetchFn,
      sleepFn: async () => {},
    });

    await expect(provider.generate(INPUT)).rejects.toMatchObject({ status: 429 });
    expect(flaky.seen()).toBe(3);
  });
});

// ── Chaîne de replis ─────────────────────────────────────────────────────────

describe("generateWithChain", () => {
  const ok = {
    text: "ok",
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    latencyMs: 1,
    modelServed: "claude-sonnet-5",
    raw: {},
  };
  const fakeProvider = (id: ProviderId, impl: LLMProvider["generate"]): LLMProvider => ({
    id,
    generate: impl,
    listModels: async () => [],
  });
  const down = (status: number, retryable = true) =>
    async (): Promise<never> => {
      throw new LLMProviderError(`down ${status}`, "openrouter", status, retryable);
    };
  const CHAIN_INPUT = { ...INPUT, routing: { zdr: true } };
  delete (CHAIN_INPUT as { model?: string }).model;

  it("descend la chaîne jusqu'au cran qui répond, avec SON identifiant", async () => {
    const seen: string[] = [];
    const resolve = (id: ProviderId) =>
      fakeProvider(id, async (input) => {
        seen.push(`${id}/${input.model}`);
        if (id !== "google") throw new LLMProviderError("down", id, 503, true);
        return ok;
      });

    const outcome = await generateWithChain(
      [
        { provider: "openrouter", model: "openai/gpt-5.6-luna" },
        { provider: "anthropic", model: "claude-sonnet-5" },
        { provider: "google", model: "gemini-2.5-pro" },
      ],
      CHAIN_INPUT,
      { resolve },
    );

    expect(outcome.rung).toBe(2);
    expect(outcome.used).toEqual({ provider: "google", model: "gemini-2.5-pro" });
    expect(seen).toEqual([
      "openrouter/openai/gpt-5.6-luna",
      "anthropic/claude-sonnet-5",
      "google/gemini-2.5-pro",
    ]);
  });

  it("l'objet de routage ne part QUE chez OpenRouter", async () => {
    const routings: (unknown | undefined)[] = [];
    const resolve = (id: ProviderId) =>
      fakeProvider(id, async (input) => {
        routings.push(input.routing);
        if (id === "openrouter") throw new LLMProviderError("down", id, 503, true);
        return ok;
      });

    await generateWithChain(
      [
        { provider: "openrouter", model: "x" },
        { provider: "anthropic", model: "claude-sonnet-5" },
      ],
      CHAIN_INPUT,
      { resolve },
    );

    expect(routings[0]).toEqual({ zdr: true });
    expect(routings[1]).toBeUndefined();
  });

  it("un cran SANS CLÉ est sauté, pas fatal", async () => {
    const resolve = (id: ProviderId) => {
      if (id === "anthropic") throw new Error("llm_provider_unconfigured: anthropic");
      if (id === "openrouter") return fakeProvider(id, down(503));
      return fakeProvider(id, async () => ok);
    };

    const outcome = await generateWithChain(
      [
        { provider: "openrouter", model: "x" },
        { provider: "anthropic", model: "claude-sonnet-5" },
        { provider: "openai", model: "gpt-5" },
      ],
      CHAIN_INPUT,
      { resolve },
    );

    expect(outcome.rung).toBe(2);
    expect(outcome.failures.map((f) => f.provider)).toEqual(["openrouter", "anthropic"]);
  });

  it("une erreur non rejouable arrête la chaîne sans essayer les replis", async () => {
    let calls = 0;
    const resolve = (id: ProviderId) =>
      fakeProvider(id, async () => {
        calls += 1;
        throw new LLMProviderError("bad request", id, 400, false);
      });

    await expect(
      generateWithChain(
        [
          { provider: "openrouter", model: "x" },
          { provider: "anthropic", model: "claude-sonnet-5" },
        ],
        CHAIN_INPUT,
        { resolve },
      ),
    ).rejects.toMatchObject({ name: "LLMChainError" });
    expect(calls).toBe(1);
  });

  it("chaîne épuisée : la panne PRIMAIRE reste le diagnostic, les crans s'y annotent", async () => {
    const resolve = (id: ProviderId) =>
      fakeProvider(
        id,
        id === "openrouter" ? down(402) : down(503),
      );

    let message = "";
    try {
      await generateWithChain(
        [
          { provider: "openrouter", model: "x" },
          { provider: "anthropic", model: "claude-sonnet-5" },
        ],
        CHAIN_INPUT,
        { resolve },
      );
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toBe("down 402 (repli 1 anthropic/claude-sonnet-5 : down 503)");
  });

  it("le budget de temps arrête la chaîne au lieu de la laisser déborder", async () => {
    let calls = 0;
    const resolve = (id: ProviderId) =>
      fakeProvider(id, async () => {
        calls += 1;
        throw new LLMProviderError("down", id, 503, true);
      });

    await expect(
      generateWithChain(
        [
          { provider: "openrouter", model: "x" },
          { provider: "anthropic", model: "claude-sonnet-5" },
        ],
        CHAIN_INPUT,
        { resolve, now: () => 1_000 },
        { deadline: 500 },
      ),
    ).rejects.toMatchObject({ name: "LLMChainError" });
    expect(calls).toBe(0);
  });

  it("le chemin heureux ne descend jamais la chaîne", async () => {
    const outcome = await generateWithChain(
      [{ provider: "openrouter", model: "x" }],
      CHAIN_INPUT,
      { resolve: (id) => fakeProvider(id, async () => ok) },
    );
    expect(outcome.rung).toBe(0);
    expect(outcome.failures).toEqual([]);
  });
});
