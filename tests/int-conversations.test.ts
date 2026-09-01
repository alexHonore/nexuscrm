/**
 * Intégration — actions du fil SMS.
 *
 * Deux garanties que l'écran ne montre pas :
 *  · Un TÉLÉPHONISTE peut reprendre la main, écrire et marquer traité. C'est le
 *    point de la phase : le contrôle depuis un cellulaire, en pleine journée
 *    d'appels.
 *  · Un envoi manuel n'est PAS un envoi d'agent — il traverse la pause IA et
 *    les heures de politesse, parce qu'un humain assume ce choix.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
import { assistants, consents, conversations, messages, promptCores, scheduledJobs, smsNumbers, suppressions } from "@/db/schema-sms";
import { auditLogs, clients } from "@/db/schema";

const ctx = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = ctx.cookies.get(name);
      return v ? { name, value: v } : undefined;
    },
    set: (name: string, value: string) => ctx.cookies.set(name, value),
    delete: (name: string) => ctx.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));

const {
  cancelOutboundSmsAction,
  cancelQueuedSmsAction,
  assignAssistantAction,
  closeConversationAction,
  closeHeldConversationsAction,
  sendManualSmsAction,
  setConversationAiAction,
  markConversationHandledAction,
  assignConversationAction,
  retryAiTurnAction,
  dismissAllFailedJobsAction,
  dismissFailedJobAction,
  liftSuppressionAction,
  retryFailedSmsAction,
  dismissFailedSmsAction,
} = await import("@/app/(app)/conversations/actions");
const { setUserRole } = await import("@/lib/permissions/server");
const { CALLER_ROLE_ID, OBSERVER_ROLE_ID, defaultPermissionsConfig } = await import(
  "@/lib/permissions/defaults"
);
const { setSetting } = await import("@/lib/settings");
const { processInboundSms } = await import("@/lib/sms-server/inbound");
const { seedGuardrailDefaults } = await import("@/lib/guardrails/store");

/** Consentement SMS exprès au dossier — sans lui, un envoi à la main est refusé. */
async function grantConsent(clientId: string) {
  await testDb.insert(consents).values({
    clientId,
    channel: "sms",
    kind: "express",
    source: "manual:test",
    evidence: {},
  });
}

async function loginAs(user: { id: string; role: string; tokenVersion: number } | null) {
  ctx.cookies.clear();
  if (!user) return;
  const token = await new SignJWT({
    uid: user.id,
    role: user.role,
    tv: user.tokenVersion,
    remember: false,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set("nexus_session", token);
}

let caller: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;
let numberId: string;
let numberE164: string;

beforeEach(async () => {
  await resetDb();
  caller = await makeUser({ role: "caller", name: "Téléphoniste" });
  admin = await makeUser({ role: "admin", name: "Admin" });
  const number = await makeSmsNumber();
  numberId = number.id;
  numberE164 = number.e164;
  await loginAs(caller);
});

afterAll(async () => {
  await closeDb();
});

describe("envoi manuel", () => {
  it("un TÉLÉPHONISTE peut écrire — et le fil est créé au besoin", async () => {
    const client = await makeClient();
    await grantConsent(client.id);

    const result = await sendManualSmsAction({ clientId: client.id, body: "Bonjour, ici Alex." });
    expect(result.ok).toBe(true);

    const [thread] = await testDb.select().from(conversations);
    expect(thread.clientId).toBe(client.id);

    const [job] = await testDb.select().from(scheduledJobs);
    const payload = job.payload as { source: string; automated: boolean; sentById: string };
    expect(payload.source).toBe("human");
    // `automated: false` : cet envoi traverse la pause IA ET les heures de
    // politesse — un humain qui écrit à 21 h assume son choix.
    expect(payload.automated).toBe(false);
    expect(payload.sentById).toBe(caller.id);
  });

  it("écrire vaut prise en charge : le fil sort de « à traiter »", async () => {
    const client = await makeClient();
    await grantConsent(client.id);
    await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      needsAttention: true,
      attentionReason: "inbound",
    });

    await sendManualSmsAction({ clientId: client.id, body: "Je m'en occupe." });

    const [thread] = await testDb.select().from(conversations);
    expect(thread.needsAttention).toBe(false);
    expect(thread.attentionReason).toBeNull();
  });

  it("un numéro désabonné est refusé AVANT la mise en file", async () => {
    const client = await makeClient();
    await testDb.insert(suppressions).values({ phoneE164: client.phone, reason: "sms_stop" });

    const result = await sendManualSmsAction({ clientId: client.id, body: "Allô?" });
    expect(result).toEqual({ ok: false, error: "suppressed" });
    // Rien en file : mettre en file un message qui sera jeté plus loin le rend
    // invisible à celui qui l'a écrit.
    expect(await testDb.select().from(scheduledJobs)).toHaveLength(0);
  });

  it("sans numéro SMS actif, le refus est explicite", async () => {
    await testDb.update(smsNumbers).set({ active: false });
    const client = await makeClient();
    const result = await sendManualSmsAction({ clientId: client.id, body: "Allô?" });
    expect(result).toEqual({ ok: false, error: "noNumber" });
  });

  it("un message vide est refusé", async () => {
    const client = await makeClient();
    expect(await sendManualSmsAction({ clientId: client.id, body: "   " })).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("sans session, rien ne part", async () => {
    await loginAs(null);
    const client = await makeClient();
    expect(await sendManualSmsAction({ clientId: client.id, body: "Allô" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await testDb.select().from(scheduledJobs)).toHaveLength(0);
  });

  it("écrire dans un fil en PAUSE fonctionne : c'est justement le but", async () => {
    const client = await makeClient();
    await grantConsent(client.id);
    await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      aiEnabled: false,
    });

    const result = await sendManualSmsAction({ clientId: client.id, body: "Je prends la suite." });
    expect(result.ok).toBe(true);
    const [job] = await testDb.select().from(scheduledJobs);
    expect((job.payload as { automated: boolean }).automated).toBe(false);
  });
});

describe("prise de contrôle", () => {
  it("un TÉLÉPHONISTE peut couper l'IA, et on sait qui et pourquoi", async () => {
    const client = await makeClient();
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
    });

    const result = await setConversationAiAction({
      conversationId: thread.id,
      enabled: false,
      reason: "le client a une question légale",
    });
    expect(result.ok).toBe(true);

    const row = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, thread.id),
    });
    expect(row!.aiEnabled).toBe(false);
    // Six semaines plus tard, « pourquoi ce fil ne répond-il plus? » doit avoir
    // une réponse dans la donnée.
    expect(row!.pausedById).toBe(caller.id);
    expect(row!.pauseReason).toBe("le client a une question légale");
    expect(row!.pausedAt).not.toBeNull();
  });

  it("rendre la main efface la trace de pause", async () => {
    const client = await makeClient();
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      aiEnabled: false,
      pausedById: caller.id,
      pausedAt: new Date(),
      pauseReason: "manual",
    });

    await setConversationAiAction({ conversationId: thread.id, enabled: true });

    const row = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, thread.id),
    });
    expect(row!.aiEnabled).toBe(true);
    expect(row!.pausedById).toBeNull();
    expect(row!.pausedAt).toBeNull();
    expect(row!.pauseReason).toBeNull();
  });

  it("sans session, on ne touche à rien", async () => {
    const client = await makeClient();
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
    });
    await loginAs(null);

    expect(await setConversationAiAction({ conversationId: thread.id, enabled: false })).toEqual({
      ok: false,
      error: "forbidden",
    });
    const row = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, thread.id),
    });
    expect(row!.aiEnabled).toBe(true);
  });
});

