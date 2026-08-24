/**
 * Intégration — correctifs de revue, moteur d'agent et campagnes (lot G).
 *
 *  · Un barreau « l'assistant rédige » dont l'assistant n'est plus actif est
 *    RETENU (comme un numéro manquant), jamais consommé en silence : avant,
 *    l'échelle avançait barreau après barreau jusqu'à « épuisée » sans qu'un
 *    seul SMS ne parte, et rien ne le disait.
 *  · L'interrupteur d'arrêt annule les envois en file en laissant la MÊME
 *    empreinte que la porte d'envoi : rangée « non envoyé — interrupteur »
 *    dans le fil, fil d'agent remis « à traiter », barreau « cancelled ».
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  makeUser,
  resetDb,
  testDb,
} from "./helpers/db";
import {
  assistants,
  campaignEnrollments,
  promptCores,
  campaignTouches,
  campaigns,
  conversations,
  messages,
  scheduledJobs,
} from "@/db/schema-sms";
import { assistantConfigSchema } from "@/lib/assistants/schema";

// ── Stubs d'environnement Next ───────────────────────────────────────────────
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "24.48.1.1" }),
}));

const { runTouch } = await import("@/lib/campaigns-server/touch");
const { POST: killSwitchPost } = await import("@/app/api/kill-switch/route");

// Vendredi 11 h (Toronto) : dans la fenêtre d'envoi, loin des heures de
// politesse — le test ne dépend pas de l'heure à laquelle il tourne.
const NOW = new Date("2026-08-21T15:00:00.000Z");

/** Un assistant tel qu'inséré par l'éditeur — SANS passer le compilateur. */
async function makeAssistant(overrides: Partial<typeof assistants.$inferInsert> = {}) {
  const config = assistantConfigSchema.parse({
    name: "Relance (test)",
    identity: {},
    approach: { maxTurns: 16, replySpeed: "instant" },
    model: {
      provider: "openrouter",
      model: "generator-model",
      classifier: { provider: "openrouter", model: "classifier-model" },
    },
    goal: { primary: { type: "phone_call", durationMin: 15, requiredFields: [] } },
  });
  const [row] = await testDb
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
      // Un assistant ACTIF doit satisfaire la porte d'activation (trigger
      // assistants_activation_gate) : prompt compilé non vide, version de
      // noyau à jour, pas de recompilation en attente, suite passée.
      ...(( overrides.status ?? "active") === "active"
        ? {
            status: "active" as const,
            compiledPrompt: "PROMPT COMPILÉ (test)",
            compiledCoreVersion: 1,
            compiledAt: new Date(),
            needsRecompile: false,
            suitePassed: true,
          }
        : {}),
      ...overrides,
    })
    .returning();
  return row;
}

/** Une campagne active dont le barreau 0 est rédigé par l'assistant (ou dicté). */
async function makeCampaign(input: {
  assistantId: string | null;
  smsNumberId: string;
  body?: string | null;
}) {
  const [row] = await testDb
    .insert(campaigns)
    .values({
      name: "Réactivation (test)",
      status: "active",
      assistantId: input.assistantId,
      smsNumberId: input.smsNumberId,
      trigger: { kind: "manual" },
      ladder: [{ delayHours: 0, body: input.body ?? null, label: "ouverture" }],
    })
    .returning();
  return row;
}

async function makeEnrollment(campaignId: string, clientId: string) {
  const [row] = await testDb
    .insert(campaignEnrollments)
    .values({ campaignId, clientId, status: "active", step: 0, enrolledAt: NOW })
    .returning();
  return row;
}

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);

