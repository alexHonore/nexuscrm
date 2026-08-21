/**
 * Intégration — SMS entrant : POST /api/webhooks/twilio/inbound
 *
 * On exerce le vrai handler exporté avec de vraies `NextRequest` signées
 * (HMAC-SHA1, spec Twilio), sur la base de test locale. Aucun accès réseau.
 * Points critiques : opt-out (STOP) traité avant tout, idempotence sur
 * MessageSid (Twilio relivre), jamais de création automatique de client.
 */
import { createHmac } from "crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  closeDb,
  makeClient,
  makeSmsNumber,
  makeUser,
  resetDb,
  testDb,
} from "./helpers/db";
import { auditLogs, notifications } from "@/db/schema";
import {
  assistants,
  consents,
  conversations,
  messages,
  scheduledJobs,
  smsNumbers,
  suppressions,
} from "@/db/schema-sms";

// ── Stubs d'environnement Next (aucune logique produit n'est simulée) ────────
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

const { POST } = await import("@/app/api/webhooks/twilio/inbound/route");

// La route valide la signature sur l'URL publique (NEXT_PUBLIC_APP_URL) — on
// signe exactement la même, sinon 403 (dans .env.test le port n'est pas 3000).
const URL_INBOUND = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/inbound`;
const TOKEN = "test_twilio_token";
const SID = "SM00000000000000000000000000000101";
const FROM = "+15145550142";
const TO = "+15815550100";

/** Signature Twilio : base64(HMAC-SHA1(url + params POST triés, authToken)). */
function twilioSig(url: string, params: URLSearchParams, token: string): string {
  const data =
    url +
    [...params.keys()]
      .sort()
      .map((k) => k + (params.get(k) ?? ""))
      .join("");
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

function inboundRequest(
  form: Record<string, string>,
  { signature }: { signature?: string } = {},
): NextRequest {
  const params = new URLSearchParams(form);
  return new NextRequest(URL_INBOUND, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ?? twilioSig(URL_INBOUND, params, TOKEN),
    },
    body: params.toString(),
  });
}

function inboundForm(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: SID,
    From: FROM,
    To: TO,
    Body: "Bonjour, ici Marie. Toujours possible de se parler ?",
    ...overrides,
  };
}

describe("POST /api/webhooks/twilio/inbound", () => {
  beforeAll(() => {
    // La route lit le jeton à chaque requête — pas besoin de le poser avant l'import.
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
  });
  beforeEach(resetDb);
  afterAll(closeDb);

  it("refuse (403) une signature invalide sans rien écrire", async () => {
    await makeClient({ phone: FROM });

    const res = await POST(
      inboundRequest(inboundForm(), { signature: "pas-la-bonne-signature" }),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "invalid_signature" });

    expect(await testDb.select().from(messages)).toHaveLength(0);
    expect(await testDb.select().from(conversations)).toHaveLength(0);
    expect(await testDb.select().from(suppressions)).toHaveLength(0);
    expect(await testDb.select().from(smsNumbers)).toHaveLength(0);
  });

  it("enregistre le message d'un client connu et crée conversation + ligne SMS", async () => {
    const client = await makeClient({ fullName: "Marie Tremblay", phone: FROM });

    const res = await POST(inboundRequest(inboundForm()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    await expect(res.text()).resolves.toContain("<Response></Response>");

    // Le DID destinataire, inconnu, est auto-enregistré (le texto n'est pas perdu).
    const numbers = await testDb.select().from(smsNumbers).where(eq(smsNumbers.e164, TO));
    expect(numbers).toHaveLength(1);
    expect(numbers[0].label).toBe("auto (webhook entrant)");

    const convs = await testDb.select().from(conversations);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      clientId: client.id,
      clientPhone: FROM,
      smsNumberId: numbers[0].id,
      needsAttention: true,
      attentionReason: "inbound",
    });
    expect(convs[0].lastInboundAt).toBeInstanceOf(Date);

    const rows = await testDb.select().from(messages).where(eq(messages.twilioSid, SID));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: convs[0].id,
      direction: "in",
      body: "Bonjour, ici Marie. Toujours possible de se parler ?",
      status: "received",
      source: "human",
      segments: 1,
      encoding: "GSM-7",
    });
  });

  it("est idempotent : le même MessageSid relivré donne UNE rangée et UNE notification", async () => {
    const admin = await makeUser({ role: "admin", locale: "fr" });
    await makeClient({ phone: FROM });
    await makeSmsNumber({ e164: TO });

    const first = await POST(inboundRequest(inboundForm()));
    const second = await POST(inboundRequest(inboundForm()));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await testDb.select().from(messages)).toHaveLength(1);
    expect(await testDb.select().from(conversations)).toHaveLength(1);

    const notifs = await testDb.select().from(notifications);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].userId).toBe(admin.id);
  });

  it("§21 — RAFALE : trois entrants en quatre secondes ne programment QU'UN tour", async () => {
    await makeUser({ role: "admin", locale: "fr" });
    const client = await makeClient({ phone: FROM });
    await makeSmsNumber({ e164: TO });
    // Un assistant actif sur la conversation : sans lui, aucun tour n'est
    // programme (le runtime sortirait de toute facon).
    const [assistant] = await testDb
      .insert(assistants)
      .values({
        name: "Assistant rafale",
        identity: {},
        goal: { primary: { type: "qualify_only" }, fallbacks: [] },
        approach: {},
        model: {},
      })
      .returning();

    // Premier message : cree la conversation, puis on y attache l'assistant.
    await POST(inboundRequest(inboundForm({ MessageSid: SID + "a", Body: "Allo" })));
    const [conv] = await testDb.select().from(conversations);
    await testDb
      .update(conversations)
      .set({ activeAssistantId: assistant.id })
      .where(eq(conversations.id, conv.id));

    // Deux autres dans la foulee.
    await POST(inboundRequest(inboundForm({ MessageSid: SID + "b", Body: "c'est Marie" })));
    await POST(inboundRequest(inboundForm({ MessageSid: SID + "c", Body: "je veux vendre" })));

    // Trois messages recus…
    expect(await testDb.select().from(messages)).toHaveLength(3);
    // …mais UN SEUL job de tour : la cle de dedoublonnage `turn:<id>` a
    // repousse le meme job au lieu d'en creer trois.
    const turns = (await testDb.select().from(scheduledJobs)).filter((j) => j.type === "agent_turn");
    expect(turns).toHaveLength(1);
    expect(turns[0].dedupeKey).toBe(`turn:${conv.id}`);
  });

  it("un fil en pause (ai_enabled=false) ne programme AUCUN tour", async () => {
    await makeUser({ role: "admin", locale: "fr" });
    await makeClient({ phone: FROM });
    await makeSmsNumber({ e164: TO });
    const [assistant] = await testDb
      .insert(assistants)
      .values({
        name: "Assistant en pause",
        identity: {},
        goal: { primary: { type: "qualify_only" }, fallbacks: [] },
        approach: {},
        model: {},
      })
      .returning();

    await POST(inboundRequest(inboundForm({ MessageSid: SID + "d", Body: "Allo" })));
    const [conv] = await testDb.select().from(conversations);
    await testDb
      .update(conversations)
      .set({ activeAssistantId: assistant.id, aiEnabled: false })
      .where(eq(conversations.id, conv.id));

    await POST(inboundRequest(inboundForm({ MessageSid: SID + "e", Body: "encore la?" })));

    const turns = (await testDb.select().from(scheduledJobs)).filter((j) => j.type === "agent_turn");
    expect(turns).toHaveLength(0);
  });

  it("une relivraison ne re-signale pas une conversation qu'un humain a traitée", async () => {
    await makeUser({ role: "admin", locale: "fr" });
    await makeClient({ phone: FROM });
    await makeSmsNumber({ e164: TO });

    await POST(inboundRequest(inboundForm()));

    // Un humain traite la conversation…
    const [conv] = await testDb.select().from(conversations);
    await testDb
      .update(conversations)
      .set({ needsAttention: false, attentionReason: null })
      .where(eq(conversations.id, conv.id));

    // …puis Twilio relivre le même MessageSid : rien ne doit se re-signaler.
    await POST(inboundRequest(inboundForm()));
    const [after] = await testDb.select().from(conversations);
    expect(after.needsAttention).toBe(false);
    expect(after.attentionReason).toBeNull();
  });

  it("STOP : supprime le numéro, révoque le consentement SMS et garde le message", async () => {
    const client = await makeClient({ phone: FROM });
    await makeSmsNumber({ e164: TO });
    const [consent] = await testDb
      .insert(consents)
      .values({
        clientId: client.id,
        channel: "sms",
        kind: "implied_inquiry",
        source: "test",
      })
      .returning();
    expect(consent.revokedAt).toBeNull();

    const res = await POST(inboundRequest(inboundForm({ Body: "STOP" })));
    expect(res.status).toBe(200);

    const sup = await testDb.select().from(suppressions);
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ phoneE164: FROM, reason: "sms_stop", note: "STOP" });

    const [revoked] = await testDb.select().from(consents).where(eq(consents.id, consent.id));
    expect(revoked.revokedAt).toBeInstanceOf(Date);

    // Le registre garde la trace du STOP lui-même.
    const rows = await testDb.select().from(messages).where(eq(messages.twilioSid, SID));
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("STOP");

    const [conv] = await testDb.select().from(conversations);
    expect(conv).toMatchObject({ needsAttention: true, attentionReason: "optout" });

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "sms.optout"));
    expect(logs).toHaveLength(1);
    expect(logs[0].entityId).toBe(client.id);
  });

  it("numéro inconnu : répond 200, ne crée AUCUN client ni conversation, et trace", async () => {
    await makeClient({ phone: "+15145550199" }); // un autre client, non correspondant
    await makeSmsNumber({ e164: TO });

    const res = await POST(inboundRequest(inboundForm({ From: "+14185550111" })));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");

    expect(await testDb.select().from(conversations)).toHaveLength(0);
    expect(await testDb.select().from(messages)).toHaveLength(0);

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "sms.inbound_unmatched"));
    expect(logs).toHaveLength(1);
    // Numéro masqué dans l'audit : jamais le E.164 complet.
    expect(logs[0].detail).toMatchObject({ from: "…0111", messageSid: SID });
  });

  it("notifie l'assigné de la fiche (et pas les admins) dans SA langue", async () => {
    await makeUser({ role: "admin", locale: "fr", name: "Patron" });
    const caller = await makeUser({ role: "caller", locale: "fr", name: "Téléphoniste" });
    const client = await makeClient({
      fullName: "Marie Tremblay",
      phone: FROM,
      assignedToId: caller.id,
    });
    await makeSmsNumber({ e164: TO });

    const res = await POST(inboundRequest(inboundForm()));
    expect(res.status).toBe(200);

    const notifs = await testDb
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, caller.id), eq(notifications.type, "sms_inbound")));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].title).toBe("Nouveau texto");
    expect(notifs[0].body).toBe("Vous avez reçu un texto de Marie Tremblay");
    expect(notifs[0].link).toBe(`/clients/${client.id}`);

    // L'assigné existe : les admins ne sont PAS doublés.
    expect(await testDb.select().from(notifications)).toHaveLength(1);
  });
});
