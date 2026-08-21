/**
 * Intégration — boucle d'un tour d'agent (§12) sur la base de test.
 *
 * Le modèle est simulé (aucun réseau), mais TOUT le reste est réel : verrou,
 * garde-fous en base, file d'attente, traces. Ce fichier tient les promesses
 * les plus lourdes du cahier :
 *  · `ai_enabled = false` fait taire TOUS les chemins automatisés ;
 *  · un désabonnement supprime le numéro et n'envoie plus rien ;
 *  · un refus mou descend d'un cran, un refus FERME ne touche pas la chaîne ;
 *  · un brouillon contenant un montant n'est JAMAIS envoyé ;
 *  · une trace est écrite même quand le tour finit bloqué ou en erreur.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  resetDb,
  testDb,
} from "./helpers/db";
import {
  agentEvents,
  agentTurnTraces,
  assistants,
  campaignEnrollments,
  campaignTouches,
  campaigns,
  conversations,
  messages,
  scheduledJobs,
  suppressions,
} from "@/db/schema-sms";
import { clients } from "@/db/schema";
import { assistantConfigSchema } from "@/lib/assistants/schema";
import type { LLMResult } from "@/lib/llm/types";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

/** Modèle simulé : chaque test décide ce que le générateur et le juge répondent. */
const llm = vi.hoisted(() => ({
  generatorText: "Parfait! Préférez-vous jeudi 14 h ou vendredi 18 h 30?",
  /** Reponses successives : le 1er appel prend [0], le 2e (regeneration) [1]. */
  generatorSequence: [] as string[],
  generatorToolCalls: [] as { id: string; name: string; arguments: Record<string, unknown> }[],
  generatorError: null as string | null,
  classifierJson: '{"refusal":"none","qualification":{}}',
  judgeJson: '{"passed":true,"reason":"conforme"}',
  calls: [] as { model: string; system: string; messages?: unknown[] }[],
  /** Hook exécuté au premier appel générateur — sert à injecter une course. */
  onGenerate: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/llm-server", () => ({
  getLlmProvider: (id: string) => ({
    id,
    listModels: async () => [],
    generate: async (input: { system: string; model: string; messages?: unknown[] }): Promise<LLMResult> => {
      llm.calls.push({ model: input.model, system: input.system, messages: input.messages });
      // Le classifieur et le juge partagent le modèle « classifier » du test.
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
      if (llm.onGenerate) {
        const hook = llm.onGenerate;
        await hook();
      }
      if (llm.generatorError) throw new Error(llm.generatorError);
      const text = llm.generatorSequence.length > 0 ? (llm.generatorSequence.shift() ?? llm.generatorText) : llm.generatorText;
      return {
        text,
        toolCalls: llm.generatorToolCalls,
        usage: { inputTokens: 100, outputTokens: 20 },
        latencyMs: 42,
        modelServed: "anthropic/claude-sonnet-5",
        upstreamProvider: "Amazon Bedrock",
        raw: { simulated: true },
      };
    },
  }),
  LlmUnconfiguredError: class extends Error {},
  configuredProviders: () => ["openrouter"],
  getModelCatalog: async () => [],
}));

/** L'agenda est simulé : aucun appel Google, aucune écriture de rendez-vous. */
vi.mock("@/lib/booking/internal", () => ({
  getInternalBookingProvider: () => ({
    getSlots: async () => ({
      slots: [
        { iso: "2026-08-27T18:00:00.000Z", label: "jeudi 14 h" },
        { iso: "2026-08-28T22:30:00.000Z", label: "vendredi 18 h 30" },
      ],
      googleConnected: true,
    }),
    book: async () => ({ ok: false as const, error: "not_bookable" as const }),
  }),
}));

const { runTurn } = await import("@/lib/agent/runtime");
const { seedGuardrailDefaults } = await import("@/lib/guardrails/store");
const { compileAssistant } = await import("@/lib/assistants/service");