describe("prise en charge et assignation", () => {
  it("marquer traité retire la pastille", async () => {
    const client = await makeClient();
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      needsAttention: true,
      attentionReason: "handoff",
    });

    expect((await markConversationHandledAction(thread.id)).ok).toBe(true);
    const row = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, thread.id),
    });
    expect(row!.needsAttention).toBe(false);
  });

  it("un téléphoniste peut se l'attribuer, PAS l'attribuer à autrui", async () => {
    const client = await makeClient();
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
    });

    expect((await assignConversationAction({ conversationId: thread.id, userId: caller.id })).ok).toBe(
      true,
    );
    // Même règle que les fiches clients : distribuer le travail d'autrui est
    // un geste d'administrateur.
    expect(await assignConversationAction({ conversationId: thread.id, userId: admin.id })).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("un admin peut attribuer à n'importe qui", async () => {
    await loginAs(admin);
    const client = await makeClient();
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
    });

    expect((await assignConversationAction({ conversationId: thread.id, userId: caller.id })).ok).toBe(
      true,
    );
    const row = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, thread.id),
    });
    expect(row!.assignedToId).toBe(caller.id);
  });

  it("un identifiant inconnu donne « notFound », pas une exception", async () => {
    expect(await markConversationHandledAction("00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      error: "notFound",
    });
  });
});

