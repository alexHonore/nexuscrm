/**
 * Intégration — le bac à sable (`lib/agent/sandbox.ts`) sur la base de test.
 *
 * Le modèle est simulé (aucun réseau), le reste est réel : assistant compilé,
 * garde-fous en base, règles résolues. Ce fichier tient la promesse du bac à
 * sable : montrer ce que la PRODUCTION ferait du tour —
 *  · les portes avant le générateur (STOP, refus ferme, humain, budget,
 *    chaîne épuisée) sans appeler le modèle ;
 *  · la coupe au premier paragraphe et la régénération unique ;
 *  · des outils simulés avec les règles de production (book_meeting refusé) ;
 *  · la même consigne d'ouverture et de relance ;
 *  · et JAMAIS un mot au modèle sur le fait qu'il est à l'essai.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, resetDb, testDb } from "./helpers/db";
import { assistants } from "@/db/schema-sms";
import { assistantConfigSchema } from "@/lib/assistants/schema";
import type { LLMMessage, LLMResult, ToolCall } from "@/lib/llm/types";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

/** Modèle simulé : chaque test décide ce que le générateur et le juge répondent. */
const llm = vi.hoisted(() => ({
  generatorText: "Parfait! Préférez-vous jeudi 14 h ou vendredi 18 h 30?",
  /** Textes successifs du générateur (un par appel) ; à court, `generatorText`. */
  generatorSequence: [] as string[],
  /** Appels d'outils successifs (un tableau par appel) ; à court, aucun. */
  toolCallSequence: [] as ToolCall[][],
  generatorError: null as string | null,
  classifierJson: '{"refusal":"none","qualification":{}}',
  judgeJson: '{"passed":true,"reason":"conforme"}',
  calls: [] as { model: string; system: string; messages: LLMMessage[] }[],
}));

vi.mock("@/lib/llm-server", () => ({
  getLlmProvider: (id: string) => ({
    id,
    listModels: async () => [],
    generate: async (input: { system: string; model: string; messages: LLMMessage[] }): Promise<LLMResult> => {
      llm.calls.push({ model: input.model, system: input.system, messages: input.messages });
      if (input.model.includes("classifier")) {
        const isJudge = input.system.includes("évaluateur");
        return {
          text: isJudge ? llm.judgeJson : llm.classifierJson,
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          latencyMs: 5,
          modelServed: input.model,
          raw: {},
        };
      }
      if (llm.generatorError) throw new Error(llm.generatorError);
      const text = llm.generatorSequence.length > 0 ? (llm.generatorSequence.shift() ?? "") : llm.generatorText;
      const toolCalls = llm.toolCallSequence.shift() ?? [];
      return {
        text,
        toolCalls,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
        latencyMs: 42,
        modelServed: "anthropic/claude-sonnet-5",
        raw: { simulated: true },
      };
    },
  }),
  LlmUnconfiguredError: class extends Error {},
  configuredProviders: () => ["openrouter"],
  getModelCatalog: async () => [],
}));

const { simulateTurn } = await import("@/lib/agent/sandbox");
const { simulatedSlots, simulatedSlotsText } = await import("@/lib/agent/tool-simulation");
const { outreachInstructionText } = await import("@/lib/agent/opening");
const { seedGuardrailDefaults } = await import("@/lib/guardrails/store");
const { compileAssistant } = await import("@/lib/assistants/service");

const NEVER_TELL = /bac à sable|sandbox|simulation|simulé/i;

async function scene(overrides: { maxTurns?: number } = {}) {
  await seedGuardrailDefaults();
  const config = assistantConfigSchema.parse({
    name: "Acheteur FB (essai)",
    identity: {},
    approach: { maxTurns: overrides.maxTurns ?? 16, replySpeed: "instant" },
    model: {
      provider: "openrouter",
      model: "generator-model",
      classifier: { provider: "openrouter", model: "classifier-model" },
    },
    goal: {
      primary: {
        type: "video_meeting",
        durationMin: 30,
        appointmentType: "meet",
        requiredFields: ["project_type"],
      },
      fallbacks: [
        { type: "phone_call", durationMin: 15, requiredFields: [] },
        { type: "collect_email", requiredFields: ["email"] },
      ],
    },
  });
  const [assistant] = await testDb
    .insert(assistants)
    .values({
      name: config.name,
      language: config.language,
      identity: config.identity,
      goal: config.goal,
      approach: config.approach,
      knowledge: config.knowledge,
      objectionPacks: config.objectionPacks,
      tools: config.tools,
      model: config.model,
      status: "draft",
    })
    .returning();
  await compileAssistant(assistant.id, null);
  return assistant;
}