// ── Montage d'une conversation prête à parler ────────────────────────────────

async function scene(overrides: { aiEnabled?: boolean; goalRung?: string } = {}) {
  await seedGuardrailDefaults();
  const config = assistantConfigSchema.parse({
    name: "Acheteur FB (test)",
    identity: {},
    approach: { maxTurns: 16, replySpeed: "instant" },
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

  const client = await makeClient({ fullName: "Marie Tremblay", phone: "+15145550142" });
  const number = await makeSmsNumber();
  const conversation = await makeConversation({
    clientId: client.id,
    smsNumberId: number.id,
    clientPhone: client.phone,
    activeAssistantId: assistant.id,
    activeAssistantVersion: assistant.version,
    aiEnabled: overrides.aiEnabled ?? true,
    goalRung: overrides.goalRung ?? "primary",
  });
  return { assistant, client, conversation };
}

/** Dépose un message entrant non traité, comme le ferait le webhook. */
async function inbound(conversationId: string, body: string) {
  await testDb.insert(messages).values({
    conversationId,
    direction: "in",
    body,
    source: "human",
    status: "received",
  });
}

const jobsFor = async (conversationId: string) =>
  (await testDb.select().from(scheduledJobs)).filter(
    (j) => (j.payload as { conversationId?: string }).conversationId === conversationId,
  );

const eventsOf = async (conversationId: string) =>
  (await testDb.select().from(agentEvents).where(eq(agentEvents.conversationId, conversationId))).map(
    (e) => e.type,
  );

describe("runTurn", () => {
  beforeEach(async () => {
    await resetDb();
    llm.generatorText = "Parfait! Préférez-vous jeudi 14 h ou vendredi 18 h 30?";
    llm.generatorToolCalls = [];
    llm.generatorSequence = [];
    llm.onGenerate = null;
    llm.generatorError = null;
    llm.classifierJson = '{"refusal":"none","qualification":{}}';
    llm.judgeJson = '{"passed":true,"reason":"conforme"}';
    llm.calls = [];
  });
  afterEach(() => vi.clearAllMocks());

  it("chemin heureux : met UN envoi en file et écrit une trace complète", async () => {
    const { conversation, assistant } = await scene();
    await inbound(conversation.id, "Oui allo, je cherche à acheter");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");

    // Exactement un envoi mis en file, avec le brouillon du modèle.
    const jobs = await jobsFor(conversation.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("send_sms");
    const payload = jobs[0].payload as { body: string; source: string; aiGenerated: boolean };
    expect(payload.body).toContain("jeudi 14 h");
    expect(payload.source).toBe("agent");
    expect(payload.aiGenerated).toBe(true);

    // L'entrant est marqué traité : il ne sera pas rejoué.
    const [msg] = await testDb.select().from(messages).where(eq(messages.direction, "in"));
    expect(msg.processedAt).not.toBeNull();

    // §21 — la trace retient le modèle qui a VRAIMENT répondu.
    const [trace] = await testDb.select().from(agentTurnTraces);
    expect(trace.outcome).toBe("sent");
    expect(trace.modelServed).toBe("anthropic/claude-sonnet-5");
    expect(trace.upstreamProvider).toBe("Amazon Bedrock");
    expect(trace.modelRequested).toBe("generator-model");
    expect(trace.assistantId).toBe(assistant.id);
    expect(trace.systemPrompt).toContain("OACIQ");
    expect(trace.runtimeBlock).toContain("jeudi 14 h"); // disponibilités réelles en L7
    expect(trace.tokensIn).toBe(100);
  });

  it("§21 — ai_enabled = false : aucun message, aucune trace, sortie immédiate", async () => {
    const { conversation } = await scene({ aiEnabled: false });
    await inbound(conversation.id, "allo?");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("skipped_ai_disabled");

    expect(await jobsFor(conversation.id)).toHaveLength(0);
    expect(await testDb.select().from(agentTurnTraces)).toHaveLength(0);
    // L'entrant n'est même pas consommé : il attendra la reprise.
    const [msg] = await testDb.select().from(messages).where(eq(messages.direction, "in"));
    expect(msg.processedAt).toBeNull();
  });

  it("une rafale d'entrants est consommée comme UN SEUL tour", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Allo");
    await inbound(conversation.id, "c'est Marie");
    await inbound(conversation.id, "je veux vendre");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");

    // Un seul envoi malgré trois entrants.
    expect(await jobsFor(conversation.id)).toHaveLength(1);
    // Les trois sont marqués traités et regroupés dans la trace.
    const inboundRows = await testDb.select().from(messages).where(eq(messages.direction, "in"));
    expect(inboundRows.every((m) => m.processedAt !== null)).toBe(true);
    const [trace] = await testDb.select().from(agentTurnTraces);
    expect((trace.inboundBatch as unknown[]).length).toBe(3);
  });

  it("sans entrant non traité, le tour ne fait rien", async () => {
    const { conversation } = await scene();
    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("skipped_no_inbound");
    expect(await jobsFor(conversation.id)).toHaveLength(0);
  });

  // ── Désabonnement ─────────────────────────────────────────────────────────

  it("§21 — désabonnement : supprime le numéro, coupe l'IA, n'envoie RIEN", async () => {
    const { conversation, client } = await scene();
    await inbound(conversation.id, "STOP");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("stopped");

    const sup = await testDb.select().from(suppressions);
    expect(sup).toHaveLength(1);
    expect(sup[0].phoneE164).toBe(client.phone);

    expect(await jobsFor(conversation.id)).toHaveLength(0);
    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.aiEnabled).toBe(false);
    expect(conv.attentionReason).toBe("optout");
    expect(await eventsOf(conversation.id)).toContain("stop");

    // Une trace existe quand même : un arrêt est un évènement à auditer.
    const [trace] = await testDb.select().from(agentTurnTraces);
    expect(trace.outcome).toBe("stopped");
  });

  // ── Chaîne d'objectifs ────────────────────────────────────────────────────

  it("§21 — un refus MOU descend au repli 0", async () => {
    const { conversation } = await scene();
    llm.classifierJson = '{"refusal":"soft"}';
    await inbound(conversation.id, "pas cette semaine");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");

    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.goalRung).toBe("fallback:0");
    expect(await eventsOf(conversation.id)).toContain("goal_downgrade");
  });

  it("§21 — un refus FERME clôt sans toucher la chaîne ni envoyer", async () => {
    const { conversation } = await scene();
    llm.classifierJson = '{"refusal":"hard"}';
    await inbound(conversation.id, "non merci, pas intéressé");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("stopped");
    expect(result.reason).toBe("hard_refusal");

    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    // La chaîne n'a PAS bougé — on ne propose pas de repli après un vrai non.
    expect(conv.goalRung).toBe("primary");
    expect(conv.aiEnabled).toBe(false);
    expect(await jobsFor(conversation.id)).toHaveLength(0);
    expect(await eventsOf(conversation.id)).toContain("hard_refusal");
  });

  // ── Filtre de sortie ──────────────────────────────────────────────────────

  it("§21 — un brouillon contenant un montant n'est JAMAIS envoyé", async () => {
    const { conversation } = await scene();
    // Le modèle persiste dans sa faute, même après la consigne de correction.
    llm.generatorText = "Votre maison vaut environ 450 000 $ selon moi.";
    await inbound(conversation.id, "ça vaut combien?");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("blocked");

    // Rien en file : le message n'existe pas.
    expect(await jobsFor(conversation.id)).toHaveLength(0);

    const events = await eventsOf(conversation.id);
    expect(events).toContain("blocked_output");
    expect(events).toContain("escalation");

    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.needsAttention).toBe(true);
    expect(conv.attentionReason).toBe("blocked_output");

    // La trace garde la preuve : verdict par règle + nombre de régénérations.
    const [trace] = await testDb.select().from(agentTurnTraces);
    expect(trace.outcome).toBe("blocked");
    expect(trace.regenerations).toBeGreaterThanOrEqual(1);
    const verdicts = trace.guardrailResults as { key: string; passed: boolean }[];
    expect(verdicts.some((v) => v.key === "no_price_opinion" && !v.passed)).toBe(true);
  });

  it("une régénération conforme EST envoyée — le filtre corrige, il ne tue pas", async () => {
    const { conversation } = await scene();
    // 1er jet fautif (un montant), 2e jet corrigé après la consigne.
    llm.generatorSequence = [
      "Votre maison vaut environ 450 000 $ selon moi.",
      "C'est exactement ce que le courtier va regarder avec vous. Jeudi 14 h?",
    ];
    await inbound(conversation.id, "ça vaut combien?");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");

    // Le message parti est le SECOND, conforme.
    const jobs = await jobsFor(conversation.id);
    expect(jobs).toHaveLength(1);
    const body = (jobs[0].payload as { body: string }).body;
    expect(body).toContain("courtier");
    expect(body).not.toContain("450");

    // La trace garde la mémoire de la reprise.
    const [trace] = await testDb.select().from(agentTurnTraces);
    expect(trace.outcome).toBe("sent");
    expect(trace.regenerations).toBe(1);
    expect(await eventsOf(conversation.id)).toContain("blocked_output");
  });

  it("une règle llm_judge en échec bloque aussi l'envoi", async () => {
    const { conversation } = await scene();
    llm.judgeJson = '{"passed":false,"reason":"prétend être humain"}';
    await inbound(conversation.id, "es-tu un robot?");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("blocked");
    expect(await jobsFor(conversation.id)).toHaveLength(0);
  });

  // ── Budget de tours et escalade ───────────────────────────────────────────

  it("le budget de tours épuisé escalade au lieu de parler", async () => {
    const { conversation } = await scene();
    // 16 messages sortants déjà envoyés = maxTurns atteint.
    for (let i = 0; i < 16; i += 1) {
      await testDb.insert(messages).values({
        conversationId: conversation.id,
        direction: "out",
        body: `message ${i}`,
        source: "agent",
      });
    }
    await inbound(conversation.id, "encore là?");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("max_turns");
    expect(await jobsFor(conversation.id)).toHaveLength(0);
    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.aiEnabled).toBe(false);
  });

  it("une demande explicite de parler à un humain escalade immédiatement", async () => {
    const { conversation } = await scene();
    llm.classifierJson = '{"wantsHuman":true}';
    await inbound(conversation.id, "je veux parler au courtier");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("client_wants_human");
  });

  // ── Pannes ────────────────────────────────────────────────────────────────

  it("une panne du générateur écrit une trace d'erreur et n'envoie rien", async () => {
    const { conversation } = await scene();
    llm.generatorError = "llm_http_503";
    await inbound(conversation.id, "allo");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("error");
    expect(await jobsFor(conversation.id)).toHaveLength(0);

    const [trace] = await testDb.select().from(agentTurnTraces);
    expect(trace.outcome).toBe("error");
    expect(await eventsOf(conversation.id)).toContain("llm_error");
  });

  it("un seul message sortant par tour, même si le modèle écrit des paragraphes", async () => {
    const { conversation } = await scene();
    llm.generatorText = "Premier paragraphe.\n\nDeuxième paragraphe.\n\nTroisième.";
    await inbound(conversation.id, "allo");

    await runTurn(conversation.id);

    const jobs = await jobsFor(conversation.id);
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as { body: string }).body).toBe("Premier paragraphe.");
    expect(await eventsOf(conversation.id)).toContain("extra_paragraphs_dropped");
  });

