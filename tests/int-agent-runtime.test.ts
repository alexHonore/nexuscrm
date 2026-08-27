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
import { and, eq } from "drizzle-orm";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  makeCategory,
  makeSource,
  makeUser,
  resetDb,
  seedSystemCategories,
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
import { auditLogs, categories, clients, comments, followups, notifications } from "@/db/schema";
import { setSetting } from "@/lib/settings";
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
  /** Le fournisseur a coupé la réponse (max_tokens) — testé sur le tour. */
  truncated: false,
  /** Fournisseurs SANS clé : getLlmProvider lève, comme en production. */
  unconfigured: [] as string[],
}));

vi.mock("@/lib/llm-server", () => ({
  getLlmProvider: (id: string) => {
    if (llm.unconfigured.includes(id)) throw new Error(`llm_provider_unconfigured: ${id}`);
    return {
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
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
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
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
        latencyMs: 42,
        modelServed: "anthropic/claude-sonnet-5",
        upstreamProvider: "Amazon Bedrock",
        ...(llm.truncated ? { truncated: true, finishReason: "length" as const } : {}),
        raw: { simulated: true },
      };
    },
  };
  },
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
const { flushAfterResponse } = await import("@/lib/after-response");
const { seedGuardrailDefaults } = await import("@/lib/guardrails/store");
const { compileAssistant } = await import("@/lib/assistants/service");

// ── Montage d'une conversation prête à parler ────────────────────────────────

async function scene(overrides: { aiEnabled?: boolean; goalRung?: string } = {}) {
  await seedGuardrailDefaults();
  // Un administrateur actif : destinataire des alertes et des rappels quand la
  // fiche n'a pas d'assigné — comme en production.
  await makeUser({ role: "admin", email: `admin-${Math.random().toString(16).slice(2)}@x.test` });
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
      // La porte d'activation est consultative ici : le tour exige un
      // assistant ACTIF, et la suite n'est pas le sujet de ces tests.
      requireSuitePass: false,
    })
    .returning();
  await compileAssistant(assistant.id, null);
  await testDb.update(assistants).set({ status: "active" }).where(eq(assistants.id, assistant.id));

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
    llm.truncated = false;
    llm.unconfigured = [];
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
    // Le TOUR entier, pas le dernier appel : générateur (100) + classifieur
    // et juges (10 chacun). N'écrire que le dernier appel montrait ~1/8 de la
    // dépense réelle du compte OpenRouter (constat du 2026-08-26).
    expect(trace.tokensIn).toBeGreaterThanOrEqual(110);
    expect(trace.tokensOut).toBeGreaterThanOrEqual(25);
    // Et le COÛT s'additionne de même : 0,01 $ (générateur) + 0,001 $ par
    // appel de classification/jugement — jamais le seul dernier appel.
    expect(Number(trace.costUsd)).toBeGreaterThanOrEqual(0.011);
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

  it("§21 — un refus FERME : UN adieu part, puis l'IA se tait et l'inscription s'arrête", async () => {
    const { conversation, enrollment } = await outreachScene();
    llm.classifierJson = '{"refusal":"hard"}';
    llm.generatorText = "Merci pour votre réponse, bonne continuation!";
    await inbound(conversation.id, "non merci, pas intéressé");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");
    expect(result.reason).toBe("hard_refusal");

    // L'adieu est en file — la « clôture polie » que promet la doctrine.
    const sends = (await jobsFor(conversation.id)).filter((j) => j.type === "send_sms");
    expect(sends).toHaveLength(1);
    expect((sends[0].payload as { body: string }).body).toContain("bonne continuation");

    // Et il PART : l'IA vient d'être mise en pause dans la même transaction —
    // sans le drapeau « dernier mot », la garde ai_paused du job d'envoi le
    // supprimait en silence et le fil ne recevait jamais l'adieu.
    expect((sends[0].payload as { finalWord?: boolean }).finalWord).toBe(true);
    const { handleSendSms } = await import("@/lib/jobs/handlers/send-sms");
    const midday = () => new Date("2026-08-24T15:00:00.000Z");
    expect(await handleSendSms(sends[0], midday)).toMatchObject({ outcome: "done" });
    const delivered = await testDb
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, "out")));
    expect(delivered).toHaveLength(1);
    expect(delivered[0].body).toContain("bonne continuation");

    // Le modèle a reçu la consigne de clôture, par-dessus le prompt compilé.
    const call = llm.calls.find((c) => c.model === "generator-model");
    expect(call?.system).toContain("CLÔTURE");

    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    // La chaîne n'a PAS bougé — on ne propose pas de repli après un vrai non.
    expect(conv.goalRung).toBe("primary");
    expect(conv.aiEnabled).toBe(false);
    expect(conv.attentionReason).toBe("hard_refusal");
    expect(await eventsOf(conversation.id)).toContain("hard_refusal");

    // Plus AUCUNE relance : l'inscription de campagne est stoppée dès ce tour.
    const enr = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrollment.id),
    });
    expect(enr!.status).toBe("stopped");
    expect(enr!.endReason).toBe("hard_refusal");

    const notes = await testDb.select().from(notifications);
    expect(notes.some((n) => n.type === "sms_stopped")).toBe(true);
  });

  it("§21 — refus ferme + modèle en panne : arrêt SILENCIEUX immédiat, sans reprise", async () => {
    const { conversation, enrollment } = await outreachScene();
    llm.classifierJson = '{"refusal":"hard"}';
    llm.generatorError = "upstream 502";
    await inbound(conversation.id, "non merci");

    // DÈS la première tentative (pas de finalAttempt) : rejouer le tour
    // soumettrait le refus à une deuxième classification — un raté du
    // classifieur à la reprise le dégraderait en « none » et l'assistant
    // repartirait en argumentaire chez quelqu'un qui a dit non.
    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("stopped");
    expect(result.reason).toBe("hard_refusal");

    expect((await jobsFor(conversation.id)).filter((j) => j.type === "send_sms")).toHaveLength(0);
    // L'entrant est consommé : le refus est réglé, la file n'a rien à rejouer.
    const [row] = await testDb.select().from(messages).where(eq(messages.direction, "in"));
    expect(row.processedAt).not.toBeNull();
    const [conv] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    expect(conv.aiEnabled).toBe(false);
    expect(conv.attentionReason).toBe("hard_refusal");
    // Même en panne, personne ne relancera : l'inscription est stoppée.
    const enr = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrollment.id),
    });
    expect(enr!.status).toBe("stopped");
    const notes = await testDb.select().from(notifications);
    expect(notes.some((n) => n.type === "sms_stopped")).toBe(true);
  });

  it("add_client_comment : la note atterrit sur la fiche, SIGNÉE de l'assistant", async () => {
    const { conversation, client } = await scene();
    await inbound(conversation.id, "J'ai déjà un courtier mais je reste ouvert");
    llm.generatorToolCalls = [
      { id: "c1", name: "add_client_comment", arguments: { text: "A déjà un courtier mais reste ouvert." } },
    ];
    llm.generatorSequence = ["", "Bien noté, merci de la précision!"];
    let calls = 0;
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };

    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const rows = await testDb.select().from(comments).where(eq(comments.clientId, client.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("Assistant « Acheteur FB (test) »");
    expect(rows[0].body).toContain("A déjà un courtier");
    // L'auteur est un utilisateur réel (l'admin, la fiche n'étant pas assignée).
    expect(rows[0].userId).not.toBeNull();
  });

  it("schedule_followup SANS moment : « appelez-moi » devient une tâche au prochain matin", async () => {
    const { conversation, client } = await scene();
    await inbound(conversation.id, "Appelez-moi svp");
    llm.generatorToolCalls = [{ id: "c1", name: "schedule_followup", arguments: {} }];
    llm.generatorSequence = ["", "Parfait, on vous appelle dès demain matin!"];
    let calls = 0;
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };

    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const rows = await testDb.select().from(followups).where(eq(followups.clientId, client.id));
    expect(rows).toHaveLength(1);
    // Demain, 9 h heure de Toronto — jamais dans le passé.
    expect(rows[0].dueAt.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0].dueAt.getTime()).toBeLessThan(Date.now() + 36 * 3600 * 1000);
    expect(rows[0].assignedToId).not.toBeNull();
  });

  it("clôture sans set_category : la fiche est RANGÉE automatiquement (Pas intéressé)", async () => {
    await seedSystemCategories();
    const { conversation, client } = await outreachScene();
    llm.classifierJson = '{"refusal":"hard"}';
    llm.generatorText = "Merci de votre réponse, bonne continuation!";
    await inbound(conversation.id, "non merci, plus intéressé");

    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    const cats = await testDb.select().from(categories);
    const notInterested = cats.find((c) => c.key === "not_interested")!;
    expect(row.categoryId).toBe(notInterested.id);
    expect(await eventsOf(conversation.id)).toContain("auto_categorized");
    // Et l'audit dit pourquoi, sans prétendre qu'un humain a cliqué.
    const logs = await testDb.select().from(auditLogs);
    const entry = logs.find((l) => l.action === "client.category");
    expect(entry?.userId).toBeNull();
    expect((entry?.detail as { via: string }).via).toBe("assistant_close");
  });

  it("un refus ferme RESTE un refus ferme, même si le classement automatique retire la fiche de la campagne", async () => {
    // La course : clore un fil range la fiche (« Pas intéressé »), ce qui la
    // sort de l'audience de la campagne et déclenche la libération — dans le
    // même tour, avant le commit. Si la libération gagne, l'inscription se lit
    // « sortie d'audience » et le refus ferme disparaît du taux d'arrêts : la
    // campagne semble ne froisser personne.
    const cats = await seedSystemCategories();
    const { conversation, client, campaign, enrollment } = await outreachScene();
    // La campagne ne vise QUE la catégorie de départ — sans cette restriction,
    // `targetsCategory` répond toujours vrai et la course n'existe pas.
    await testDb
      .update(campaigns)
      .set({ audience: { categoryIds: [cats.callback.id] } })
      .where(eq(campaigns.id, campaign.id));
    await testDb
      .update(clients)
      .set({ categoryId: cats.callback.id })
      .where(eq(clients.id, client.id));

    llm.classifierJson = '{"refusal":"hard"}';
    llm.generatorText = "Merci de votre réponse, bonne continuation!";
    await inbound(conversation.id, "non merci, plus intéressé");
    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    await flushAfterResponse();

    // La fiche a bien été rangée, donc la libération avait de quoi mordre…
    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.categoryId).toBe(cats.not_interested.id);
    // …mais c'est le verdict de la CONVERSATION qui est écrit.
    const enr = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrollment.id),
    });
    expect(enr!.status).toBe("stopped");
    expect(enr!.endReason).toBe("hard_refusal");
  });

  it("close_conversation « disqualified » range la fiche dans Non qualifié", async () => {
    await seedSystemCategories();
    const { conversation, client } = await outreachScene();
    await inbound(conversation.id, "Je suis à Gaspé finalement");
    llm.generatorToolCalls = [
      { id: "c1", name: "close_conversation", arguments: { outcome: "disqualified" } },
    ];
    llm.generatorSequence = ["", "Merci de la précision — je vous souhaite bonne chance dans vos démarches!"];
    let calls = 0;
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };

    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    const cats = await testDb.select().from(categories);
    expect(row.categoryId).toBe(cats.find((c) => c.key === "not_qualified")!.id);
  });

  it("un appel d'outil NON OFFERT sur le tour de clôture est écarté, jamais exécuté", async () => {
    // Le modèle hallucine book_meeting pendant l'adieu : sans la borne
    // « l'offre n'est pas la permission », la réservation était tentée.
    const { conversation } = await scene();
    llm.classifierJson = '{"refusal":"hard"}';
    llm.generatorToolCalls = [
      { id: "b1", name: "book_meeting", arguments: { slotIso: "2026-08-27T18:00:00.000Z" } },
    ];
    llm.generatorText = "Merci, bonne continuation!";
    let calls = 0;
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };
    await inbound(conversation.id, "non merci");

    const result = await runTurn(conversation.id);
    // L'appel non offert est ignoré : l'adieu part, aucune réservation tentée.
    expect(result.outcome).toBe("sent");
    expect(result.reason).toBe("hard_refusal");
    const events = await testDb.select().from(agentEvents);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(0);
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
    llm.truncated = false;
    llm.unconfigured = [];
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

// ── Corrections de la revue : statut, outils réels, pannes, alertes ──────────

describe("statut, outils et pannes (revue)", () => {
  beforeEach(async () => {
    await resetDb();
    llm.generatorText = "Parfait! Préférez-vous jeudi 14 h ou vendredi 18 h 30?";
    llm.generatorToolCalls = [];
    llm.generatorSequence = [];
    llm.onGenerate = null;
    llm.generatorError = null;
    llm.truncated = false;
    llm.unconfigured = [];
    llm.classifierJson = '{"refusal":"none","qualification":{}}';
    llm.judgeJson = '{"passed":true,"reason":"conforme"}';
    llm.calls = [];
  });
  afterEach(() => vi.clearAllMocks());

  it("un assistant qui n'est PAS actif ne parle pas — brouillon ou archivé", async () => {
    // La porte d'activation serait contournée par un fil ancien qui garde un
    // assistant remis en brouillon.
    const { conversation, assistant } = await scene();
    await testDb.update(assistants).set({ status: "draft" }).where(eq(assistants.id, assistant.id));
    await inbound(conversation.id, "Allo?");
    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("skipped_no_assistant");
    expect(result.reason).toBe("assistant_inactive");
    expect(await jobsFor(conversation.id)).toHaveLength(0);
  });

  it("update_qualification ENREGISTRE les champs ; schedule_followup POSE un rappel", async () => {
    const { conversation, client } = await scene();
    await inbound(conversation.id, "Je cherche un condo à Lévis, rappelez-moi lundi");
    const monday = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    llm.generatorToolCalls = [
      { id: "c1", name: "update_qualification", arguments: { fields: { project_type: "condo", sector: "Lévis" } } },
      { id: "c2", name: "schedule_followup", arguments: { whenIso: monday, note: "rappel demandé" } },
    ];
    // Deuxième appel (après les résultats d'outils) : plus d'appels, un texte.
    llm.generatorSequence = ["", "Parfait, je note un rappel lundi. Bonne journée!"];
    let calls = 0;
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, conversation.id) });
    expect(conv!.qualification).toMatchObject({ project_type: "condo", sector: "Lévis" });
    const rows = await testDb.select().from(followups).where(eq(followups.clientId, client.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe("rappel demandé");
    expect(rows[0].assignedToId).not.toBeNull();
    // La colonne dénormalisée suit, comme pour un rappel posé à la main :
    // sans elle, les filtres « à venir », la pastille du pipeline et l'export
    // ne voyaient pas le rappel de l'assistant.
    const fiche = await testDb.query.clients.findFirst({ where: eq(clients.id, client.id) });
    expect(fiche!.nextFollowupAt?.toISOString()).toBe(monday);
  });

  it("schedule_followup n'AVANCE jamais un rappel déjà plus proche", async () => {
    const { conversation, client } = await scene();
    // La fiche a déjà un rappel demain : celui de l'assistant (dans 3 jours)
    // ne doit pas le repousser — `nextFollowupAt` est le PLUS PROCHE.
    const demain = new Date(Date.now() + 24 * 3600 * 1000);
    await testDb.update(clients).set({ nextFollowupAt: demain }).where(eq(clients.id, client.id));
    await inbound(conversation.id, "Rappelez-moi la semaine prochaine");
    const later = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    llm.generatorToolCalls = [
      { id: "c1", name: "schedule_followup", arguments: { whenIso: later, note: "plus tard" } },
    ];
    llm.generatorSequence = ["", "C'est noté, je vous relance la semaine prochaine!"];
    let calls = 0;
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };

    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const fiche = await testDb.query.clients.findFirst({ where: eq(clients.id, client.id) });
    expect(fiche!.nextFollowupAt?.toISOString()).toBe(demain.toISOString());
  });

  it("close_conversation FERME le fil après l'envoi et clôt l'inscription", async () => {
    const { conversation, enrollment } = await outreachScene();
    await inbound(conversation.id, "Non merci, j'ai déjà acheté");
    llm.generatorToolCalls = [
      { id: "c1", name: "close_conversation", arguments: { outcome: "not_interested" } },
    ];
    let calls = 0;
    llm.generatorSequence = ["", "Merci pour votre réponse, bonne continuation!"];
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };
    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, conversation.id) });
    expect(conv!.aiEnabled).toBe(false);
    expect(conv!.attentionReason).toBe("closed_not_interested");
    // Le message de clôture PART malgré l'IA en pause : c'est le « dernier
    // mot » — la garde ai_paused du job d'envoi le supprimait en silence.
    const [sendJob] = (await jobsFor(conversation.id)).filter((j) => j.type === "send_sms");
    expect((sendJob.payload as { finalWord?: boolean }).finalWord).toBe(true);
    const { handleSendSms } = await import("@/lib/jobs/handlers/send-sms");
    expect(
      await handleSendSms(sendJob, () => new Date("2026-08-24T15:00:00.000Z")),
    ).toMatchObject({ outcome: "done" });
    const enr = await testDb.query.campaignEnrollments.findFirst({ where: eq(campaignEnrollments.id, enrollment.id) });
    expect(enr!.status).toBe("stopped");
    expect(enr!.endReason).toBe("not_interested");
    // Un humain est prévenu.
    const notes = await testDb.select().from(notifications);
    expect(notes.some((n) => n.type === "sms_closed")).toBe(true);
  });

  it("panne passagère du modèle : les entrants restent À TRAITER pour la reprise, pas d'alerte", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Allo?");
    llm.generatorError = "upstream 502";
    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("error");
    const [row] = await testDb.select().from(messages).where(eq(messages.direction, "in"));
    expect(row.processedAt).toBeNull();
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, conversation.id) });
    expect(conv!.needsAttention).toBe(false);
    expect(await testDb.select().from(notifications)).toHaveLength(0);
    // Une trace existe quand même.
    expect(await testDb.select().from(agentTurnTraces)).toHaveLength(1);
  });

  it("dernière tentative : la panne consomme, passe la main et PRÉVIENT", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Allo?");
    llm.generatorError = "upstream 502";
    const result = await runTurn(conversation.id, { finalAttempt: true });
    expect(result.outcome).toBe("error");
    const [row] = await testDb.select().from(messages).where(eq(messages.direction, "in"));
    expect(row.processedAt).not.toBeNull();
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, conversation.id) });
    expect(conv!.needsAttention).toBe(true);
    expect(conv!.attentionReason).toBe("llm_error");
    const notes = await testDb.select().from(notifications);
    expect(notes.some((n) => n.type === "sms_error")).toBe(true);
  });

  it("le modèle de REPLI est utilisé quand le principal tombe", async () => {
    const { conversation, assistant } = await scene();
    await testDb
      .update(assistants)
      .set({ model: { ...(assistant.model as object), fallback: { provider: "openrouter", model: "fallback-model" } } })
      .where(eq(assistants.id, assistant.id));
    await inbound(conversation.id, "Allo?");
    // Le générateur principal échoue, le repli (autre identifiant) répond.
    llm.onGenerate = async () => {
      const last = llm.calls[llm.calls.length - 1];
      if (last?.model === "generator-model") throw new Error("primary down");
    };
    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");
    expect(llm.calls.some((c) => c.model === "fallback-model")).toBe(true);
    expect(await eventsOf(conversation.id)).toContain("fallback_used");
  });

  it("un repli SANS CLÉ n'efface pas la panne d'origine : l'alerte dit les deux", async () => {
    // L'incident réel : crédits OpenRouter épuisés (llm_http_402), repli
    // anthropic sans clé — et chaque notification disait seulement
    // « llm_provider_unconfigured: anthropic », la vraie cause invisible.
    const { conversation } = await scene();
    await inbound(conversation.id, "Allo?");
    llm.generatorError = "llm_http_402: This request requires more credits";
    llm.unconfigured = ["anthropic"];

    const result = await runTurn(conversation.id, { finalAttempt: true });
    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("llm_http_402");
    expect(result.reason).toContain("repli anthropic sans clé configurée");

    const notes = await testDb.select().from(notifications);
    const note = notes.find((n) => n.type === "sms_error");
    expect(note?.body ?? "").toContain("llm_http_402");
  });

  it("une réponse envoyée EFFACE la pastille « nouveau message »", async () => {
    const { conversation } = await scene();
    await testDb
      .update(conversations)
      .set({ needsAttention: true, attentionReason: "inbound" })
      .where(eq(conversations.id, conversation.id));
    await inbound(conversation.id, "Allo?");
    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, conversation.id) });
    expect(conv!.needsAttention).toBe(false);
    expect(conv!.attentionReason).toBeNull();
  });

  it("un passage à l'humain PRÉVIENT quelqu'un", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Je veux parler à quelqu'un");
    llm.classifierJson = '{"refusal":"none","qualification":{},"wantsHuman":true}';
    expect((await runTurn(conversation.id)).outcome).toBe("handoff");
    const notes = await testDb.select().from(notifications);
    expect(notes.some((n) => n.type === "sms_handoff")).toBe(true);
  });

  it("« appelez-moi » crée une TÂCHE : rappel posé au prochain matin, avec les mots du client", async () => {
    // Une pastille d'inbox s'oublie ; un rappel daté (fiche, tableau de bord,
    // pipeline) non. Le rappel est posé en CODE, pas confié au modèle.
    const { conversation, client } = await scene();
    await inbound(conversation.id, "Oui toujours intéressé — appelez-moi svp");
    llm.classifierJson = '{"refusal":"none","qualification":{},"wantsHuman":true}';

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("client_wants_human");

    const rows = await testDb.select().from(followups).where(eq(followups.clientId, client.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toContain("appelez-moi svp");
    expect(rows[0].assignedToId).not.toBeNull();
    expect(rows[0].dueAt.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0].dueAt.getTime()).toBeLessThan(Date.now() + 36 * 3600 * 1000);
    const fiche = await testDb.query.clients.findFirst({ where: eq(clients.id, client.id) });
    expect(fiche!.nextFollowupAt).not.toBeNull();
    expect(await eventsOf(conversation.id)).toContain("followup_created");
  });

  it("un corps vide (MMS sans texte) ne part pas tel quel au modèle", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "   ");
    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const generatorCall = llm.calls.find((c) => c.model === "generator-model");
    const msgs = generatorCall?.messages as { role: string; content: string }[];
    expect(msgs[msgs.length - 1].content).toContain("message sans texte");
  });

  it("un message arrivé PENDANT le tour obtient son propre tour, sous une clé que le job en cours n'absorbe pas", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Allo?");
    llm.onGenerate = async () => {
      await inbound(conversation.id, "Et aussi : vendredi ça irait");
    };
    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const jobs = await jobsFor(conversation.id);
    const next = jobs.filter((j) => j.type === "agent_turn");
    expect(next).toHaveLength(1);
    expect(next[0].dedupeKey).toBe(`turn:${conversation.id}:next`);
  });

  it("encore des appels d'outils au deuxième tour : un TROISIÈME passage sans outils produit le texte", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Quand êtes-vous disponible?");
    llm.generatorToolCalls = [{ id: "c1", name: "get_slots", arguments: { count: 2 } }];
    llm.generatorSequence = ["", "", "Je vous propose jeudi 14 h ou vendredi 18 h 30."];
    let calls = 0;
    llm.onGenerate = async () => {
      calls += 1;
      // Le troisième appel n'offre plus d'outils : le modèle n'en appelle plus.
      if (calls >= 3) llm.generatorToolCalls = [];
    };
    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");
    expect(llm.calls.filter((c) => c.model === "generator-model")).toHaveLength(3);
  });
});

