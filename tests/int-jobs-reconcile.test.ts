/**
 * Intégration — réconciliation REST Twilio (src/lib/jobs/reconcile.ts).
 *
 * Aucun réseau : `fetchFn` est injecté. La base est réelle — c'est le point du
 * module : avancer des rangées `messages` bloquées et rejouer des entrants
 * perdus via le VRAI processInboundSms (suppressions, conversations, jobs).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  resetDb,
  testDb,
} from "./helpers/db";
import { assistants, conversations, messages, promptCores, scheduledJobs, suppressions } from "@/db/schema-sms";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { reconcileTwilioMessages } = await import("@/lib/jobs/reconcile");

const NOW = new Date("2026-08-25T15:00:00.000Z");
const now = () => NOW;

/** Réponse Twilio minimale pour GET /Messages/{sid}.json. */
function messageResource(sid: string, status: string, extra: Record<string, unknown> = {}) {
  return { sid, status, error_code: null, to: "+14185551234", ...extra };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch factice routé par motif d'URL. */
function fakeFetch(routes: Array<{ match: (url: string) => boolean; body: unknown }>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    if (!route) return jsonResponse({ code: 20404 }, 404);
    return jsonResponse(route.body);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

/** Assistant ACTIF (compilé) + numéro qui l'adopte par défaut — le fil créé
 *  par un backfill peut alors réellement mettre un tour d'agent en file. */
async function seedNumberWithAssistant() {
  // La porte d'activation (trigger assistants_activation_gate) exige un cœur
  // de prompt correspondant à compiledCoreVersion.
  await testDb.insert(promptCores).values({ version: 1, body: "# RÔLE" }).onConflictDoNothing();
  const [assistant] = await testDb
    .insert(assistants)
    .values({
      name: "Léa",
      status: "active",
      identity: {},
      goal: {},
      approach: {},
      model: {},
      compiledPrompt: "PROMPT COMPILÉ (test)",
      compiledCoreVersion: 1,
      compiledAt: new Date(),
      needsRecompile: false,
      suitePassed: true,
    })
    .returning();
  const number = await makeSmsNumber({ defaultAssistantId: assistant.id });
  return { assistant, number };
}

async function seedOutbound(overrides: Partial<typeof messages.$inferInsert> = {}) {
  const client = await makeClient();
  const number = await makeSmsNumber();
  const conversation = await makeConversation({
    clientId: client.id,
    smsNumberId: number.id,
    clientPhone: client.phone,
  });
  const [row] = await testDb
    .insert(messages)
    .values({
      conversationId: conversation.id,
      direction: "out",
      body: "Bonjour!",
      twilioSid: `SMout${Math.floor(Math.random() * 1e9)}`,
      status: "queued",
      source: "human",
      // Assez vieux pour être éligible (> 2 min), assez récent pour la fenêtre.
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
      ...overrides,
    })
    .returning();
  return { client, number, conversation, message: row };
}

beforeEach(async () => {
  await resetDb();
  process.env.TWILIO_ACCOUNT_SID = "ACtest00000000000000000000000000";
  process.env.TWILIO_API_KEY_SID = "SKtest";
  process.env.TWILIO_API_KEY_SECRET = "secret";
});

afterEach(() => {
  // Ne JAMAIS laisser fuiter une config REST complète : les autres suites
  // exécutent runDispatchCycle, qui tenterait alors un vrai réseau.
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_API_KEY_SID;
  delete process.env.TWILIO_API_KEY_SECRET;
});

afterAll(async () => {
  await closeDb();
});

describe("reconcileTwilioMessages — sortant", () => {
  it("avance une rangée bloquée « queued » vers « delivered »", async () => {
    const { message } = await seedOutbound();
    const { fn } = fakeFetch([
      { match: (u) => u.includes(`/Messages/${message.twilioSid}.json`), body: messageResource(message.twilioSid!, "delivered") },
      { match: (u) => u.includes("/Messages.json"), body: { messages: [] } },
    ]);

    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts).toMatchObject({ checked: 1, advanced: 1, backfilled: 0 });
    const [after] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(after.status).toBe("delivered");
  });

  it("ne régresse jamais un statut plus définitif", async () => {
    const { message } = await seedOutbound({ status: "sent" });
    const { fn } = fakeFetch([
      { match: (u) => u.includes(`/Messages/${message.twilioSid}.json`), body: messageResource(message.twilioSid!, "queued") },
      { match: (u) => u.includes("/Messages.json"), body: { messages: [] } },
    ]);

    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts.advanced).toBe(0);
    const [after] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(after.status).toBe("sent");
  });

  it("échec définitif du transporteur : statut + code + suppression du numéro", async () => {
    const { message } = await seedOutbound();
    const { fn } = fakeFetch([
      {
        match: (u) => u.includes(`/Messages/${message.twilioSid}.json`),
        body: messageResource(message.twilioSid!, "undelivered", { error_code: 30003, to: "+14185559999" }),
      },
      { match: (u) => u.includes("/Messages.json"), body: { messages: [] } },
    ]);

    await reconcileTwilioMessages(now, { fetchFn: fn });
    const [after] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(after.status).toBe("undelivered");
    expect(after.errorCode).toBe(30003);
    const sup = await testDb.select().from(suppressions).where(eq(suppressions.phoneE164, "+14185559999"));
    expect(sup).toHaveLength(1);
    expect(sup[0].reason).toBe("carrier_error");
  });

  it("un sid inconnu chez Twilio (404) est réglé « unknown » — il ne bloque plus la tête du lot", async () => {
    const first = await seedOutbound({ createdAt: new Date(NOW.getTime() - 60 * 60_000) });
    const second = await seedOutbound({ createdAt: new Date(NOW.getTime() - 30 * 60_000) });
    // fakeFetch répond 404 à tout ce qui n'est pas routé : le premier sid
    // (environnement croisé, message purgé) tombe dessus.
    const { fn } = fakeFetch([
      {
        match: (u) => u.includes(`/Messages/${second.message.twilioSid}.json`),
        body: messageResource(second.message.twilioSid!, "delivered"),
      },
      { match: (u) => u.includes("/Messages.json"), body: { messages: [] } },
    ]);

    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts.checked).toBe(2);
    const [fossil] = await testDb.select().from(messages).where(eq(messages.id, first.message.id));
    expect(fossil.status).toBe("unknown");
    expect(fossil.skipReason).toBe("twilio_message_not_found");
    const [ok] = await testDb.select().from(messages).where(eq(messages.id, second.message.id));
    expect(ok.status).toBe("delivered");

    // Cycle suivant : le fossile n'est plus éligible, plus aucune relecture.
    const again = fakeFetch([{ match: (u) => u.includes("/Messages.json"), body: { messages: [] } }]);
    await reconcileTwilioMessages(now, { fetchFn: again.fn });
    expect(again.calls.filter((u) => /\/Messages\/SM/.test(u))).toHaveLength(0);
  });

  it("une rangée déjà terminale ou trop récente n'est pas relue", async () => {
    await seedOutbound({ status: "delivered" });
    await seedOutbound({ createdAt: new Date(NOW.getTime() - 30_000) });
    const { fn, calls } = fakeFetch([{ match: (u) => u.includes("/Messages.json"), body: { messages: [] } }]);

    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts.checked).toBe(0);
    expect(calls.filter((u) => /\/Messages\/SM/.test(u))).toHaveLength(0);
  });
});

