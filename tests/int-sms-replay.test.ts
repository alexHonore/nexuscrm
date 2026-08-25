/**
 * Intégration — rejeu des tours tombés en panne de modèle.
 *
 * Après l'incident du 2026-08-25 (crédits OpenRouter épuisés), les fils
 * `llm_error` étaient RÉGLÉS pour la file : entrants consommés, jobs en échec
 * définitif. Recharger les crédits ne relançait rien — chaque contact restait
 * sans réponse jusqu'à son prochain message. Ce rejeu est l'outil de reprise.
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
  campaigns,
  conversations,
  messages,
  scheduledJobs,
} from "@/db/schema-sms";
import { auditLogs } from "@/db/schema";

const ctx = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = ctx.cookies.get(name);
      return v === undefined ? undefined : { name, value: v };
    },
    set: (name: string, value: string) => ctx.cookies.set(name, value),
    delete: (name: string) => ctx.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));

const route = await import("@/app/api/admin/sms/replay-llm-errors/route");

async function loginAs(user: { id: string; tokenVersion: number }, role: "admin" | "caller") {
  const token = await new SignJWT({ uid: user.id, role, tv: user.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set("nexus_session", token);
}

/** Un fil marqué « panne de modèle », l'IA encore active. */
async function stuckThread() {
  const [assistant] = await testDb
    .insert(assistants)
    .values({ name: "Réactivation (test)", identity: {}, goal: {}, approach: {}, model: {} })
    .returning();
  const client = await makeClient({ phone: `+1418555${Math.floor(1000 + Math.random() * 8999)}` });
  const number = await makeSmsNumber();
  const conversation = await makeConversation({
    clientId: client.id,
    smsNumberId: number.id,
    clientPhone: client.phone,
    activeAssistantId: assistant.id,
    aiEnabled: true,
    needsAttention: true,
    attentionReason: "llm_error",
  });
  return { assistant, client, conversation };
}

const jobsFor = async (conversationId: string) =>
  (await testDb.select().from(scheduledJobs)).filter(
    (j) => (j.payload as { conversationId?: string }).conversationId === conversationId,
  );