describe("câblage inter-domaines (revue)", () => {
  beforeEach(async () => {
    await resetDb();
    llm.generatorText = "Parfait! Préférez-vous jeudi 14 h ou vendredi 18 h 30?";
    llm.generatorToolCalls = [];
    llm.generatorSequence = [];
    llm.onGenerate = null;
    llm.generatorError = null;
    llm.truncated = false;
    llm.unconfigured = [];
    llm.classifierJson = '{"refusal":"none","qualification":{}}';
    llm.judgeJson = '{"passed":true,"reason":"conforme"}';
    llm.calls = [];
  });
  afterEach(() => vi.clearAllMocks());

  it("get_slots rend le libellé ET l'ISO — book_meeting exige le créneau exact", async () => {
    // Sans l'ISO, le modèle reformulait l'heure et chaque réservation était
    // refusée : « slot_taken », puis passage à l'humain.
    const { conversation } = await scene();
    await inbound(conversation.id, "Quand êtes-vous libre?");
    llm.generatorToolCalls = [{ id: "c1", name: "get_slots", arguments: { count: 2 } }];
    let calls = 0;
    llm.generatorSequence = ["", "Je vous propose jeudi 14 h."];
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };
    await runTurn(conversation.id);
    const generatorCalls = llm.calls.filter((c) => c.model === "generator-model");
    const msgs = generatorCalls[generatorCalls.length - 1]?.messages as { role: string; content: string }[];
    const toolMessage = msgs.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("2026-08-27T18:00:00.000Z");
    expect(toolMessage?.content).toContain("jeudi 14 h");
  });

  it("une réponse COUPÉE par le modèle ne part pas : passage à l'humain", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Allo?");
    llm.truncated = true;
    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("handoff");
    expect(result.reason).toBe("truncated");
    expect((await jobsFor(conversation.id)).filter((j) => j.type === "send_sms")).toHaveLength(0);
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, conversation.id) });
    expect(conv!.attentionReason).toBe("truncated");
    expect(await eventsOf(conversation.id)).toContain("truncated");
  });

  it("un SMS parti met à jour « dernier contact » du client", async () => {
    // Sinon une campagne « sans nouvelles depuis N jours » réécrit à qui on
    // vient d'écrire.
    const { conversation, client } = await scene();
    await inbound(conversation.id, "Allo?");
    expect((await runTurn(conversation.id)).outcome).toBe("sent");
    const [job] = (await jobsFor(conversation.id)).filter((j) => j.type === "send_sms");
    const { handleSendSms } = await import("@/lib/jobs/handlers/send-sms");
    // Horloge fixée un lundi 11 h (Toronto) : lancé le soir, le handler
    // reportait l'envoi aux heures de politesse et le test devenait flou.
    const midday = () => new Date("2026-08-24T15:00:00.000Z");
    expect(await handleSendSms(job, midday)).toMatchObject({ outcome: "done" });
    const row = await testDb.query.clients.findFirst({ where: eq(clients.id, client.id) });
    // En dry_run rien ne part vraiment : la date ne bouge donc pas.
    expect(row!.lastContactedAt).toBeNull();
  });

  it("interrupteur baissé : aucun appel au modèle, le tour est reporté", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Allo?");
    const { setSetting, getSetting } = await import("@/lib/settings");
    const current = await getSetting("sms");
    await setSetting("sms", { ...current, killSwitch: true });
    const { handleAgentTurn } = await import("@/lib/jobs/handlers/agent-turn");
    const outcome = await handleAgentTurn({ id: "j", attempts: 0, payload: { conversationId: conversation.id } } as never);
    expect(outcome.outcome).toBe("reschedule");
    expect(llm.calls).toHaveLength(0);
    await setSetting("sms", { ...current, killSwitch: false });
  });
});