const generatorCalls = () => llm.calls.filter((c) => c.model === "generator-model");

describe("simulateTurn", () => {
  beforeEach(async () => {
    await resetDb();
    llm.generatorText = "Parfait! Préférez-vous jeudi 14 h ou vendredi 18 h 30?";
    llm.generatorSequence = [];
    llm.toolCallSequence = [];
    llm.generatorError = null;
    llm.classifierJson = '{"refusal":"none","qualification":{}}';
    llm.judgeJson = '{"passed":true,"reason":"conforme"}';
    llm.calls = [];
  });
  afterAll(async () => {
    await closeDb();
  });

  it("le modèle ne lit JAMAIS qu'il est à l'essai, et L7 et get_slots disent les mêmes heures", async () => {
    const assistant = await scene();
    llm.toolCallSequence = [[{ id: "c1", name: "get_slots", arguments: { count: 2 } }], []];

    const result = await simulateTurn({
      assistantId: assistant.id,
      history: [],
      inbound: "Oui, je cherche à acheter",
    });
    expect(result.outcome).toBe("sent");

    const [first, second] = generatorCalls();
    expect(first.system).not.toMatch(NEVER_TELL);
    expect(result.runtimeBlock).toContain(`Disponibilités : ${simulatedSlotsText(2)}`);
    // Le résultat d'outil porte les MÊMES libellés que la couche L7 — et
    // l'instant ISO en plus, comme en production : `book_meeting` exige le
    // créneau « exactement tel que retourné par get_slots ».
    const toolMessage = second.messages.find((m) => m.role === "tool");
    for (const label of simulatedSlotsText(2).split(", ")) {
      expect(toolMessage?.content).toContain(label);
    }
    expect(toolMessage?.content).toMatch(/\(20\d{2}-\d{2}-\d{2}T/);
    expect(toolMessage?.content).not.toMatch(NEVER_TELL);
    expect(result.toolCalls).toEqual([
      { name: "get_slots", args: { count: 2 }, ok: true, result: toolMessage?.content },
    ]);
    // Le coût est rapporté : classifieur + 2 générateurs + les juges du noyau.
    expect(generatorCalls()).toHaveLength(2);
    expect(result.usage?.calls).toBe(llm.calls.length);
    expect(result.usage?.costUsd).toBeCloseTo(0.002);
  });

  // ── Les portes avant le générateur ────────────────────────────────────────

  it("STOP : arrêt pour désabonnement, le générateur n'est PAS appelé", async () => {
    const assistant = await scene();
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "STOP" });
    expect(result.outcome).toBe("stopped");
    expect(result.reason).toBe("optout");
    expect(result.draft).toBe("");
    expect(result.classification.optOut).toBe(true);
    expect(generatorCalls()).toHaveLength(0);
  });

  it("refus ferme : UN adieu est généré (clôture polie), la chaîne n'est pas touchée", async () => {
    const assistant = await scene();
    llm.classifierJson = '{"refusal":"hard"}';
    llm.generatorText = "Merci pour votre réponse, bonne continuation!";
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "non merci" });
    // Comme en production : l'adieu part (« sent »), le motif dit que l'IA se
    // taira ensuite, et la chaîne d'objectifs n'a pas bougé.
    expect(result.outcome).toBe("sent");
    expect(result.reason).toBe("hard_refusal");
    expect(result.draft).toContain("bonne continuation");
    expect(result.rung).toBe("primary");
    // Le modèle a reçu la consigne de clôture.
    expect(generatorCalls()[0]?.system).toContain("CLÔTURE");
  });

  it("demande d'humain : escalade immédiate", async () => {
    const assistant = await scene();
    llm.classifierJson = '{"wantsHuman":true}';
    const result = await simulateTurn({
      assistantId: assistant.id,
      history: [],
      inbound: "je veux parler à quelqu'un",
    });
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("client_wants_human");
    expect(generatorCalls()).toHaveLength(0);
  });

  it("budget de tours épuisé : escalade — et l'ouverture hors historique compte pour un", async () => {
    const assistant = await scene({ maxTurns: 4 });
    const result = await simulateTurn({
      assistantId: assistant.id,
      history: [
        { role: "assistant", content: "m1" },
        { role: "user", content: "r1" },
        { role: "assistant", content: "m2" },
        { role: "user", content: "r2" },
        { role: "assistant", content: "m3" },
      ],
      inbound: "encore là?",
      openerSent: true,
    });
    expect(result.turnsUsed).toBe(4);
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("max_turns");
    expect(generatorCalls()).toHaveLength(0);
  });

  it("un refus mou sur le dernier cran : chaîne épuisée, escalade", async () => {
    const assistant = await scene();
    llm.classifierJson = '{"refusal":"soft"}';
    const result = await simulateTurn({
      assistantId: assistant.id,
      history: [],
      inbound: "pas maintenant",
      softRefusals: 2,
    });
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("goal_chain_exhausted");
    expect(result.softRefusals).toBe(3);
    expect(generatorCalls()).toHaveLength(0);
  });

  it("un refus mou descend d'un cran et continue", async () => {
    const assistant = await scene();
    llm.classifierJson = '{"refusal":"soft"}';
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "pas cette semaine" });
    expect(result.outcome).toBe("sent");
    expect(result.rung).toBe("fallback:0");
    expect(result.softRefusals).toBe(1);
  });

  // ── Coupe et régénération ─────────────────────────────────────────────────

  it("un seul paragraphe part ; les garde-fous jugent CE qui part", async () => {
    const assistant = await scene();
    llm.generatorText = "Bonjour Marie, on se parle jeudi?\n\nVotre maison vaut 450 000 $.";
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "allo" });
    expect(result.outcome).toBe("sent");
    expect(result.draft).toBe("Bonjour Marie, on se parle jeudi?");
    expect(result.droppedParagraphs).toBe(1);
    expect(result.fullText).toContain("450 000");
    // Le montant est dans le paragraphe coupé : la production l'aurait envoyé
    // sans broncher — le bac à sable doit montrer la même chose.
    expect(result.verdicts.some((v) => v.key === "no_price_opinion" && !v.passed)).toBe(false);
  });

  it("un brouillon bloqué est RÉÉCRIT une fois avec la consigne de correction, puis envoyé", async () => {
    const assistant = await scene();
    llm.generatorSequence = [
      "Votre maison vaut environ 450 000 $ selon moi.",
      "C'est exactement ce que le courtier va regarder avec vous. Jeudi 14 h?",
    ];
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "ça vaut combien?" });
    expect(result.outcome).toBe("sent");
    expect(result.regenerations).toBe(1);
    expect(result.draft).toContain("courtier");
    const [first, second] = generatorCalls();
    expect(first.system).not.toContain("CONSIGNE DE CORRECTION");
    expect(second.system).toContain("CONSIGNE DE CORRECTION");
    expect(second.system).not.toMatch(NEVER_TELL);
  });

  it("toujours bloqué après réécriture : « blocked », le texte reste visible", async () => {
    const assistant = await scene();
    llm.generatorText = "Votre maison vaut environ 450 000 $ selon moi.";
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "ça vaut combien?" });
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toBe("blocked_after_regeneration");
    expect(result.blocked).toBe(true);
    // Même compteur que la trace de production : deux jets refusés.
    expect(result.regenerations).toBe(2);
    expect(result.draft).toContain("450 000");
    expect(generatorCalls()).toHaveLength(2);
  });

  it("un juge en échec bloque aussi", async () => {
    const assistant = await scene();
    llm.judgeJson = '{"passed":false,"reason":"prétend être humain"}';
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "es-tu un robot?" });
    expect(result.outcome).toBe("blocked");
  });

  // ── Outils ────────────────────────────────────────────────────────────────

  it("book_meeting sans les champs requis : réservation refusée, escalade, rien ne part", async () => {
    const assistant = await scene();
    const iso = simulatedSlots()[0].iso;
    llm.toolCallSequence = [[{ id: "b1", name: "book_meeting", arguments: { slotIso: iso } }], []];
    llm.generatorText = "Parfait, c'est réservé jeudi 14 h!";
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "jeudi 14 h svp" });
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("booking_failed");
    expect(result.draft).toBe("");
    expect(result.fullText).toContain("réservé");
    expect(result.toolCalls[0]).toMatchObject({ name: "book_meeting", ok: true });
    expect(result.toolCalls[0].result).toContain("il manque encore ces informations : project_type");
  });

  it("book_meeting avec la qualification requise et un créneau offert : confirmé, envoyé", async () => {
    const assistant = await scene();
    const iso = simulatedSlots()[0].iso;
    llm.toolCallSequence = [[{ id: "b1", name: "book_meeting", arguments: { slotIso: iso } }], []];
    llm.generatorText = "C'est noté pour jeudi 14 h, à bientôt!";
    const result = await simulateTurn({
      assistantId: assistant.id,
      history: [],
      inbound: "jeudi 14 h svp",
      qualification: { project_type: "acheter" },
    });
    expect(result.outcome).toBe("sent");
    expect(result.toolCalls[0].result).toBe(`book_meeting : confirmé pour ${iso}`);
  });

  it("un handoff malformé (sans raison) est refusé par zod et ne termine pas le tour", async () => {
    const assistant = await scene();
    llm.toolCallSequence = [[{ id: "h1", name: "handoff", arguments: {} }], []];
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "allo" });
    expect(result.outcome).toBe("sent");
    expect(result.toolCalls[0]).toMatchObject({ name: "handoff", ok: false });
    expect(result.toolCalls[0].result).toContain("invalid_args");
  });

  it("un handoff valide termine le tour : rien ne part, le texte reste visible à l'admin", async () => {
    const assistant = await scene();
    llm.toolCallSequence = [[{ id: "h1", name: "handoff", arguments: { reason: "lead chaud" } }]];
    llm.generatorText = "Je transfère votre demande à Alex.";
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "je veux vendre vite" });
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("tool_handoff");
    expect(result.draft).toBe("");
    expect(result.fullText).toBe("Je transfère votre demande à Alex.");
    expect(generatorCalls()).toHaveLength(1);
  });

  it("l'outil stop coupe la conversation", async () => {
    const assistant = await scene();
    llm.toolCallSequence = [[{ id: "s1", name: "stop", arguments: {} }]];
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "allo" });
    expect(result.outcome).toBe("stopped");
    expect(result.reason).toBe("tool_stop");
  });

  it("un modèle qui n'écrit rien part en escalade « no_text »", async () => {
    const assistant = await scene();
    llm.generatorText = "";
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "allo" });
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("no_text");
  });

  it("une panne du générateur est une erreur, pas un envoi", async () => {
    const assistant = await scene();
    llm.generatorError = "llm_http_503";
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "allo" });
    expect(result.outcome).toBe("error");
    expect(result.reason).toBe("llm_error");
    // La panne PRIMAIRE ouvre le message ; les crans de repli, tombés à leur
    // tour, s'y annotent — l'aperçu descend la chaîne comme la production.
    expect(result.error).toMatch(/^llm_http_503/);
  });

  // ── Ouverture et relance ──────────────────────────────────────────────────

  it("ouverture : la MÊME consigne que la production, avec le contexte de campagne", async () => {
    const assistant = await scene();
    const result = await simulateTurn({
      assistantId: assistant.id,
      history: [],
      inbound: "",
      openerSent: false,
      outreach: { step: 0, campaignName: "Réactivation 2025", campaignDescription: "anciens acheteurs" },
    });
    const expected = outreachInstructionText({
      step: 0,
      historyLength: 0,
      campaignName: "Réactivation 2025",
      campaignDescription: "anciens acheteurs",
    });
    expect(result.instruction).toBe(expected);
    expect(result.turnsUsed).toBe(0);
    // Pas de classifieur : la consigne n'est pas un message du contact.
    expect(llm.calls[0].model).toBe("generator-model");
    const last = llm.calls[0].messages[llm.calls[0].messages.length - 1];
    expect(last).toEqual({ role: "user", content: expected });
    expect(result.outcome).toBe("sent");
  });

  it("relance : dit au modèle qu'il relance, et laquelle ; l'ouverture en historique compte", async () => {
    const assistant = await scene();
    const result = await simulateTurn({
      assistantId: assistant.id,
      history: [{ role: "assistant", content: "Bonjour Marie, c'est Alex de Groupe Nexus…" }],
      inbound: "",
      outreach: { step: 1, ladderLength: 3 },
    });
    expect(result.instruction).toContain("Tu relances : le contact n'a pas répondu à ton dernier message (relance 1 sur 2).");
    expect(result.turnsUsed).toBe(1);
    expect(result.runtimeBlock).toContain("Messages utilisés : 1/16");
  });

  // ── Pannes du classifieur et hygiène de l'historique ──────────────────────

  it("un classifieur illisible est RAPPORTÉ, pas avalé", async () => {
    const assistant = await scene();
    llm.classifierJson = "je ne sais pas";
    const result = await simulateTurn({ assistantId: assistant.id, history: [], inbound: "pas cette semaine" });
    expect(result.classifierError).toBe("classifier_unparseable");
    expect(result.classification.refusal).toBe("none");
    expect(result.outcome).toBe("sent");
  });

  it("les messages vides de l'historique n'atteignent pas le modèle", async () => {
    const assistant = await scene();
    const result = await simulateTurn({
      assistantId: assistant.id,
      history: [
        { role: "assistant", content: "" },
        { role: "user", content: "allo" },
        { role: "assistant", content: "Bonjour!" },
      ],
      inbound: "on continue",
      openerSent: false,
    });
    expect(result.outcome).toBe("sent");
    const [gen] = generatorCalls();
    expect(gen.messages.some((m) => m.content === "")).toBe(false);
    expect(result.turnsUsed).toBe(1);
  });
});