describe("reconcileTwilioMessages — entrant (backfill)", () => {
  it("rejoue un entrant absent : rangée datée de la réception, fil « à traiter », PAS de tour d'agent (message trop vieux)", async () => {
    const client = await makeClient({ phone: "+14185551627" });
    // Un assistant est disponible : seule la garde de fraîcheur (30 min)
    // explique alors l'absence de tour d'agent.
    const { number } = await seedNumberWithAssistant();
    const receivedAt = new Date(NOW.getTime() - 3 * 60 * 60_000);
    const { fn } = fakeFetch([
      {
        match: (u) => u.includes("/Messages.json"),
        body: {
          messages: [
            {
              sid: "SMinlost1",
              direction: "inbound",
              from: client.phone,
              to: number.e164,
              body: "Pas réglé! Jamais reçu de liste",
              date_sent: receivedAt.toUTCString(),
            },
            { sid: "SMoutx", direction: "outbound-api", from: number.e164, to: client.phone, body: "x", date_sent: NOW.toUTCString() },
          ],
        },
      },
    ]);

    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts.backfilled).toBe(1);

    const [row] = await testDb.select().from(messages).where(eq(messages.twilioSid, "SMinlost1"));
    expect(row.direction).toBe("in");
    expect(row.body).toBe("Pas réglé! Jamais reçu de liste");
    expect(Math.abs(row.createdAt.getTime() - receivedAt.getTime())).toBeLessThan(1000);

    const [thread] = await testDb
      .select()
      .from(conversations)
      .where(and(eq(conversations.clientId, client.id), eq(conversations.smsNumberId, number.id)));
    expect(thread.needsAttention).toBe(true);
    // L'assistant est adopté par le fil, mais le message a > 30 min : aucun
    // tour d'agent — répondre automatiquement des heures plus tard ferait
    // plus de mal que de bien.
    expect(thread.activeAssistantId).not.toBeNull();
    const turns = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "agent_turn"));
    expect(turns).toHaveLength(0);
  });

  it("un entrant FRAIS (< 30 min) rejoué garde son tour d'agent", async () => {
    const client = await makeClient({ phone: "+14185551630" });
    const { number } = await seedNumberWithAssistant();
    const receivedAt = new Date(NOW.getTime() - 5 * 60_000);
    const { fn } = fakeFetch([
      {
        match: (u) => u.includes("/Messages.json"),
        body: {
          messages: [
            {
              sid: "SMinfresh1",
              direction: "inbound",
              from: client.phone,
              to: number.e164,
              body: "Oui toujours intéressé!",
              date_sent: receivedAt.toUTCString(),
            },
          ],
        },
      },
    ]);

    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts.backfilled).toBe(1);
    const turns = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "agent_turn"));
    expect(turns).toHaveLength(1);
  });

  it("un backfill ne fait JAMAIS reculer lastInboundAt (réponse fraîche déjà reçue)", async () => {
    const client = await makeClient({ phone: "+14185551631" });
    const number = await makeSmsNumber();
    const fresh = new Date(NOW.getTime() - 60_000);
    const conversation = await makeConversation({
      clientId: client.id,
      smsNumberId: number.id,
      clientPhone: client.phone,
      lastInboundAt: fresh,
    });
    const old = new Date(NOW.getTime() - 40 * 60 * 60_000);
    const { fn } = fakeFetch([
      {
        match: (u) => u.includes("/Messages.json"),
        body: {
          messages: [
            {
              sid: "SMinold1",
              direction: "inbound",
              from: client.phone,
              to: number.e164,
              body: "Réponse perdue d'avant-hier",
              date_sent: old.toUTCString(),
            },
          ],
        },
      },
    ]);

    await reconcileTwilioMessages(now, { fetchFn: fn });
    const [row] = await testDb.select().from(messages).where(eq(messages.twilioSid, "SMinold1"));
    expect(Math.abs(row.createdAt.getTime() - old.getTime())).toBeLessThan(1000);
    const [thread] = await testDb.select().from(conversations).where(eq(conversations.id, conversation.id));
    // La rangée est datée d'avant-hier, mais le fil garde sa récence.
    expect(thread.lastInboundAt?.getTime()).toBe(fresh.getTime());
  });

  it("un entrant déjà en base n'est pas rejoué (idempotent)", async () => {
    const client = await makeClient({ phone: "+14185551628" });
    const number = await makeSmsNumber();
    const conversation = await makeConversation({
      clientId: client.id,
      smsNumberId: number.id,
      clientPhone: client.phone,
    });
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "in",
      body: "déjà là",
      twilioSid: "SMinknown",
      status: "received",
      source: "human",
    });
    const { fn } = fakeFetch([
      {
        match: (u) => u.includes("/Messages.json"),
        body: {
          messages: [
            { sid: "SMinknown", direction: "inbound", from: client.phone, to: number.e164, body: "déjà là", date_sent: NOW.toUTCString() },
          ],
        },
      },
    ]);

    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts.backfilled).toBe(0);
    const rows = await testDb.select().from(messages).where(eq(messages.twilioSid, "SMinknown"));
    expect(rows).toHaveLength(1);
  });

  it("un STOP rejoué supprime le numéro même des heures plus tard", async () => {
    const client = await makeClient({ phone: "+14185551629" });
    const number = await makeSmsNumber();
    const { fn } = fakeFetch([
      {
        match: (u) => u.includes("/Messages.json"),
        body: {
          messages: [
            {
              sid: "SMinstop1",
              direction: "inbound",
              from: client.phone,
              to: number.e164,
              body: "STOP",
              date_sent: new Date(NOW.getTime() - 6 * 60 * 60_000).toUTCString(),
            },
          ],
        },
      },
    ]);

    await reconcileTwilioMessages(now, { fetchFn: fn });
    const sup = await testDb.select().from(suppressions).where(eq(suppressions.phoneE164, client.phone));
    expect(sup).toHaveLength(1);
    expect(sup[0].reason).toBe("sms_stop");
  });
});