async function loginAsAdmin() {
  const admin = await makeUser({ role: "admin" });
  const token = await new SignJWT({ uid: admin.id, role: "admin", tv: admin.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
  jar.set("nexus_session", token);
  return admin;
}

// ── Barreau « l'assistant rédige » quand l'assistant n'est plus actif ────────

afterAll(closeDb);

describe("runTouch — barreau confié à un assistant inactif", () => {
  beforeEach(async () => {
    await resetDb();
    await testDb.insert(promptCores).values({ version: 1, body: "# RÔLE" }).onConflictDoNothing();
    jar.clear();
  });

  it("assistant en brouillon : le barreau est RETENU, l'échelle n'avance pas", async () => {
    // Le scénario du bogue : campagne active liée à l'assistant A, l'admin
    // clique « Désactiver » sur A pour le retoucher. Chaque barreau dû était
    // écrit « queued », le tour se terminait « pas d'assistant », et
    // l'inscription avançait quand même — jusqu'à « échelle épuisée », sans un
    // SMS ni une alerte.
    const assistant = await makeAssistant({ status: "draft" });
    const number = await makeSmsNumber();
    const client = await makeClient();
    const campaign = await makeCampaign({ assistantId: assistant.id, smsNumberId: number.id });
    const enrollment = await makeEnrollment(campaign.id, client.id);

    const result = await runTouch(enrollment.id, NOW);
    expect(result.sent).toBe(false);
    expect(result.refusal).toBe("assistant_inactive");

    // Rien n'est consommé : ni trace de barreau, ni job, ni avancement.
    expect(await testDb.select().from(campaignTouches)).toHaveLength(0);
    expect(await testDb.select().from(scheduledJobs)).toHaveLength(0);
    const row = await testDb.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.id, enrollment.id),
    });
    expect(row!.step).toBe(0);
    expect(row!.status).toBe("active");
    // Repoussé comme un « pas maintenant » : il repartira à la réactivation.
    expect(row!.nextTouchAt).toEqual(new Date(NOW.getTime() + 60 * 60 * 1000));
  });

  it("assistant non compilé : même retenue", async () => {
    // État réel atteignable : un assistant ACTIF que l'admin retouche —
    // la porte d'activation interdit d'INSÉRER un actif sans prompt, mais un
    // actif déjà en place peut voir son prompt effacé (needs_recompile).
    const assistant = await makeAssistant({ status: "active" });
    await testDb
      .update(assistants)
      .set({ compiledPrompt: null, needsRecompile: true })
      .where(eq(assistants.id, assistant.id));
    const number = await makeSmsNumber();
    const client = await makeClient();
    const campaign = await makeCampaign({ assistantId: assistant.id, smsNumberId: number.id });
    const enrollment = await makeEnrollment(campaign.id, client.id);

    const result = await runTouch(enrollment.id, NOW);
    expect(result.sent).toBe(false);
    expect(result.refusal).toBe("assistant_inactive");
    expect(await testDb.select().from(campaignTouches)).toHaveLength(0);
  });

  it("à la réactivation, le barreau retenu repart", async () => {
    const assistant = await makeAssistant({ status: "draft" });
    const number = await makeSmsNumber();
    const client = await makeClient();
    const campaign = await makeCampaign({ assistantId: assistant.id, smsNumberId: number.id });
    const enrollment = await makeEnrollment(campaign.id, client.id);

    expect((await runTouch(enrollment.id, NOW)).refusal).toBe("assistant_inactive");
    // Réactivation = l'admin recompile puis active : la porte d'activation
    // exige un prompt compilé à jour, comme en production.
    await testDb
      .update(assistants)
      .set({
        status: "active",
        compiledPrompt: "PROMPT COMPILÉ (test)",
        compiledCoreVersion: 1,
        compiledAt: new Date(),
        needsRecompile: false,
        suitePassed: true,
      })
      .where(eq(assistants.id, assistant.id));

    const retry = new Date(NOW.getTime() + 61 * 60 * 1000);
    const result = await runTouch(enrollment.id, retry);
    expect(result.sent).toBe(true);

    // Le tour d'agent est réveillé avec le contexte du barreau, et la trace
    // « queued » attend son verdict.
    const [job] = await testDb.select().from(scheduledJobs);
    expect(job.type).toBe("agent_turn");
    expect(job.payload).toMatchObject({ outreach: { enrollmentId: enrollment.id, step: 0 } });
    const [touch] = await testDb.select().from(campaignTouches);
    expect(touch.status).toBe("queued");
  });

  it("un barreau au texte DICTÉ part même si l'assistant est en brouillon", async () => {
    // Le texte n'a pas besoin de l'assistant : la retenue ne vaut que pour un
    // barreau qu'il devrait rédiger.
    const assistant = await makeAssistant({ status: "draft" });
    const number = await makeSmsNumber();
    const client = await makeClient();
    const campaign = await makeCampaign({
      assistantId: assistant.id,
      smsNumberId: number.id,
      body: "Bonjour, ici Groupe Nexus. Toujours un projet?",
    });
    const enrollment = await makeEnrollment(campaign.id, client.id);

    const result = await runTouch(enrollment.id, NOW);
    expect(result.sent).toBe(true);
    const [job] = await testDb.select().from(scheduledJobs);
    expect(job.type).toBe("send_sms");
    const [touch] = await testDb.select().from(campaignTouches);
    expect(touch.status).toBe("sent");
  });
});

// ── Interrupteur d'arrêt : annulation RÉCONCILIÉE ────────────────────────────