describe("annulation d'un envoi", () => {
  /** Un message encore EN FILE, avec son job en attente. */
  async function queuedMessage() {
    const client = await makeClient();
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
    });
    const [job] = await testDb
      .insert(scheduledJobs)
      .values({
        type: "send_sms",
        runAt: new Date(Date.now() + 60_000),
        payload: { conversationId: thread.id, to: client.phone, body: "x", source: "human" },
      })
      .returning();
    const [message] = await testDb
      .insert(messages)
      .values({
        conversationId: thread.id,
        direction: "out",
        body: "Message pas encore parti",
        source: "human",
        status: "queued",
        jobId: job.id,
      })
      .returning();
    return { message, job };
  }

  it("un message encore en file est annulé, et son job avec", async () => {
    const { message, job } = await queuedMessage();

    expect((await cancelOutboundSmsAction(message.id)).ok).toBe(true);

    const [msg] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(msg.status).toBe("cancelled");
    // Le job doit être annulé AUSSI : sinon le répartiteur l'exécute et le
    // message part quand même, après qu'on ait dit « annulé ».
    const [row] = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.id, job.id));
    expect(row.status).toBe("cancelled");
  });

  it("un message DÉJÀ remis à l'opérateur est refusé, pas faussement annulé", async () => {
    const { message } = await queuedMessage();
    await testDb
      .update(messages)
      .set({ status: "sent", twilioSid: "SM_deja_parti" })
      .where(eq(messages.id, message.id));

    // Afficher « annulé » sur un message parti serait pire que ne rien
    // offrir : quelqu'un s'y fierait.
    expect(await cancelOutboundSmsAction(message.id)).toEqual({ ok: false, error: "alreadySent" });
    const [msg] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(msg.status).toBe("sent");
  });

  it("un job DÉJÀ réclamé par le répartiteur ne s'annule pas", async () => {
    const { message, job } = await queuedMessage();
    // `running` = un exécuteur l'a pris ; l'annulation arrive trop tard.
    await testDb.update(scheduledJobs).set({ status: "running" }).where(eq(scheduledJobs.id, job.id));

    expect(await cancelOutboundSmsAction(message.id)).toEqual({ ok: false, error: "alreadySent" });
    const [msg] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(msg.status).toBe("queued");
  });

  it("un message ENTRANT ne s'annule pas", async () => {
    const client = await makeClient();
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
    });
    const [inbound] = await testDb
      .insert(messages)
      .values({
        conversationId: thread.id,
        direction: "in",
        body: "allo",
        source: "human",
        status: "received",
      })
      .returning();
    expect(await cancelOutboundSmsAction(inbound.id)).toEqual({ ok: false, error: "invalid" });
  });

  it("sans session, on n'annule rien", async () => {
    const { message } = await queuedMessage();
    await loginAs(null);
    expect(await cancelOutboundSmsAction(message.id)).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("réessayer un fil en panne", () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** Un assistant ACTIF et compilé — la condition pour que « réessayer » relance quoi que ce soit. */
  async function makeActiveAssistant() {
    // Le déclencheur d'activation exige un noyau de prompt compilé existant.
    await testDb.insert(promptCores).values({ version: 1, body: "# RÔLE\nnoyau" }).onConflictDoNothing();
    const [active] = await testDb
      .insert(assistants)
      .values({
        name: "Actif", status: "active", identity: {}, goal: {}, approach: {}, model: {},
        compiledPrompt: "prompt", compiledCoreVersion: 1, needsRecompile: false, requireSuitePass: false,
      })
      .returning();
    return active;
  }

  it("un TÉLÉPHONISTE rouvre l'entrant consommé, le tour repart, la pastille tombe", async () => {
    // C'est le geste d'une carte « Panne du modèle » : pas besoin d'être
    // admin ni de ratisser toute la flotte comme le rejeu global.
    const caller = await makeUser({ role: "caller", email: "retry1@x.test" });
    await loginAs(caller);
    const number = await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550190" });
    const assistant = await makeActiveAssistant();
    const thread = await makeConversation({
      clientId: client.id, clientPhone: client.phone, smsNumberId: number.id,
      activeAssistantId: assistant.id, aiEnabled: true,
      needsAttention: true, attentionReason: "llm_error",
    });
    // Un sortant reçu, puis un entrant CONSOMMÉ par le tour mort : le fil est
    // réglé du point de vue de la file, personne ne répondra jamais.
    await testDb.insert(messages).values([
      {
        conversationId: thread.id, direction: "out", body: "Bonjour!", source: "agent",
        status: "delivered", createdAt: new Date("2026-08-25T14:00:00Z"),
      },
      {
        conversationId: thread.id, direction: "in", body: "Vos frais?", source: "human",
        status: "received", processedAt: new Date("2026-08-25T15:01:00Z"),
        createdAt: new Date("2026-08-25T15:00:00Z"),
      },
    ]);

    const result = await retryAiTurnAction(thread.id);
    expect(result).toEqual({ ok: true, id: thread.id, relaunched: true });

    // L'entrant est rouvert…
    const inbound = (await testDb.select().from(messages)).find((m) => m.direction === "in");
    expect(inbound!.processedAt).toBeNull();
    // …le tour est en file sous la clé du webhook…
    const turns = (await testDb.select().from(scheduledJobs)).filter((j) => j.type === "agent_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe("pending");
    // …et la pastille est tombée, l'IA en selle.
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, thread.id) });
    expect(conv!.needsAttention).toBe(false);
    expect(conv!.attentionReason).toBeNull();
    expect(conv!.aiEnabled).toBe(true);
  });

  it("réessayer DEUX fois n'empile pas deux tours (clé de dédoublonnage)", async () => {
    const caller = await makeUser({ role: "caller", email: "retry2@x.test" });
    await loginAs(caller);
    const number = await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550191" });
    const assistant = await makeActiveAssistant();
    const thread = await makeConversation({
      clientId: client.id, clientPhone: client.phone, smsNumberId: number.id,
      activeAssistantId: assistant.id, aiEnabled: true,
      needsAttention: true, attentionReason: "no_text",
    });
    await testDb.insert(messages).values({
      conversationId: thread.id, direction: "in", body: "Allo?", source: "human",
      status: "received", processedAt: new Date(), createdAt: new Date(),
    });

    expect((await retryAiTurnAction(thread.id)).ok).toBe(true);
    expect((await retryAiTurnAction(thread.id)).ok).toBe(true);
    const turns = (await testDb.select().from(scheduledJobs)).filter((j) => j.type === "agent_turn");
    expect(turns).toHaveLength(1);
  });

  it("sans assistant actif sur le fil, réessayer est REFUSÉ — pas une pastille tombée en silence", async () => {
    const caller = await makeUser({ role: "caller", email: "retry3@x.test" });
    await loginAs(caller);
    const number = await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550192" });
    const thread = await makeConversation({
      clientId: client.id, clientPhone: client.phone, smsNumberId: number.id,
      needsAttention: true, attentionReason: "send_failed",
    });
    expect(await retryAiTurnAction(thread.id)).toEqual({ ok: false, error: "assistantUnavailable" });
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, thread.id) });
    expect(conv!.needsAttention).toBe(true);
  });

  it("rien à relancer : la pastille tombe et l'action le DIT (relaunched: false)", async () => {
    // Fil en panne sans entrant à reprendre ni ouverture en échec — un
    // humain a peut-être déjà répondu à la main. « Réessayé » et « rien à
    // réessayer » ne doivent pas afficher le même toast.
    const caller = await makeUser({ role: "caller", email: "retry4@x.test" });
    await loginAs(caller);
    const number = await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550193" });
    const assistant = await makeActiveAssistant();
    const thread = await makeConversation({
      clientId: client.id, clientPhone: client.phone, smsNumberId: number.id,
      activeAssistantId: assistant.id, aiEnabled: true,
      needsAttention: true, attentionReason: "send_failed",
    });

    const result = await retryAiTurnAction(thread.id);
    expect(result).toEqual({ ok: true, id: thread.id, relaunched: false });
    const turns = (await testDb.select().from(scheduledJobs)).filter((j) => j.type === "agent_turn");
    expect(turns).toHaveLength(0);
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, thread.id) });
    expect(conv!.needsAttention).toBe(false);
  });
});