describe("reconcileTwilioMessages — pagination Twilio", () => {
  it("suit next_page_uri : une réponse perdue au-delà des 50 plus récentes est quand même rejouée", async () => {
    const client = await makeClient({ phone: "+14185551632" });
    const number = await makeSmsNumber();
    const conversation = await makeConversation({
      clientId: client.id,
      smsNumberId: number.id,
      clientPhone: client.phone,
    });
    // Page 1 : un message déjà connu (les récents occupent les places) ;
    // page 2 : la réponse perdue.
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "in",
      body: "déjà connue",
      twilioSid: "SMinpage1",
      status: "received",
      source: "human",
    });
    const nextUri = `/2010-04-01/Accounts/ACtest/Messages.json?To=${encodeURIComponent(number.e164)}&PageSize=50&Page=1&PageToken=PAxyz`;
    const { fn } = fakeFetch([
      {
        match: (u) => u.includes("PageToken=PAxyz"),
        body: {
          messages: [
            {
              sid: "SMinpage2",
              direction: "inbound",
              from: client.phone,
              to: number.e164,
              body: "Perdue en page 2",
              date_sent: new Date(NOW.getTime() - 60 * 60_000).toUTCString(),
            },
          ],
        },
      },
      {
        match: (u) => u.includes("/Messages.json"),
        body: {
          next_page_uri: nextUri,
          messages: [
            {
              sid: "SMinpage1",
              direction: "inbound",
              from: client.phone,
              to: number.e164,
              body: "déjà connue",
              date_sent: NOW.toUTCString(),
            },
          ],
        },
      },
    ]);

    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts.backfilled).toBe(1);
    expect(await testDb.select().from(messages).where(eq(messages.twilioSid, "SMinpage2"))).toHaveLength(1);
  });
});