beforeEach(async () => {
  await resetDb();
  ctx.cookies.clear();
  await loginAs(await makeUser({ role: "admin" }), "admin");
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/admin/sms/replay-llm-errors", () => {
  it("fil de réponse : rouvre les entrants consommés et remet un tour en file", async () => {
    const { conversation } = await stuckThread();
    // L'entrant a été CONSOMMÉ par la dernière tentative en panne.
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "in",
      body: "Oui toujours intéressé",
      source: "human",
      status: "received",
      processedAt: new Date(),
    });

    const res = await route.POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stuck: 1, replayedInbound: 1 });

    // L'entrant est de nouveau À TRAITER, un tour attend sous la clé du webhook.
    const [inbound] = await testDb
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, "in")));
    expect(inbound.processedAt).toBeNull();
    const jobs = await jobsFor(conversation.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("agent_turn");
    expect(jobs[0].status).toBe("pending");
    expect(jobs[0].dedupeKey).toBe(`turn:${conversation.id}`);

    // La pastille tombe — le tour rejoué la remettra s'il échoue encore.
    const conv = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(conv!.needsAttention).toBe(false);

    // Et l'action est auditée.
    const logs = await testDb.select().from(auditLogs);
    expect(logs.some((l) => l.action === "sms.replay_llm_errors")).toBe(true);
  });

  it("un humain a déjà répondu : rien à rouvrir, la pastille tombe simplement", async () => {
    const { conversation } = await stuckThread();
    const before = new Date(Date.now() - 60_000);
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "in",
      body: "Allo?",
      source: "human",
      status: "received",
      processedAt: before,
      createdAt: before,
    });
    // La réponse manuelle du téléphoniste, APRÈS l'entrant.
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "out",
      body: "Bonjour, je vous rappelle!",
      source: "human",
      status: "sent",
    });

    const res = await route.POST();
    expect(await res.json()).toMatchObject({ stuck: 1, replayedInbound: 0, cleared: 1 });
    expect(await jobsFor(conversation.id)).toHaveLength(0);
    const [inbound] = await testDb
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, "in")));
    expect(inbound.processedAt).not.toBeNull();
  });

  it("ouverture de campagne en échec : le MÊME tour proactif repart", async () => {
    const { assistant, client, conversation } = await stuckThread();
    const [campaign] = await testDb
      .insert(campaigns)
      .values({
        name: "Réactivation 90 j",
        status: "active",
        trigger: { kind: "manual" },
        ladder: [{ delayHours: 0, body: null, label: "ouverture" }],
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
        step: 1,
        lastTouchAt: new Date(),
      })
      .returning();
    // Le job d'ouverture, mort en échec définitif pendant la panne.
    await testDb.insert(scheduledJobs).values({
      type: "agent_turn",
      status: "failed",
      runAt: new Date(),
      payload: { conversationId: conversation.id, outreach: { enrollmentId: enrollment.id, step: 0 } },
      dedupeKey: `outreach:${enrollment.id}:0`,
      lastError: "llm_http_402",
    });

    const res = await route.POST();
    expect(await res.json()).toMatchObject({ stuck: 1, replayedOutreach: 1 });

    const pending = (await jobsFor(conversation.id)).filter((j) => j.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].payload).toMatchObject({
      outreach: { enrollmentId: enrollment.id, step: 0 },
    });
  });

  it("« n'a rien écrit » (no_text) se rejoue aussi — l'erreur d'amont maquillée en 200", async () => {
    const { assistant, client, conversation } = await stuckThread();
    await testDb
      .update(conversations)
      .set({ attentionReason: "no_text" })
      .where(eq(conversations.id, conversation.id));
    const [campaign] = await testDb
      .insert(campaigns)
      .values({
        name: "Réactivation 90 j",
        status: "active",
        trigger: { kind: "manual" },
        ladder: [{ delayHours: 0, body: null, label: "ouverture" }],
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
        step: 1,
      })
      .returning();
    await testDb.insert(scheduledJobs).values({
      type: "agent_turn",
      status: "failed",
      runAt: new Date(),
      payload: { conversationId: conversation.id, outreach: { enrollmentId: enrollment.id, step: 0 } },
      lastError: "llm_http_402",
    });

    const res = await route.POST();
    expect(await res.json()).toMatchObject({ stuck: 1, replayedOutreach: 1 });
  });

  it("une inscription STOPPÉE entre-temps n'est jamais rejouée", async () => {
    const { assistant, client, conversation } = await stuckThread();
    const [campaign] = await testDb
      .insert(campaigns)
      .values({
        name: "Réactivation 90 j",
        status: "active",
        trigger: { kind: "manual" },
        ladder: [{ delayHours: 0, body: null, label: "ouverture" }],
        assistantId: assistant.id,
      })
      .returning();
    const [enrollment] = await testDb
      .insert(campaignEnrollments)
      .values({
        campaignId: campaign.id,
        clientId: client.id,
        conversationId: conversation.id,
        status: "stopped",
        endReason: "opted_out",
        step: 1,
      })
      .returning();
    await testDb.insert(scheduledJobs).values({
      type: "agent_turn",
      status: "failed",
      runAt: new Date(),
      payload: { conversationId: conversation.id, outreach: { enrollmentId: enrollment.id, step: 0 } },
      lastError: "llm_http_402",
    });

    const res = await route.POST();
    expect(await res.json()).toMatchObject({ stuck: 1, replayedOutreach: 0, cleared: 1 });
    expect((await jobsFor(conversation.id)).filter((j) => j.status === "pending")).toHaveLength(0);
  });

  it("entrant ORPHELIN (jamais consommé, aucun job vivant) : le tour du webhook repart", async () => {
    // Le job du webhook est mort en échec définitif AVANT la tentative finale :
    // l'entrant n'a jamais été consommé, la pastille dit « nouveau message »,
    // et plus rien ne viendrait jamais.
    const { conversation } = await stuckThread();
    await testDb
      .update(conversations)
      .set({ attentionReason: "inbound" })
      .where(eq(conversations.id, conversation.id));
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "in",
      body: "Pas pour tout de suite malheureusement !",
      source: "human",
      status: "received",
    });

    const res = await route.POST();
    expect(await res.json()).toMatchObject({ stuck: 0, replayedOrphans: 1 });
    const jobs = await jobsFor(conversation.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupeKey).toBe(`turn:${conversation.id}`);

    // Idempotent : un second passage est absorbé par la clé du job vivant.
    const again = await (await route.POST()).json();
    expect(again).toMatchObject({ replayedOrphans: 0 });
    expect(await jobsFor(conversation.id)).toHaveLength(1);
  });

  it("ne touche pas aux autres pastilles (refus ferme, passage humain)", async () => {
    const { conversation } = await stuckThread();
    await testDb
      .update(conversations)
      .set({ aiEnabled: false, attentionReason: "hard_refusal" })
      .where(eq(conversations.id, conversation.id));

    const res = await route.POST();
    expect(await res.json()).toMatchObject({ stuck: 0 });
    const conv = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, conversation.id),
    });
    expect(conv!.needsAttention).toBe(true);
    expect(conv!.attentionReason).toBe("hard_refusal");
  });

  it("RBAC : un téléphoniste est refusé", async () => {
    ctx.cookies.clear();
    await loginAs(await makeUser({ role: "caller", email: "caller@x.test" }), "caller");
    const res = await route.POST();
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);
  });
});