it("une réservation ÉCHOUÉE n'envoie AUCUNE confirmation au client", async () => {
    const { conversation } = await scene();
    // Le modèle annonce un rendez-vous ET appelle book_meeting dans le meme
    // souffle ; la reservation echoue (creneau pris). Le client ne doit JAMAIS
    // recevoir la confirmation d'un rendez-vous qui n'existe pas.
    llm.generatorToolCalls = [
      { id: "t1", name: "book_meeting", arguments: { slotIso: "2026-08-27T18:00:00.000Z" } },
    ];
    llm.generatorText = "Parfait, c'est confirmé pour jeudi 14 h!";
    await inbound(conversation.id, "oui jeudi 14h ça marche");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("booking_failed");
    // Rien en file : la fausse confirmation ne part pas.
    expect(await jobsFor(conversation.id)).toHaveLength(0);

    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.needsAttention).toBe(true);
    expect(conv.attentionReason).toBe("booking_failed");
  });

  it("un STOP NOYÉ dans une rafale reste un STOP", async () => {
    const { conversation, client } = await scene();
    // Le detecteur de mots-cles exige le message ENTIER ; concatenes, ces deux
    // messages ne matchent pas. Chaque entrant doit donc etre teste seul.
    await inbound(conversation.id, "finalement quand pourrait-on se voir?");
    await inbound(conversation.id, "STOP");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("stopped");

    const sup = await testDb.select().from(suppressions);
    expect(sup.map((s) => s.phoneE164)).toContain(client.phone);
    expect(await jobsFor(conversation.id)).toHaveLength(0);
  });

  it("la réponse manuelle d'un téléphoniste ne grignote pas le budget de l'IA", async () => {
    const { conversation } = await scene();
    // 16 messages HUMAINS : maxTurns vaut 16, mais aucun n'est de l'agent.
    for (let i = 0; i < 16; i += 1) {
      await testDb.insert(messages).values({
        conversationId: conversation.id,
        direction: "out",
        body: `réponse manuelle ${i}`,
        source: "human",
      });
    }
    await inbound(conversation.id, "et donc?");

    const result = await runTurn(conversation.id);
    // L'assistant garde son budget intact : il repond normalement.
    expect(result.outcome).toBe("sent");
  });

  it("la qualification extraite est conservée sur la conversation, pas sur la fiche client", async () => {
    const { conversation, client } = await scene();
    llm.classifierJson = '{"refusal":"none","qualification":{"project_type":"vendre","timing":"printemps"}}';
    await inbound(conversation.id, "je veux vendre au printemps");

    await runTurn(conversation.id);

    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.qualification).toMatchObject({ project_type: "vendre", timing: "printemps" });
    // La fiche client n'est PAS touchee : le formulaire humain l'ecrase en
    // entier avec un schema different, on ne melange pas les deux.
    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.qualification).toBeNull();
  });

  it("un message arrivé PENDANT le tour reprogramme un tour de suite", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "premier message");

    // Simule l'arrivee d'un message en cours de route : on l'insere juste
    // avant la phase d'ecriture, via le hook du generateur.
    let injected = false;
    llm.onGenerate = async () => {
      if (injected) return;
      injected = true;
      await inbound(conversation.id, "ah et aussi une question");
    };

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");

    // Un nouveau tour est programme pour le message reste sur le carreau.
    const turns = (await testDb.select().from(scheduledJobs)).filter((j) => j.type === "agent_turn");
    expect(turns).toHaveLength(1);
  });

    it("l'outil stop coupe la conversation et supprime le numéro", async () => {
    const { conversation, client } = await scene();
    llm.generatorToolCalls = [{ id: "t1", name: "stop", arguments: {} }];
    llm.generatorText = "Merci, bonne journée!";
    await inbound(conversation.id, "arrêtez ça");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("stopped");
    expect(await jobsFor(conversation.id)).toHaveLength(0);
    const sup = await testDb.select().from(suppressions);
    expect(sup.map((s) => s.phoneE164)).toContain(client.phone);
  });
});