describe("reconcileTwilioMessages — entrants sans fiche", () => {
  it("un entrant sans fiche cliente est tranché UNE fois, jamais rejoué en boucle", async () => {
    const number = await makeSmsNumber();
    const routes = [
      {
        match: (u: string) => u.includes("/Messages.json"),
        body: {
          messages: [
            {
              sid: "SMinnobody",
              direction: "inbound",
              from: "+15145550000",
              to: number.e164,
              body: "Allo?",
              date_sent: NOW.toUTCString(),
            },
          ],
        },
      },
    ];

    await reconcileTwilioMessages(now, { fetchFn: fakeFetch(routes).fn });
    await reconcileTwilioMessages(now, { fetchFn: fakeFetch(routes).fn });
    await reconcileTwilioMessages(now, { fetchFn: fakeFetch(routes).fn });

    // Une seule rangée d'audit « sans fiche » malgré trois cycles.
    const { auditLogs } = await import("@/db/schema");
    const rows = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "sms.inbound_unmatched"));
    expect(rows).toHaveLength(1);
    expect(await testDb.select().from(messages).where(eq(messages.twilioSid, "SMinnobody"))).toHaveLength(0);
  });
});

describe("reconcileTwilioMessages — désarmement", () => {
  it("sans configuration REST complète : aucun appel réseau", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    await seedOutbound();
    const { fn, calls } = fakeFetch([]);
    const counts = await reconcileTwilioMessages(now, { fetchFn: fn });
    expect(counts).toEqual({ checked: 0, advanced: 0, backfilled: 0 });
    expect(calls).toHaveLength(0);
  });
});