describe("envoi manuel — garde-fous de la revue", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("un envoi à la main part sans registre de consentement", async () => {
    // Toute fiche entrée dans ce CRM est réputée joignable : le registre de
    // consentement ne conditionne plus l'envoi. Ce qui reste, et qui compte,
    // c'est le refus exprimé — voir le cas « désabonné » plus bas.
    const caller = await makeUser({ role: "caller", email: "c1@x.test" });
    await loginAs(caller);
    await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550171" });
    const result = await sendManualSmsAction({ clientId: client.id, body: "Bonjour!" });
    expect(result).toMatchObject({ ok: true });
    expect(await testDb.select().from(scheduledJobs)).toHaveLength(1);
  });

  it("la personne a écrit en premier : répondre est permis", async () => {
    const caller = await makeUser({ role: "caller", email: "c2@x.test" });
    await loginAs(caller);
    const number = await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550172" });
    const thread = await makeConversation({ clientId: client.id, clientPhone: client.phone, smsNumberId: number.id });
    await testDb.insert(messages).values({ conversationId: thread.id, direction: "in", body: "Allo?", source: "human", status: "received" });
    const result = await sendManualSmsAction({ clientId: client.id, body: "Bonjour, ici Alex." });
    expect(result.ok).toBe(true);
  });

  it("un fil existant garde SON numéro, même si un autre numéro est actif", async () => {
    const caller = await makeUser({ role: "caller", email: "c3@x.test" });
    await loginAs(caller);
    const first = await makeSmsNumber({ e164: "+15810000001" });
    const second = await makeSmsNumber({ e164: "+15810000002" });
    void second;
    const client = await makeClient({ phone: "+15145550173" });
    await grantConsent(client.id);
    const thread = await makeConversation({ clientId: client.id, clientPhone: client.phone, smsNumberId: first.id });
    const result = await sendManualSmsAction({ clientId: client.id, body: "Suite de notre échange." });
    expect(result.ok).toBe(true);
    expect(result.ok && result.id).toBe(thread.id);
    const rows = await testDb.select().from(conversations).where(eq(conversations.clientPhone, client.phone));
    expect(rows).toHaveLength(1);
  });

  it("un envoi EN FILE s'annule par son job ; une fois pris, trop tard", async () => {
    const caller = await makeUser({ role: "caller", email: "c4@x.test" });
    await loginAs(caller);
    await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550174" });
    await grantConsent(client.id);
    await sendManualSmsAction({ clientId: client.id, body: "Oups, pas celui-là." });
    const [job] = await testDb.select().from(scheduledJobs);
    expect(job.status).toBe("pending");
    expect(await cancelQueuedSmsAction(job.id)).toEqual({ ok: true, id: job.id });
    const [after] = await testDb.select().from(scheduledJobs);
    expect(after.status).toBe("cancelled");
    // Déjà pris par le répartiteur : refus explicite.
    await testDb.update(scheduledJobs).set({ status: "running" }).where(eq(scheduledJobs.id, job.id));
    expect(await cancelQueuedSmsAction(job.id)).toEqual({ ok: false, error: "alreadySent" });
  });

  it("prendre le contrôle ANNULE les envois automatisés en file, pas ceux tapés à la main", async () => {
    const caller = await makeUser({ role: "caller", email: "c5@x.test" });
    await loginAs(caller);
    const number = await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550175" });
    const thread = await makeConversation({ clientId: client.id, clientPhone: client.phone, smsNumberId: number.id });
    await testDb.insert(scheduledJobs).values([
      { type: "send_sms", runAt: new Date(Date.now() + 60_000), payload: { conversationId: thread.id, to: client.phone, body: "réponse IA différée", source: "agent", automated: true } },
      { type: "send_sms", runAt: new Date(), payload: { conversationId: thread.id, to: client.phone, body: "message humain", source: "human", automated: false } },
      { type: "agent_turn", runAt: new Date(), payload: { conversationId: thread.id } },
    ]);
    expect(await setConversationAiAction({ conversationId: thread.id, enabled: false, reason: "je reprends" })).toMatchObject({ ok: true });
    const jobs = await testDb.select().from(scheduledJobs);
    const byBody = (b: string) => jobs.find((j) => (j.payload as { body?: string }).body === b)!;
    expect(byBody("réponse IA différée").status).toBe("cancelled");
    expect(byBody("message humain").status).toBe("pending");
    expect(jobs.find((j) => j.type === "agent_turn")!.status).toBe("cancelled");
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, thread.id) });
    expect(conv!.pauseReason).toBe("je reprends");
  });

  it("confier un fil à un assistant ACTIF ; un inactif est refusé ; un entrant en attente déclenche un tour", async () => {
    const admin = await makeUser({ role: "admin", email: "a6@x.test" });
    await loginAs(admin);
    await seedGuardrailDefaults();
    const number = await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550176" });
    const thread = await makeConversation({ clientId: client.id, clientPhone: client.phone, smsNumberId: number.id, aiEnabled: false });
    const [draft] = await testDb.insert(assistants).values({ name: "Brouillon", status: "draft", identity: {}, goal: {}, approach: {}, model: {} }).returning();
    expect(await assignAssistantAction({ conversationId: thread.id, assistantId: draft.id })).toEqual({ ok: false, error: "assistantUnavailable" });
    const [active] = await testDb
      .insert(assistants)
      .values({
        name: "Actif", status: "active", identity: {}, goal: {}, approach: {}, model: {},
        compiledPrompt: "prompt", compiledCoreVersion: 1, needsRecompile: false, requireSuitePass: false,
      })
      .returning();
    await testDb.insert(messages).values({ conversationId: thread.id, direction: "in", body: "Allo?", source: "human", status: "received" });
    expect(await assignAssistantAction({ conversationId: thread.id, assistantId: active.id })).toEqual({ ok: true, id: thread.id });
    const conv = await testDb.query.conversations.findFirst({ where: eq(conversations.id, thread.id) });
    expect(conv!.activeAssistantId).toBe(active.id);
    // Confier = l'IA reprend la parole.
    expect(conv!.aiEnabled).toBe(true);
    const turns = (await testDb.select().from(scheduledJobs)).filter((j) => j.type === "agent_turn");
    expect(turns).toHaveLength(1);
    // Retirer l'assistant.
    expect(await assignAssistantAction({ conversationId: thread.id, assistantId: null })).toEqual({ ok: true, id: thread.id });
    expect((await testDb.query.conversations.findFirst({ where: eq(conversations.id, thread.id) }))!.activeAssistantId).toBeNull();
  });
});


// ═══════════════════════════════════════════════════════════════════════════
/**
 * Clore un fil — la SORTIE de « Entre vos mains ».
 *
 * Cette section grossissait sans fin : sa pastille est déjà tombée (rien à
 * « marquer traité ») et rendre la main exige un assistant. Ce que « clore »
 * doit garantir, et que l'écran ne montre pas : la machine ne se réveille pas,
 * personne n'est réduit au silence, et un identifiant deviné n'ouvre rien.
 */