describe("set_category — l'assistant range la fiche", () => {
  // Ce bloc est frère de « runTurn » : il ne profite pas de son `beforeEach`,
  // et sans remise à zéro les tests s'empilent sur la base du précédent.
  beforeEach(async () => {
    await resetDb();
    llm.generatorText = "Entendu.";
    llm.generatorToolCalls = [];
    llm.generatorSequence = [];
    llm.onGenerate = null;
    llm.generatorError = null;
    llm.truncated = false;
    llm.unconfigured = [];
    llm.classifierJson = '{"refusal":"none","qualification":{}}';
    llm.judgeJson = '{"passed":true,"reason":"conforme"}';
    llm.calls = [];
  });
  afterEach(() => vi.clearAllMocks());

  /** Le pipeline réel plus les règles qu'Alex a décrites. */
  async function withRules() {
    await seedSystemCategories();
    // « Long terme » n'est pas une catégorie SYSTÈME : elle vient de la
    // semence étendue, comme chez Alex. On la crée donc explicitement.
    const longTerm = await makeCategory({ key: "long_term", nameFr: "Long terme", nameEn: "Long term" });
    const rows = await testDb.select().from(categories);
    const notQualified = rows.find((c) => c.key === "not_qualified")!;
    await setSetting("classification", {
      rules: [
        { id: "r1", when: "le projet est à plus de six mois", category: "long_term", enabled: true },
        {
          id: "r2",
          when: "la personne est hors de Grand Québec, Grand Lévis ou Grand Montréal",
          category: "not_qualified",
          enabled: true,
        },
      ],
    });
    return { longTerm, notQualified };
  }

  it("« je veux acheter mais l'année prochaine » → Long terme", async () => {
    const { longTerm } = await withRules();
    const { conversation, client } = await scene();
    llm.generatorToolCalls = [
      {
        id: "t1",
        name: "set_category",
        arguments: { categoryKey: "long_term", reason: "elle achète l'année prochaine" },
      },
    ];
    llm.generatorText = "Parfait, je vous relance au printemps alors.";
    await inbound(conversation.id, "je veux acheter mais l'année prochaine");
    await runTurn(conversation.id);

    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.categoryId).toBe(longTerm.id);

    // « qui » est null — personne n'a cliqué — mais « pourquoi » est écrit.
    const logs = await testDb.select().from(auditLogs);
    const entry = logs.find((l) => l.action === "client.category");
    expect(entry?.userId).toBeNull();
    expect((entry?.detail as { reason: string; via: string }).via).toBe("assistant");
    expect((entry?.detail as { reason: string }).reason).toBe("elle achète l'année prochaine");
  });

  it("« je suis au saguenay » → Non qualifié", async () => {
    const { notQualified } = await withRules();
    const { conversation, client } = await scene();
    llm.generatorToolCalls = [
      {
        id: "t1",
        name: "set_category",
        arguments: { categoryKey: "not_qualified", reason: "elle est au Saguenay" },
      },
    ];
    await inbound(conversation.id, "je suis au saguenay");
    await runTurn(conversation.id);

    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.categoryId).toBe(notQualified.id);
  });

  it("un refus FERME laisse le temps de CLASSER la fiche avant de se taire", async () => {
    // « Non, on n'est plus intéressés » : l'adieu part, la fiche est rangée
    // (set_category), puis l'IA se tait — plus jamais « IA en pause » sans
    // réponse ni classement.
    const { longTerm } = await withRules();
    const { conversation, client } = await scene();
    llm.classifierJson = '{"refusal":"hard"}';
    llm.generatorToolCalls = [
      {
        id: "t1",
        name: "set_category",
        arguments: { categoryKey: "long_term", reason: "projet reporté, plus intéressé pour l'instant" },
      },
    ];
    llm.generatorSequence = ["", "Merci de votre réponse, bonne continuation!"];
    let calls = 0;
    llm.onGenerate = async () => {
      calls += 1;
      if (calls >= 2) llm.generatorToolCalls = [];
    };
    await inbound(conversation.id, "non, on n'est plus intéressés");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("sent");
    expect(result.reason).toBe("hard_refusal");

    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.categoryId).toBe(longTerm.id);

    const conv = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(conv!.aiEnabled).toBe(false);
  });

  it("une clé HORS des règles est refusée, et le refus dit lesquelles sont permises", async () => {
    // « Ne pas appeler » sort quelqu'un du pipeline : aucune règle n'y mène,
    // donc l'assistant ne peut pas l'y mettre. Le refus doit être exploitable
    // au même tour, sinon le modèle réessaie la même clé indéfiniment.
    await withRules();
    const { conversation, client } = await scene();
    const before = (await testDb.select().from(clients).where(eq(clients.id, client.id)))[0];
    llm.generatorToolCalls = [
      { id: "t1", name: "set_category", arguments: { categoryKey: "dncl", reason: "au cas où" } },
    ];
    await inbound(conversation.id, "bonjour");
    await runTurn(conversation.id);

    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.categoryId).toBe(before.categoryId);
    expect(await testDb.select().from(auditLogs)).toHaveLength(0);

    // Le modèle a reçu la liste des clés permises, pas un « erreur » sec.
    const toolMessage = llm.calls
      .flatMap((c) => (c.messages ?? []) as { role: string; content: string }[])
      .find((m) => m.role === "tool" && m.content.includes("set_category"));
    expect(toolMessage?.content).toContain("long_term");
    expect(toolMessage?.content).toContain("not_qualified");
  });

  it("sans AUCUNE règle configurée, l'assistant ne classe rien", async () => {
    await seedSystemCategories();
    const { conversation, client } = await scene();
    const before = (await testDb.select().from(clients).where(eq(clients.id, client.id)))[0];
    llm.generatorToolCalls = [
      {
        id: "t1",
        name: "set_category",
        arguments: { categoryKey: "long_term", reason: "peu importe" },
      },
    ];
    await inbound(conversation.id, "bonjour");
    await runTurn(conversation.id);

    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.categoryId).toBe(before.categoryId);
  });

  it("reclasser au MÊME endroit ne réécrit rien", async () => {
    // Sinon chaque tour relancerait les campagnes « changement de catégorie ».
    const { longTerm } = await withRules();
    const { conversation, client } = await scene();
    await testDb.update(clients).set({ categoryId: longTerm.id }).where(eq(clients.id, client.id));

    llm.generatorToolCalls = [
      {
        id: "t1",
        name: "set_category",
        arguments: { categoryKey: "long_term", reason: "encore" },
      },
    ];
    await inbound(conversation.id, "toujours l'an prochain");
    await runTurn(conversation.id);

    expect(await testDb.select().from(auditLogs)).toHaveLength(0);
  });
});