// ── Tour PROACTIF : un barreau de campagne sans texte ─────────────────────────

const { handleAgentTurn } = await import("@/lib/jobs/handlers/agent-turn");

/** Une campagne, une inscription et la trace « queued » de son barreau. */
async function outreachScene(step = 0) {
  const { conversation, assistant, client } = await scene();
  const [campaign] = await testDb
    .insert(campaigns)
    .values({
      name: "Réactivation 90 j",
      description: "Vieux leads acheteurs sans nouvelles",
      status: "active",
      trigger: { kind: "manual" },
      ladder: [
        { delayHours: 0, body: null, label: "ouverture" },
        { delayHours: 72, body: null, label: "relance" },
      ],
      assistantId: assistant.id,
    })
    .returning();
  const [enrollment] = await testDb
    .insert(campaignEnrollments)
    .values({
      campaignId: campaign.id,
      clientId: client.id,
      conversationId: conversation.id,
      status: "active",
      step,
    })
    .returning();
  await testDb.insert(campaignTouches).values({
    enrollmentId: enrollment.id,
    step,
    plannedAt: new Date(),
    status: "queued",
  });
  const touchStatus = async () =>
    (await testDb.query.campaignTouches.findFirst({
      where: eq(campaignTouches.enrollmentId, enrollment.id),
    }))!.status;
  return { conversation, assistant, client, campaign, enrollment, touchStatus };
}

