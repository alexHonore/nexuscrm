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
import { conversations, messages, scheduledJobs, smsNumbers, suppressions } from "@/db/schema-sms";

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
  sendManualSmsAction,
  setConversationAiAction,
  markConversationHandledAction,
  assignConversationAction,
} = await import("@/app/(app)/conversations/actions");

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

beforeEach(async () => {
  await resetDb();
  caller = await makeUser({ role: "caller", name: "Téléphoniste" });
  admin = await makeUser({ role: "admin", name: "Admin" });
  numberId = (await makeSmsNumber()).id;
  await loginAs(caller);
});

afterAll(async () => {
  await closeDb();
});

describe("envoi manuel", () => {
  it("un TÉLÉPHONISTE peut écrire — et le fil est créé au besoin", async () => {
    const client = await makeClient();

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