// ── Réponses encore en file et sortants jamais reçus (revue) ─────────────────

describe("réponses en file et sortants jamais reçus (revue)", () => {
  beforeEach(async () => {
    await resetDb();
    llm.generatorText = "Parfait! Préférez-vous jeudi 14 h ou vendredi 18 h 30?";
    llm.generatorToolCalls = [];
    llm.generatorSequence = [];
    llm.onGenerate = null;
    llm.generatorError = null;
    llm.truncated = false;
    llm.unconfigured = [];
    llm.classifierJson = '{"refusal":"none","qualification":{}}';
    llm.judgeJson = '{"passed":true,"reason":"conforme"}';
    llm.calls = [];
  });
  afterEach(() => vi.clearAllMocks());

  it("une réponse ENCORE EN FILE est lue par le tour suivant — historique et budget", async () => {
    // R1 n'existe dans `messages` qu'au moment où son job `send_sms` s'exécute
    // (30-90 s plus tard). Sans relecture des envois vivants, un deuxième
    // entrant obtenait un tour aveugle : le modèle se réintroduisait et la
    // personne recevait deux réponses indépendantes.
    const { conversation } = await scene();
    await inbound(conversation.id, "Allo?");
    expect((await runTurn(conversation.id)).outcome).toBe("sent");

    // R1 attend son envoi : job en file, AUCUNE rangée sortante encore.
    const sends = (await jobsFor(conversation.id)).filter((j) => j.type === "send_sms");
    expect(sends).toHaveLength(1);
    expect(await testDb.select().from(messages).where(eq(messages.direction, "out"))).toHaveLength(0);

    // Deuxième entrant AVANT que R1 ne parte.
    await inbound(conversation.id, "C'est pour vendre ma maison");
    llm.calls = [];
    expect((await runTurn(conversation.id)).outcome).toBe("sent");

    // Le générateur du tour 2 a lu R1 comme un message de l'assistant, à sa
    // place chronologique : après « Allo? », avant le deuxième entrant.
    const r1 = "Parfait! Préférez-vous jeudi 14 h ou vendredi 18 h 30?";
    const call = llm.calls.find((c) => c.model === "generator-model");
    const msgs = call!.messages as { role: string; content: string }[];
    const idxM1 = msgs.findIndex((m) => m.role === "user" && m.content === "Allo?");
    const idxR1 = msgs.findIndex((m) => m.role === "assistant" && m.content === r1);
    expect(idxM1).toBeGreaterThanOrEqual(0);
    expect(idxR1).toBeGreaterThan(idxM1);

    // Et le budget la compte : le tour 2 n'est PAS un « premier message ».
    const traces = await testDb.select().from(agentTurnTraces);
    expect(traces.some((t) => (t.runtimeBlock ?? "").includes("Messages utilisés : 1/16"))).toBe(true);
  });

  it("un sortant jamais reçu (sauté, refusé) ne revient ni dans l'historique ni dans le budget", async () => {
    // Depuis la revue, un envoi refusé LAISSE une rangée visible dans le fil
    // (interrupteur, numéro supprimé, rejet Twilio). Le modèle, lui, ne doit
    // pas relire « comme je vous le disais » un message jamais parti.
    const { conversation } = await scene();
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "out",
      body: "Je vous écrivais pendant l'incident.",
      source: "agent",
      aiGenerated: true,
      status: "skipped",
      skipReason: "kill_switch",
    });
    await inbound(conversation.id, "Allo?");
    expect((await runTurn(conversation.id)).outcome).toBe("sent");

    const call = llm.calls.find((c) => c.model === "generator-model");
    const msgs = call!.messages as { role: string; content: string }[];
    expect(msgs.some((m) => m.content.includes("pendant l'incident"))).toBe(false);
    // Budget intact : c'est toujours le PREMIER message de l'assistant.
    const [trace] = await testDb.select().from(agentTurnTraces);
    expect(trace.runtimeBlock).toContain("Messages utilisés : 0/16");
  });

  it("assistant plus actif + entrant : le tour se tait mais PRÉVIENT les humains", async () => {
    // Le webhook a cru que l'IA répondrait (un assistant est épinglé) et n'a
    // prévenu personne. Sans ce relais, le message restait dans l'inbox sans
    // réponse ET sans notification.
    const { conversation, assistant } = await scene();
    await testDb.update(assistants).set({ status: "draft" }).where(eq(assistants.id, assistant.id));
    await inbound(conversation.id, "Allo, on se voit quand?");

    const result = await runTurn(conversation.id);
    expect(result.outcome).toBe("skipped_no_assistant");
    expect(result.reason).toBe("assistant_inactive");

    const notes = await testDb.select().from(notifications);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.type === "sms_inbound")).toBe(true);
    // Rien n'est consommé : le message attend un humain, pas une reprise.
    const [msg] = await testDb.select().from(messages).where(eq(messages.direction, "in"));
    expect(msg.processedAt).toBeNull();
  });

  it("assistant plus actif, tour PROACTIF : silence — personne n'attend de réponse", async () => {
    const { conversation, assistant, enrollment } = await outreachScene();
    await testDb.update(assistants).set({ status: "draft" }).where(eq(assistants.id, assistant.id));

    const result = await runTurn(conversation.id, {
      outreach: { enrollmentId: enrollment.id, step: 0 },
    });
    expect(result.outcome).toBe("skipped_no_assistant");
    expect(await testDb.select().from(notifications)).toHaveLength(0);
  });
});