/** Le dernier message passé au générateur — là où vit la consigne d'ouverture. */
function lastUserContent(): string {
  const generatorCalls = llm.calls.filter((c) => c.model === "generator-model");
  const last = generatorCalls[generatorCalls.length - 1]?.messages as
    | { role: string; content: string }[]
    | undefined;
  return last?.[last.length - 1]?.content ?? "";
}

describe("tour proactif (barreau sans texte)", () => {
  beforeEach(async () => {
    await resetDb();
    llm.generatorText = "Bonjour, ici l'équipe de Groupe Nexus. Toujours un projet immobilier?";
    llm.generatorToolCalls = [];
    llm.generatorSequence = [];
    llm.onGenerate = null;
    llm.generatorError = null;
    llm.classifierJson = '{"refusal":"none","qualification":{}}';
    llm.judgeJson = '{"passed":true,"reason":"conforme"}';
    llm.calls = [];
  });
  afterEach(() => vi.clearAllMocks());

  it("sans entrant mais avec un barreau à rédiger, l'assistant ÉCRIT en premier", async () => {
    // Le bogue d'origine : le tour cherchait un entrant, n'en trouvait pas et
    // se terminait en « skipped ». L'échelle avançait, la trace disait
    // « queued », aucun message ne partait — et rien ne le disait.
    const { conversation, enrollment, touchStatus } = await outreachScene();

    const outcome = await handleAgentTurn({
      payload: { conversationId: conversation.id, outreach: { enrollmentId: enrollment.id, step: 0 } },
    } as never);
    expect(outcome.outcome).toBe("done");

    const sends = (await jobsFor(conversation.id)).filter((j) => j.type === "send_sms");
    expect(sends).toHaveLength(1);
    expect((sends[0].payload as { source: string; aiGenerated: boolean }).source).toBe("agent");
    expect((sends[0].payload as { aiGenerated: boolean }).aiGenerated).toBe(true);

    // La consigne porte le POURQUOI (nom + description de la campagne) et
    // demande explicitement le premier message…
    const instruction = lastUserContent();
    expect(instruction).toContain("Réactivation 90 j");
    expect(instruction).toContain("PREMIER message");
    // …mais n'est JAMAIS stockée : le contact ne la voit pas et les tours
    // suivants ne la relisent pas comme un message du client.
    const stored = await testDb.select().from(messages);
    expect(stored.some((m) => m.body.includes("Contexte interne"))).toBe(false);

    const [trace] = await testDb.select().from(agentTurnTraces);
    expect(trace.outcome).toBe("sent");
    expect((trace.inboundBatch as unknown[]).length).toBe(0);
    expect(await eventsOf(conversation.id)).toContain("outreach");
    // Le barreau sait maintenant qu'un message est parti.
    expect(await touchStatus()).toBe("sent");
    // Le classifieur n'a pas été appelé : rien à classer.
    expect(llm.calls.filter((c) => c.model === "classifier-model" && !c.system.includes("évaluateur"))).toHaveLength(0);
  });

  it("une relance dit au modèle qu'il relance, et laquelle", async () => {
    const { conversation, enrollment } = await outreachScene(1);
    const result = await runTurn(conversation.id, { outreach: { enrollmentId: enrollment.id, step: 1 } });
    expect(result.outcome).toBe("sent");
    const instruction = lastUserContent();
    expect(instruction).toContain("relance 1 sur 1");
    expect(instruction).not.toContain("PREMIER");
  });

  it("si le contact écrit PENDANT l'ouverture, l'ouverture s'efface et un tour de réponse est posé", async () => {
    // Sinon le contact recevrait notre ouverture APRÈS sa propre question.
    const { conversation, enrollment, touchStatus } = await outreachScene();
    llm.onGenerate = async () => {
      await inbound(conversation.id, "Allo, c'est qui?");
    };

    const outcome = await handleAgentTurn({
      payload: { conversationId: conversation.id, outreach: { enrollmentId: enrollment.id, step: 0 } },
    } as never);
    expect(outcome.outcome).toBe("skipped");

    const jobs = await jobsFor(conversation.id);
    expect(jobs.filter((j) => j.type === "send_sms")).toHaveLength(0);
    // Un tour de RÉPONSE existe (clé `turn:`), l'entrant n'a pas été consommé.
    expect(jobs.filter((j) => j.type === "agent_turn" && j.dedupeKey === `turn:${conversation.id}`)).toHaveLength(1);
    const [row] = await testDb.select().from(messages).where(eq(messages.direction, "in"));
    expect(row.processedAt).toBeNull();
    expect(await touchStatus()).toBe("superseded");
  });

  it("avec un entrant en attente, le contexte de barreau ne change rien : on répond", async () => {
    const { conversation, enrollment, touchStatus } = await outreachScene();
    await inbound(conversation.id, "Oui, je cherche à acheter");

    const outcome = await handleAgentTurn({
      payload: { conversationId: conversation.id, outreach: { enrollmentId: enrollment.id, step: 0 } },
    } as never);
    expect(outcome.outcome).toBe("done");

    const [trace] = await testDb.select().from(agentTurnTraces);
    expect((trace.inboundBatch as unknown[]).length).toBe(1);
    expect(await eventsOf(conversation.id)).not.toContain("outreach");
    expect(lastUserContent()).toBe("Oui, je cherche à acheter");
    // La réponse satisfait le barreau.
    expect(await touchStatus()).toBe("sent");
  });

  it("un garde-fou bloquant laisse la trace du barreau à « blocked », rien ne part", async () => {
    const { conversation, enrollment, touchStatus } = await outreachScene();
    llm.judgeJson = '{"passed":false,"reason":"ne nomme pas l\'organisation"}';
    const outcome = await handleAgentTurn({
      payload: { conversationId: conversation.id, outreach: { enrollmentId: enrollment.id, step: 0 } },
    } as never);
    expect(outcome.outcome).toBe("done");
    expect((await jobsFor(conversation.id)).filter((j) => j.type === "send_sms")).toHaveLength(0);
    expect(await touchStatus()).toBe("blocked");
  });
});

// La connexion se ferme APRÈS le dernier bloc — pas à la fin du premier.
afterAll(closeDb);