describe("POST /api/kill-switch — l'annulation laisse l'empreinte de la porte d'envoi", () => {
  beforeEach(async () => {
    await resetDb();
    await testDb.insert(promptCores).values({ version: 1, body: "# RÔLE" }).onConflictDoNothing();
    jar.clear();
  });

  it("réponse d'agent coupée : rangée « non envoyé », fil remis à traiter ; barreau tracé « cancelled »", async () => {
    await loginAsAdmin();
    const number = await makeSmsNumber();

    // Fil A : une réponse d'agent attend son délai humanisé. Le tour a déjà
    // consommé l'entrant et éteint la pastille.
    const clientA = await makeClient();
    const convA = await makeConversation({
      clientId: clientA.id,
      smsNumberId: number.id,
      clientPhone: clientA.phone,
      needsAttention: false,
    });
    const [agentJob] = await testDb
      .insert(scheduledJobs)
      .values({
        type: "send_sms",
        runAt: new Date(Date.now() + 30_000),
        payload: {
          conversationId: convA.id,
          to: clientA.phone,
          body: "Parfait, je vous propose jeudi 14 h!",
          source: "agent",
          automated: true,
          aiGenerated: true,
          sentById: null,
        },
      })
      .returning();

    // Fil B : un barreau dicté vient d'être tracé « envoyé », son job attend
    // le prochain cycle du dispatcher.
    const clientB = await makeClient();
    const convB = await makeConversation({
      clientId: clientB.id,
      smsNumberId: number.id,
      clientPhone: clientB.phone,
      needsAttention: false,
    });
    const campaign = await makeCampaign({
      assistantId: null,
      smsNumberId: number.id,
      body: "Bonjour, ici Groupe Nexus.",
    });
    const enrollment = await makeEnrollment(campaign.id, clientB.id);
    await testDb.insert(campaignTouches).values({
      enrollmentId: enrollment.id,
      step: 0,
      plannedAt: NOW,
      sentAt: NOW,
      status: "sent",
    });
    const [ladderJob] = await testDb
      .insert(scheduledJobs)
      .values({
        type: "send_sms",
        runAt: new Date(),
        dedupeKey: `csend:${enrollment.id}:0`,
        payload: {
          conversationId: convB.id,
          to: clientB.phone,
          body: "Bonjour, ici Groupe Nexus.",
          source: "ladder",
          automated: true,
          aiGenerated: false,
          sentById: null,
        },
      })
      .returning();

    // Un job à la charge illisible : annulé quand même, rien à réconcilier.
    const [operaJob] = await testDb
      .insert(scheduledJobs)
      .values({ type: "send_sms", runAt: new Date(), payload: {} })
      .returning();

    const res = await killSwitchPost(
      new Request("http://localhost/api/kill-switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, reason: "incident" }),
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, enabled: true, cancelledJobs: 3 });

    // Les trois jobs sont annulés.
    for (const id of [agentJob.id, ladderJob.id, operaJob.id]) {
      const [job] = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.id, id));
      expect(job.status).toBe("cancelled");
    }

    // La MÊME empreinte que la porte d'envoi : une rangée « non envoyé —
    // interrupteur » dans chaque fil, rattachée à son job.
    const rowsA = await testDb.select().from(messages).where(eq(messages.conversationId, convA.id));
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({
      direction: "out",
      status: "skipped",
      skipReason: "kill_switch",
      jobId: agentJob.id,
      source: "agent",
      aiGenerated: true,
      body: "Parfait, je vous propose jeudi 14 h!",
    });
    const rowsB = await testDb.select().from(messages).where(eq(messages.conversationId, convB.id));
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({ status: "skipped", skipReason: "kill_switch", source: "ladder" });
    // La charge illisible n'a laissé aucune rangée orpheline.
    expect(await testDb.select().from(messages)).toHaveLength(2);

    // Une réponse d'AGENT coupée remet le fil « à traiter » : la personne
    // attend une réponse qui ne viendra pas. Un barreau d'ouverture, non.
    const a = await testDb.query.conversations.findFirst({ where: eq(conversations.id, convA.id) });
    expect(a!.needsAttention).toBe(true);
    expect(a!.attentionReason).toBe("send_failed");
    const b = await testDb.query.conversations.findFirst({ where: eq(conversations.id, convB.id) });
    expect(b!.needsAttention).toBe(false);

    // La trace du barreau ne ment plus : « cancelled », pas « envoyé ».
    const [touch] = await testDb
      .select()
      .from(campaignTouches)
      .where(and(eq(campaignTouches.enrollmentId, enrollment.id), eq(campaignTouches.step, 0)));
    expect(touch.status).toBe("cancelled");
  });

  it("rejouer l'activation ne crée pas de deuxième rangée pour le même job", async () => {
    // `messages.job_id` est unique : si une rangée existe déjà pour ce job
    // (course avec le dispatcher), la réconciliation n'en ajoute pas une autre.
    await loginAsAdmin();
    const number = await makeSmsNumber();
    const client = await makeClient();
    const conv = await makeConversation({
      clientId: client.id,
      smsNumberId: number.id,
      clientPhone: client.phone,
    });
    const [job] = await testDb
      .insert(scheduledJobs)
      .values({
        type: "send_sms",
        runAt: new Date(),
        payload: {
          conversationId: conv.id,
          to: client.phone,
          body: "Déjà matérialisé.",
          source: "agent",
          automated: true,
          aiGenerated: true,
          sentById: null,
        },
      })
      .returning();
    await testDb.insert(messages).values({
      conversationId: conv.id,
      direction: "out",
      body: "Déjà matérialisé.",
      jobId: job.id,
      status: "sending",
      source: "agent",
      aiGenerated: true,
    });

    const res = await killSwitchPost(
      new Request("http://localhost/api/kill-switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(res.status).toBe(200);

    const rows = await testDb.select().from(messages).where(eq(messages.conversationId, conv.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sending");
  });
});