// ── Outils de LECTURE : la fiche et les notes internes reviennent au modèle ───

/**
 * Un tour où le modèle appelle UN outil de lecture puis rédige. Le compteur
 * vide `generatorToolCalls` après le premier appel (comme les tests d'agenda),
 * pour que l'outil ne soit joué qu'une fois et que le dernier appel générateur
 * porte le résultat en message `tool`.
 */
async function toolMessageAfter(conversationId: string, toolName: string): Promise<string> {
  llm.generatorToolCalls = [{ id: "r1", name: toolName, arguments: {} }];
  llm.generatorSequence = ["", "Merci, c'est noté."];
  let calls = 0;
  llm.onGenerate = async () => {
    calls += 1;
    if (calls >= 2) llm.generatorToolCalls = [];
  };
  await runTurn(conversationId);
  const generatorCalls = llm.calls.filter((c) => c.model === "generator-model");
  const msgs = (generatorCalls[generatorCalls.length - 1]?.messages ?? []) as {
    role: string;
    name?: string;
    content: string;
  }[];
  return msgs.find((m) => m.role === "tool" && m.name === toolName)?.content ?? "";
}

describe("outils de lecture (read_client / read_client_comments)", () => {
  beforeEach(async () => {
    await resetDb();
    llm.generatorText = "Merci, c'est noté.";
    llm.generatorToolCalls = [];
    llm.generatorSequence = [];
    llm.onGenerate = null;
    llm.generatorError = null;
    llm.truncated = false;
    llm.unconfigured = [];
  });

  it("read_client renvoie au modèle ce que la fiche sait déjà (labels de catégorie/source résolus)", async () => {
    const { conversation, client } = await scene();
    const category = await makeCategory({ nameFr: "À rappeler", nameEn: "Callback" });
    const source = await makeSource({ name: "Facebook" });
    await testDb
      .update(clients)
      .set({
        city: "Lévis",
        projectType: "achat",
        timing: "6 mois",
        notes: "Client VIP",
        categoryId: category.id,
        sourceId: source.id,
      })
      .where(eq(clients.id, client.id));
    await inbound(conversation.id, "Bonjour");

    const content = await toolMessageAfter(conversation.id, "read_client");
    expect(content).toContain("Marie Tremblay");
    expect(content).toContain("Lévis");
    expect(content).toContain("achat");
    expect(content).toContain("6 mois");
    expect(content).toContain("À rappeler"); // libellé, pas l'id
    expect(content).toContain("Facebook");
    expect(content).toContain("Client VIP");
  });

  it("read_client_comments renvoie les notes internes récentes d'abord, mentions réduites au nom", async () => {
    const { conversation, client } = await scene();
    const author = await makeUser({ name: "Alex Honoré", email: `a-${Math.random().toString(16).slice(2)}@x.test` });
    const other = await makeUser({ name: "Marie Agent", email: `m-${Math.random().toString(16).slice(2)}@x.test` });
    await testDb.insert(comments).values([
      {
        clientId: client.id,
        userId: author.id,
        body: "A déjà un courtier mais reste ouvert.",
        createdAt: new Date("2026-08-05T12:00:00Z"),
      },
      {
        clientId: client.id,
        userId: author.id,
        body: `Sérieux — à confirmer avec @[Marie Agent](${other.id}) demain.`,
        createdAt: new Date("2026-08-12T15:00:00Z"),
      },
    ]);
    await inbound(conversation.id, "Bonjour");

    const content = await toolMessageAfter(conversation.id, "read_client_comments");
    expect(content).toContain("2 note(s) interne(s)");
    expect(content).toContain("Alex Honoré");
    // Récente d'abord : la note du 12 précède celle du 5.
    expect(content.indexOf("Sérieux")).toBeLessThan(content.indexOf("A déjà un courtier"));
    // La mention @[Marie Agent](id) est réduite au nom, l'id ne fuit pas.
    expect(content).toContain("Marie Agent");
    expect(content).not.toContain(other.id);
    expect(content).not.toContain("@[");
  });

  it("read_client_comments sur une fiche sans note : le dit franchement", async () => {
    const { conversation } = await scene();
    await inbound(conversation.id, "Bonjour");
    const content = await toolMessageAfter(conversation.id, "read_client_comments");
    expect(content).toContain("aucune note interne");
  });

  it("read_client ne lit QUE la fiche de la conversation (aucun id fourni par le modèle)", async () => {
    const { conversation, client } = await scene();
    // Une AUTRE fiche, avec un secret : elle ne doit jamais apparaître.
    await makeClient({ fullName: "Autre Personne", phone: "+15145550199", notes: "SECRET-VOISIN" });
    await inbound(conversation.id, "Bonjour");
    const content = await toolMessageAfter(conversation.id, "read_client");
    expect(content).toContain("Marie Tremblay");
    expect(content).not.toContain("SECRET-VOISIN");
    expect(content).not.toContain("Autre Personne");
    void client;
  });
});
