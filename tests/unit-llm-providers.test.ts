/**
 * Unitaire — les quatre fournisseurs LLM derrière UNE seule interface.
 * Aucun réseau : `fetchFn` est toujours injecté.
 *
 * L'exigence centrale du cahier (§21) : la MÊME fixture, passée par OpenRouter
 * ou par Anthropic en direct, ressort dans la MÊME forme normalisée d'appels
 * d'outils. C'est ce qui permet de changer de fournisseur par menu déroulant
 * sans toucher au moteur.
 */
import { describe, expect, it } from "vitest";
import { createOpenRouterProvider, toOpenRouterProvider } from "@/lib/llm/openrouter";
import { createAnthropicProvider } from "@/lib/llm/anthropic";
import { createGoogleProvider } from "@/lib/llm/google";
import { createOpenAiProvider } from "@/lib/llm/openai";
import { generateWithFallback } from "@/lib/llm/route";
import { LLMProviderError, type GenerateInput, type LLMProvider } from "@/lib/llm/types";

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

// ── OpenRouter ───────────────────────────────────────────────────────────────

describe("createOpenRouterProvider", () => {
  const openRouterAnswer = {
    model: "anthropic/claude-sonnet-5",
    provider: "Anthropic",
    choices: [
      {
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

  it("normalise la réponse, y compris le modèle RÉELLEMENT servi", async () => {
    const { fetchFn } = makeFetch(200, openRouterAnswer);
    const provider = createOpenRouterProvider({ apiKey: "k", fetchFn });

    const result = await provider.generate({ ...INPUT, model: "openrouter/auto" });

    expect(result.text).toBe("Parfait!");
    expect(result.toolCalls).toEqual([{ id: "tc_1", name: "get_slots", arguments: { count: 2 } }]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.0021 });
    // Sur un routeur, « quel modèle a répondu » n'est pas « lequel ai-je demandé ».
    expect(result.modelServed).toBe("anthropic/claude-sonnet-5");
    expect(result.upstreamProvider).toBe("Anthropic");
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

  it("normalise blocs texte et tool_use", async () => {
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
  it("assemble system_instruction, contents et function_declarations", async () => {
    const { fetchFn, calls } = makeFetch(200, {
      modelVersion: "gemini-flash-latest",
      candidates: [
        {
          content: {
            parts: [{ text: "Parfait!" }, { functionCall: { name: "get_slots", args: { count: 2 } } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
    });
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

    expect(result.text).toBe("Parfait!");
    expect(result.toolCalls).toEqual([{ id: "call_0", name: "get_slots", arguments: { count: 2 } }]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it("liste les modèles en retirant le préfixe models/", async () => {
    const { fetchFn } = makeFetch(200, {
      models: [
        {
          name: "models/gemini-flash-latest",
          displayName: "Gemini Flash",
          inputTokenLimit: 1000000,
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    });
    const models = await createGoogleProvider({ apiKey: "k", fetchFn }).listModels();
    expect(models[0]).toEqual({
      id: "gemini-flash-latest",
      label: "Gemini Flash",
      contextTokens: 1000000,
      supportsTools: true,
    });
  });
});

// ── OpenAI ───────────────────────────────────────────────────────────────────

describe("createOpenAiProvider", () => {
  it("utilise Bearer et n'envoie AUCUN objet de routage", async () => {
    const { fetchFn, calls } = makeFetch(200, {
      model: "gpt-5",
      choices: [{ message: { content: "Parfait!" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    await createOpenAiProvider({ apiKey: "sk-oa", fetchFn }).generate({ ...INPUT, model: "gpt-5" });

    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-oa");
    expect(calls[0].body.provider).toBeUndefined();
  });
});

// ── Erreurs et repli ─────────────────────────────────────────────────────────

describe("erreurs normalisées", () => {
  it("500 → rejouable, 400 → non rejouable", async () => {
    const server = createOpenRouterProvider({
      apiKey: "k",
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

describe("generateWithFallback", () => {
  const fakeProvider = (impl: LLMProvider["generate"]): LLMProvider => ({
    id: "anthropic",
    generate: impl,
    listModels: async () => [],
  });
  const ok = {
    text: "ok",
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    latencyMs: 1,
    modelServed: "claude-sonnet-5",
    raw: {},
  };

  it("rejoue UNE fois chez le repli, avec l'identifiant de modèle du repli", async () => {
    let seenModel = "";
    const primary = fakeProvider(async () => {
      throw new LLMProviderError("down", "openrouter", 503, true);
    });
    const fallback = fakeProvider(async (input) => {
      seenModel = input.model;
      return ok;
    });

    const { result, usedFallback } = await generateWithFallback(primary, fallback, {
      ...INPUT,
      fallbackModel: "claude-sonnet-5",
    });

    expect(usedFallback).toBe(true);
    expect(result.text).toBe("ok");
    expect(seenModel).toBe("claude-sonnet-5");
  });

  it("une erreur non rejouable remonte sans appeler le repli", async () => {
    let called = false;
    const primary = fakeProvider(async () => {
      throw new LLMProviderError("bad request", "openrouter", 400, false);
    });
    const fallback = fakeProvider(async () => {
      called = true;
      return ok;
    });

    await expect(generateWithFallback(primary, fallback, INPUT)).rejects.toMatchObject({
      status: 400,
    });
    expect(called).toBe(false);
  });

  it("sans repli configuré, l'erreur remonte", async () => {
    const primary = fakeProvider(async () => {
      throw new LLMProviderError("down", "openrouter", 503, true);
    });
    await expect(generateWithFallback(primary, null, INPUT)).rejects.toMatchObject({ status: 503 });
  });

  it("le chemin heureux n'utilise jamais le repli", async () => {
    const primary = fakeProvider(async () => ok);
    const { usedFallback } = await generateWithFallback(primary, null, INPUT);
    expect(usedFallback).toBe(false);
  });
});