describe("clore un fil tenu", () => {
  /** Un fil « entre vos mains » : IA coupée, plus aucune pastille. */
  async function heldThread(clientId: string, phone: string) {
    return makeConversation({
      clientId,
      clientPhone: phone,
      smsNumberId: numberId,
      aiEnabled: false,
      pausedById: caller.id,
      pauseReason: "manual",
      needsAttention: false,
    });
  }

  it("le fil sort de la pile SANS que la machine reprenne la parole", async () => {
    const client = await makeClient({ assignedToId: caller.id });
    const thread = await heldThread(client.id, client.phone);

    expect((await closeConversationAction(thread.id)).ok).toBe(true);

    const row = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, thread.id),
    });
    expect(row!.attentionReason).toBe("closed_by_human");
    expect(row!.needsAttention).toBe(false);
    // L'IA reste COUPÉE : on ne remet pas un robot aux commandes d'un fil qu'un
    // humain avait pris — clore n'est pas rendre la main.
    expect(row!.aiEnabled).toBe(false);
    // Et rien n'est mis en file : clore n'envoie aucun message.
    expect(await testDb.select().from(scheduledJobs)).toHaveLength(0);
  });

  it("un fil que l'IA mène ne se clôt pas par ce bouton", async () => {
    // L'invariant : clore est le geste des fils TENUS. Sinon un clic périmé,
    // parti d'un onglet ouvert depuis une heure, closait un fil que
    // l'assistant venait de reprendre — et l'écran mentait dans les deux sens.
    const client = await makeClient({ assignedToId: caller.id });
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
    });

    expect(await closeConversationAction(thread.id)).toEqual({ ok: false, error: "invalid" });
    const row = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, thread.id),
    });
    expect(row!.attentionReason).toBeNull();
  });

  it("clore ne fait taire personne : le client qui réécrit revient en tête", async () => {
    // C'est la promesse de tout le geste. Sans elle, « clore » serait un
    // enterrement — et un lead enterré ne se rattrape pas.
    const client = await makeClient({ assignedToId: caller.id });
    const thread = await heldThread(client.id, client.phone);
    await closeConversationAction(thread.id);

    await processInboundSms({
      messageSid: "SM_reveil",
      from: client.phone,
      to: numberE164,
      body: "Finalement, on peut se parler?",
    });

    const row = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, thread.id),
    });
    expect(row!.needsAttention).toBe(true);
    expect(row!.attentionReason).toBe("inbound");
  });

  it("l'observateur ne clôt rien", async () => {
    const client = await makeClient({ assignedToId: caller.id });
    const thread = await heldThread(client.id, client.phone);

    const stagiaire = await makeUser({ role: "caller", name: "Stagiaire" });
    await setUserRole(stagiaire.id, OBSERVER_ROLE_ID);
    await loginAs({ ...stagiaire, role: "caller" });

    expect(await closeConversationAction(thread.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await closeHeldConversationsAction([thread.id])).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("« tout clore » ne clôt que ce qu'on a le droit de clore, et le DIT", async () => {
    // Le droit du rôle est le plafond, la case `sms` de la fiche le robinet :
    // la fiche prise par un collègue est visible (pour ne pas la rappeler) et
    // muette. Annoncer « 3 fils clos » sur 2 fermetures serait un mensonge.
    const colleague = await makeUser({ role: "caller", name: "Collègue" });
    const mine1 = await makeClient({ assignedToId: caller.id });
    const mine2 = await makeClient({ assignedToId: caller.id });
    const theirs = await makeClient({ assignedToId: colleague.id });

    const t1 = await heldThread(mine1.id, mine1.phone);
    const t2 = await heldThread(mine2.id, mine2.phone);
    const t3 = await heldThread(theirs.id, theirs.phone);

    const result = await closeHeldConversationsAction([t1.id, t2.id, t3.id]);
    expect(result).toEqual({ ok: true, closed: 2 });

    const rows = await testDb.select().from(conversations);
    const closed = rows.filter((r) => r.attentionReason === "closed_by_human").map((r) => r.id);
    expect(closed.sort()).toEqual([t1.id, t2.id].sort());
    // Le fil du collègue n'a pas bougé d'un pouce.
    expect(rows.find((r) => r.id === t3.id)!.attentionReason).toBeNull();
  });

  it("clore deux fois ne compte pas deux fois — le verdict est déjà rendu", async () => {
    // Deux téléphonistes pressent « Tout clore » sur la même pile, ou un
    // double-clic passe. Sans le troisième test de `HELD` (aucun verdict
    // rendu), la seconde passe rematchait les mêmes fils : le toast annonçait
    // « 2 fils clos » pour des fils déjà clos, et le journal d'audit écrivait
    // une seconde ligne avec les mêmes identifiants.
    const client = await makeClient({ assignedToId: caller.id });
    const thread = await heldThread(client.id, client.phone);

    expect(await closeHeldConversationsAction([thread.id])).toEqual({ ok: true, closed: 1 });
    expect(await closeHeldConversationsAction([thread.id])).toEqual({ ok: true, closed: 0 });
    expect(await closeConversationAction(thread.id)).toEqual({ ok: false, error: "invalid" });
  });

  it("une liste vide ou un identifiant qui n'en est pas un est refusé", async () => {
    expect(await closeHeldConversationsAction([])).toEqual({ ok: false, error: "invalid" });
    expect(await closeHeldConversationsAction(["pas-un-uuid"])).toEqual({
      ok: false,
      error: "invalid",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * Un envoi PERDU — les deux boutons de la vue « Échecs ».
 *
 * Ces deux gestes n'avaient aucun test, et ce sont les deux plus chers du
 * module : l'un envoie un vrai texto à une vraie personne, l'autre écrit dans
 * une colonne qui n'existait pas hier.
 *
 * Ce que l'écran ne montre pas, et qu'il faut donc prouver ici :
 *
 *  · « Réessayer » relit `clients.phone` TEL QU'IL EST — parce que le geste
 *    n'a de sens qu'après avoir corrigé le numéro de la fiche. Rejouer la
 *    charge de l'ancien job renverrait fidèlement le message au numéro qui
 *    vient d'échouer, et le bouton mentirait à chaque clic.
 *  · « Retirer » range un écran, il n'efface rien : la rangée reste dans le
 *    fil du client, avec son texte, son statut et son code — c'est elle, la
 *    preuve de la panne que la délivrabilité compte encore.
 *  · Les deux n'ouvrent PAS la même porte (règle 1) : écrire est
 *    `conversations.reply`, archiver pour tout le monde est
 *    `conversations.control`. Et sur une fiche qu'on ne voit pas, la réponse
 *    est « introuvable » — un « interdit » confirmerait qu'elle existe.
 */
describe("un envoi perdu : réessayer, retirer", () => {
  /**
   * La rangée que la vue « Échecs » montre. Par défaut `30005` (numéro
   * inexistant) : le code qui donne tout son sens au bouton, puisqu'on va
   * rectifier le téléphone avant de le presser.
   */
  async function failedSend(
    overrides: {
      phone?: string;
      status?: string;
      errorCode?: number | null;
      assignedToId?: string;
    } = {},
  ) {
    const client = await makeClient({
      phone: overrides.phone ?? "+15145550140",
      assignedToId: overrides.assignedToId ?? null,
    });
    const thread = await makeConversation({
      clientId: client.id,
      clientPhone: client.phone,
      smsNumberId: numberId,
      needsAttention: true,
      attentionReason: "send_failed",
    });
    const [message] = await testDb
      .insert(messages)
      .values({
        conversationId: thread.id,
        direction: "out",
        body: "Bonjour, ici Alex — on se parle demain?",
        source: "human",
        status: overrides.status ?? "undelivered",
        errorCode: overrides.errorCode === undefined ? 30005 : overrides.errorCode,
      })
      .returning();
    return { client, thread, message };
  }

  const sendJobs = async () =>
    (await testDb.select().from(scheduledJobs)).filter((j) => j.type === "send_sms");

  /**
   * Le rôle téléphoniste, MOINS un droit. Rien ne prouve que deux boutons
   * voisins d'une même carte ouvrent deux portes différentes tant qu'un rôle
   * ne porte pas l'une sans l'autre.
   */
  async function callerWithout(
    missing: "conversations.reply" | "conversations.control",
  ): Promise<void> {
    const cfg = defaultPermissionsConfig();
    await setSetting("permissions", {
      ...cfg,
      roles: cfg.roles.map((r) =>
        r.id === CALLER_ROLE_ID ? { ...r, perms: { ...r.perms, [missing]: false } } : r,
      ),
    });
  }

  it("le renvoi part au numéro CORRIGÉ, jamais à celui qui vient d'échouer", async () => {
    // LE test de toute la fonctionnalité. On lit « Numéro inexistant · code
    // 30005 » dans les Échecs, on va rectifier le téléphone du contact, on
    // revient presser le bouton. Si la destination était reprise du `to` de
    // l'ancien job, le texto repartirait vers le numéro mort — pour rien, et
    // sans que personne ne s'en aperçoive avant le prochain échec.
    const { client, thread, message } = await failedSend({ phone: "+15145550140" });
    await testDb
      .update(clients)
      .set({ phone: "+15145550141" })
      .where(eq(clients.id, client.id));

    const result = await retryFailedSmsAction(message.id);
    expect(result.ok).toBe(true);

    const jobs = await sendJobs();
    expect(jobs).toHaveLength(1);
    const payload = jobs[0].payload as {
      conversationId: string;
      to: string;
      body: string;
      source: string;
      automated: boolean;
      aiGenerated: boolean;
      sentById: string;
    };
    expect(payload.to).toBe("+15145550141");
    expect(payload.body).toBe("Bonjour, ici Alex — on se parle demain?");
    // Un renvoi est un envoi HUMAIN : c'est une personne qui a décidé, à cette
    // heure-ci, que ce message devait repartir. Ni les heures de politesse ni
    // la pause IA n'ont à trancher pour elle — d'où `automated: false`.
    expect(payload.source).toBe("human");
    expect(payload.automated).toBe(false);
    expect(payload.aiGenerated).toBe(false);
    expect(payload.sentById).toBe(caller.id);

    // Et le fil visé est celui qui parle au NOUVEAU numéro : les entrants sont
    // rattachés par `clientPhone`, une réponse au vieux fil ne reviendrait
    // jamais.
    expect(result.ok && result.id).not.toBe(thread.id);
    const target = await testDb.query.conversations.findFirst({
      where: eq(conversations.id, payload.conversationId),
    });
    expect(target!.clientPhone).toBe("+15145550141");
    expect(target!.clientId).toBe(client.id);
  });

  it("l'échec sort de la vue mais RESTE la preuve : texte, statut et code intacts", async () => {
    const { message } = await failedSend({ phone: "+15145550143" });

    expect((await retryFailedSmsAction(message.id)).ok).toBe(true);

    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    // Écarté — l'écran ne doit pas continuer de réclamer un geste qu'on vient
    // de faire…
    expect(row.dismissedAt).not.toBeNull();
    expect(row.dismissedById).toBe(caller.id);
    // …et rien d'autre n'a bougé : /admin/deliverability compte toujours cet
    // envoi perdu, et le fil du client le montre toujours.
    expect(row.body).toBe(message.body);
    expect(row.status).toBe("undelivered");
    expect(row.errorCode).toBe(30005);
  });

  it("deux renvois sur la même rangée ne font QU'UN texto", async () => {
    // Le doublon que cette garde existe pour empêcher : deux téléphonistes
    // devant la même rangée (la vue « Échecs » est partagée), un onglet resté
    // ouvert derrière un autre, ou un cellulaire dont la réponse s'est perdue
    // et qu'on represse. Sans le jeton `dismissedAt`, chacun mettait son job en
    // file : le contact recevait deux fois le même texto, facturé deux fois —
    // et sur un fil de campagne, c'est ce qui fait répondre STOP.
    const { message } = await failedSend({ phone: "+15145550146" });

    const first = await retryFailedSmsAction(message.id);
    expect(first.ok).toBe(true);

    // Le second arrive sur une vue périmée. « Introuvable » est le mot juste :
    // c'est celui qui fait rafraîchir la boîte au lieu d'expédier.
    expect(await retryFailedSmsAction(message.id)).toEqual({ ok: false, error: "notFound" });
    expect(await sendJobs()).toHaveLength(1);

    // Et la signature du premier n'a pas été réécrite par le second.
    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.dismissedById).toBe(caller.id);
  });

  it("une rangée déjà RETIRÉE ne se réessaie plus", async () => {
    // « Retirer » puis « Réessayer » depuis un onglet qui n'a pas vu le
    // retrait : la rangée n'est plus dans la vue, le geste n'a plus d'objet.
    const { message } = await failedSend({ phone: "+15145550147" });

    expect((await dismissFailedSmsAction(message.id)).ok).toBe(true);
    expect(await retryFailedSmsAction(message.id)).toEqual({ ok: false, error: "notFound" });
    expect(await sendJobs()).toHaveLength(0);
  });

  it("un numéro désabonné est refusé, et RIEN n'est mis en file", async () => {
    // Le désabonnement est absolu (règle 12) : même à la main, même après
    // correction du numéro, même si le bouton s'affiche.
    const { client, message } = await failedSend({ phone: "+15145550144" });
    await testDb.insert(suppressions).values({ phoneE164: client.phone, reason: "sms_stop" });

    expect(await retryFailedSmsAction(message.id)).toEqual({ ok: false, error: "suppressed" });
    expect(await sendJobs()).toHaveLength(0);
    // L'échec reste affiché : rien n'a été fait, l'écran ne doit pas prétendre
    // le contraire.
    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.dismissedAt).toBeNull();
  });

  it("un message LIVRÉ ne se réessaie pas — il ferait relire un texte à une vraie personne", async () => {
    const { message } = await failedSend({
      phone: "+15145550145",
      status: "delivered",
      errorCode: null,
    });

    expect(await retryFailedSmsAction(message.id)).toEqual({ ok: false, error: "invalid" });
    expect(await sendJobs()).toHaveLength(0);
  });

  it("« Retirer » écarte sans détruire, et deux clics ne font qu'un geste", async () => {
    const { thread, message } = await failedSend({ phone: "+15145550146" });

    expect(await dismissFailedSmsAction(message.id)).toEqual({ ok: true, id: message.id });
    const [first] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(first.dismissedAt).not.toBeNull();
    expect(first.dismissedById).toBe(caller.id);
    const signature = first.dismissedAt!.getTime();

    // Deuxième onglet, ou clic répété : « fait », sans réécrire QUI a écarté ni
    // QUAND — sinon la colonne mentirait sur le geste qu'elle date.
    expect(await dismissFailedSmsAction(message.id)).toEqual({ ok: true, id: message.id });
    const [again] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(again.dismissedAt!.getTime()).toBe(signature);
    expect(again.dismissedById).toBe(caller.id);

    // Une seule ligne au journal : deux clics ne sont pas deux décisions.
    const written = (await testDb.select().from(auditLogs)).filter(
      (a) => a.action === "sms.dismiss_failure",
    );
    expect(written).toHaveLength(1);

    // Et le message est TOUJOURS dans le fil du client. C'est tout l'intérêt
    // de la colonne : sans elle, faire disparaître un envoi perdu de l'écran
    // qu'on relit chaque matin obligeait à l'effacer pour de bon.
    const inThread = await testDb
      .select()
      .from(messages)
      .where(eq(messages.conversationId, thread.id));
    expect(inThread).toHaveLength(1);
    expect(inThread[0].body).toBe(message.body);
    expect(inThread[0].status).toBe("undelivered");
    expect(inThread[0].errorCode).toBe(30005);
  });

  it("sans le droit d'ÉCRIRE, on ne réessaie pas — même en gardant le droit de retirer", async () => {
    const { message } = await failedSend({ phone: "+15145550147" });
    await callerWithout("conversations.reply");

    expect(await retryFailedSmsAction(message.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await sendJobs()).toHaveLength(0);
    // Le voisin, lui, reste ouvert : les deux boutons ne partagent pas leur
    // porte.
    expect(await dismissFailedSmsAction(message.id)).toEqual({ ok: true, id: message.id });
  });

  it("sans le droit de COMMANDER, on ne retire pas — même en gardant le droit d'écrire", async () => {
    // Retirer, c'est archiver : l'échec quitte la vue de TOUT LE MONDE. Ce
    // n'est pas une décision privée, d'où `conversations.control`.
    const { message } = await failedSend({ phone: "+15145550148" });
    await callerWithout("conversations.control");

    expect(await dismissFailedSmsAction(message.id)).toEqual({ ok: false, error: "forbidden" });
    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.dismissedAt).toBeNull();
  });

  it("un échec sur une fiche INVISIBLE répond « introuvable », jamais « interdit »", async () => {
    // Règle 1 : un refus confirmerait l'existence de ce que le réglage cache.
    // Une fiche prise par le courtier n'existe pas pour un téléphoniste — ni en
    // liste, ni par l'URL, ni par l'identifiant d'un de ses messages.
    const { message } = await failedSend({ phone: "+15145550149", assignedToId: admin.id });

    expect(await retryFailedSmsAction(message.id)).toEqual({ ok: false, error: "notFound" });
    expect(await dismissFailedSmsAction(message.id)).toEqual({ ok: false, error: "notFound" });
    expect(await sendJobs()).toHaveLength(0);
    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.dismissedAt).toBeNull();
  });

  it("sans session, ni renvoi ni retrait", async () => {
    const { message } = await failedSend({ phone: "+15145550150" });
    await loginAs(null);

    expect(await retryFailedSmsAction(message.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await dismissFailedSmsAction(message.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await sendJobs()).toHaveLength(0);
  });
});

describe("une ligne fermée : la rouvrir, ou pas", () => {
  /**
   * Dix-huit des vingt-trois numéros bloqués en production n'ont JAMAIS écrit
   * STOP : c'est le moteur qui a fermé leur ligne après un refus de
   * l'opérateur — le code 30003 veut dire « téléphone éteint ». D'où ce geste,
   * et d'où la seule frontière qui compte ici.
   */
  async function blocked(reason: string, phone: string, note: string | null = null) {
    await testDb.insert(suppressions).values({ phoneE164: phone, reason, note });
    return phone;
  }

  it("un refus d'OPÉRATEUR se rétablit — c'est notre moteur qui avait tranché", async () => {
    await loginAs(admin);
    const phone = await blocked("carrier_error", "+15145550160", "code 30003");

    expect((await liftSuppressionAction(phone)).ok).toBe(true);
    const rows = await testDb.select().from(suppressions).where(eq(suppressions.phoneE164, phone));
    expect(rows).toHaveLength(0);
  });

  it("un STOP ne se lève JAMAIS, et la rangée SURVIT au refus", async () => {
    // La garantie de la règle 12, et le test qui compte le plus de ce bloc :
    // un STOP est la décision du contact, pas un réglage de l'exploitant. Seul
    // un START venant de lui rouvre la ligne.
    await loginAs(admin);
    const phone = await blocked("sms_stop", "+15145550161");

    expect(await liftSuppressionAction(phone)).toEqual({ ok: false, error: "stopIsAbsolute" });
    const rows = await testDb.select().from(suppressions).where(eq(suppressions.phoneE164, phone));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("sms_stop");
  });

  it("le motif et la note sont JOURNALISÉS — la rangée disparaît, la preuve non", async () => {
    await loginAs(admin);
    const phone = await blocked("carrier_error", "+15145550162", "code 30003");

    expect((await liftSuppressionAction(phone)).ok).toBe(true);

    const entries = (await testDb.select().from(auditLogs)).filter(
      (a) => a.action === "sms.lift_suppression",
    );
    expect(entries).toHaveLength(1);
    const detail = entries[0].detail as { reason?: string; note?: string | null };
    // Sans ces deux champs, plus rien ne dirait CE QUI a été défait : la
    // rangée qui les portait vient d'être supprimée.
    expect(detail.reason).toBe("carrier_error");
    expect(detail.note).toBe("code 30003");
  });

  it("un téléphoniste ne rouvre pas une ligne — c'est la conduite du moteur", async () => {
    await loginAs(caller);
    const phone = await blocked("carrier_error", "+15145550163");

    expect(await liftSuppressionAction(phone)).toEqual({ ok: false, error: "forbidden" });
    const rows = await testDb.select().from(suppressions).where(eq(suppressions.phoneE164, phone));
    expect(rows).toHaveLength(1);
  });

  it("un numéro qui n'est pas fermé répond « introuvable »", async () => {
    await loginAs(admin);
    expect(await liftSuppressionAction("+15145550164")).toEqual({ ok: false, error: "notFound" });
  });

  it("sans session, aucune ligne ne se rouvre", async () => {
    const phone = await blocked("carrier_error", "+15145550165");
    await loginAs(null);

    expect(await liftSuppressionAction(phone)).toEqual({ ok: false, error: "forbidden" });
    const rows = await testDb.select().from(suppressions).where(eq(suppressions.phoneE164, phone));
    expect(rows).toHaveLength(1);
  });
});

describe("une tâche du moteur morte : l'abandonner", () => {
  /** Une tâche définitivement tombée, comme les 174 d'une nuit de panne. */
  async function deadJob(type = "agent_turn", err = "llm_provider_unconfigured: anthropic") {
    const [job] = await testDb
      .insert(scheduledJobs)
      .values({
        type,
        runAt: new Date(),
        payload: {},
        status: "failed",
        attempts: 3,
        lastError: err,
      })
      .returning();
    return job;
  }

  it("« Abandonner » ne rejoue rien et n'efface rien — la trace reste", async () => {
    await loginAs(admin);
    const job = await deadJob();

    expect((await dismissFailedJobAction(job.id)).ok).toBe(true);

    const [row] = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.id, job.id));
    // La rangée SURVIT, avec son erreur : c'est ce qui permettra de comprendre
    // plus tard ce qui est tombé cette nuit-là.
    expect(row.status).toBe("cancelled");
    expect(row.lastError).toBe("llm_provider_unconfigured: anthropic");
    expect(row.attempts).toBe(3);
  });

  it("une tâche EN ATTENTE ne s'abandonne pas par ce chemin", async () => {
    // Seul ce qui est définitivement tombé s'abandonne : annuler un envoi qui
    // attend son heure est un autre geste, avec un autre bouton.
    await loginAs(admin);
    const [pendingJob] = await testDb
      .insert(scheduledJobs)
      .values({ type: "send_sms", runAt: new Date(), payload: {}, status: "pending" })
      .returning();

    expect(await dismissFailedJobAction(pendingJob.id)).toEqual({ ok: false, error: "notFound" });
    const [row] = await testDb
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.id, pendingJob.id));
    expect(row.status).toBe("pending");
  });

  it("« Tout abandonner » porte sur TOUTES les tâches tombées, et sur elles seules", async () => {
    await loginAs(admin);
    await deadJob("agent_turn");
    await deadJob("call_transcript", "truncated");
    const [alive] = await testDb
      .insert(scheduledJobs)
      .values({ type: "send_sms", runAt: new Date(), payload: {}, status: "pending" })
      .returning();

    const result = await dismissAllFailedJobsAction();
    expect(result.ok).toBe(true);
    // Le compte rendu dit ce qui a RÉELLEMENT été abandonné.
    expect(result.ok && result.closed).toBe(2);

    const rows = await testDb.select().from(scheduledJobs);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(0);
    // L'envoi qui attendait son heure n'a pas été touché.
    expect(rows.find((r) => r.id === alive.id)!.status).toBe("pending");
  });

  it("un téléphoniste n'abandonne pas une tâche — c'est la conduite du moteur", async () => {
    await loginAs(caller);
    const job = await deadJob();

    expect(await dismissFailedJobAction(job.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await dismissAllFailedJobsAction()).toEqual({ ok: false, error: "forbidden" });
    const [row] = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.id, job.id));
    expect(row.status).toBe("failed");
  });
});
