/**
 * Intégration — statut de livraison SMS : POST /api/webhooks/twilio/status
 *
 * On exerce le vrai handler exporté avec de vraies `NextRequest` signées
 * (HMAC-SHA1, spec Twilio), sur la base de test locale. Aucun accès réseau.
 */
import { createHmac } from "crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  resetDb,
  testDb,
} from "./helpers/db";
import { auditLogs } from "@/db/schema";
import { messages, suppressions } from "@/db/schema-sms";

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

process.env.TWILIO_AUTH_TOKEN = "test_twilio_token";

const { POST } = await import("@/app/api/webhooks/twilio/status/route");

// La route valide la signature sur l'URL publique (NEXT_PUBLIC_APP_URL) — on
// signe exactement la même, sinon 403 (dans .env.test le port n'est pas 3000).
const URL_STATUS = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/twilio/status`;
const SID = "SM00000000000000000000000000000001";

/** Signature Twilio : base64(HMAC-SHA1(url + params POST triés, authToken)). */
function twilioSignature(url: string, params: URLSearchParams): string {
  const data =
    url +
    [...params.keys()]
      .sort()
      .map((k) => k + (params.get(k) ?? ""))
      .join("");
  return createHmac("sha1", process.env.TWILIO_AUTH_TOKEN!)
    .update(data, "utf8")
    .digest("base64");
}

function statusRequest(
  form: Record<string, string>,
  { signature }: { signature?: string } = {},
): NextRequest {
  const params = new URLSearchParams(form);
  return new NextRequest(URL_STATUS, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ?? twilioSignature(URL_STATUS, params),
    },
    body: params.toString(),
  });
}

/** Client + ligne SMS + conversation + un message sortant déjà accepté par Twilio. */
async function seedMessage(overrides: Partial<typeof messages.$inferInsert> = {}) {
  const client = await makeClient({ phone: "+15145550101" });
  const number = await makeSmsNumber();
  const conversation = await makeConversation({
    clientId: client.id,
    smsNumberId: number.id,
    clientPhone: client.phone,
  });
  const [message] = await testDb
    .insert(messages)
    .values({
      conversationId: conversation.id,
      direction: "out",
      body: "Bonjour, ici Groupe Nexus.",
      twilioSid: SID,
      status: "queued",
      source: "human",
      ...overrides,
    })
    .returning();
  return { client, number, conversation, message };
}

describe("POST /api/webhooks/twilio/status", () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  it("refuse (403) une signature invalide sans toucher au message", async () => {
    await seedMessage();
    const res = await POST(
      statusRequest(
        { MessageSid: SID, MessageStatus: "delivered" },
        { signature: "pas-la-bonne-signature" },
      ),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "invalid_signature" });

    const [row] = await testDb.select().from(messages).where(eq(messages.twilioSid, SID));
    expect(row.status).toBe("queued");
  });

  it("journalise le rejet : une rangée d'audit avec le chemin et les URL candidates", async () => {
    // La panne d'origine : des rappels rejetés en silence, 44 messages
    // « En file » sans aucune trace. Le rejet doit maintenant laisser une
    // rangée d'audit PROPRE À CETTE ROUTE (fenêtre par chemin — un déluge de
    // rejets entrants ne doit pas la masquer), avec les URL essayées.
    await seedMessage();
    const res = await POST(
      statusRequest(
        { MessageSid: SID, MessageStatus: "delivered" },
        { signature: "pas-la-bonne-signature" },
      ),
    );
    expect(res.status).toBe(403);

    const rows = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "sms.webhook_invalid_signature"));
    expect(rows).toHaveLength(1);
    const detail = rows[0].detail as { path: string; hasToken: boolean; candidates: string[] };
    expect(detail.path).toBe("/api/webhooks/twilio/status");
    expect(detail.hasToken).toBe(true);
    expect(detail.candidates).toContain(URL_STATUS);

    // Rafale : une seule rangée par fenêtre de 10 minutes.
    await POST(
      statusRequest(
        { MessageSid: SID, MessageStatus: "delivered" },
        { signature: "toujours-pas" },
      ),
    );
    expect(
      await testDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "sms.webhook_invalid_signature")),
    ).toHaveLength(1);
  });

  it("refuse (400) un corps sans MessageSid", async () => {
    const res = await POST(statusRequest({ MessageStatus: "delivered" }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_body" });
  });

  it("reporte un statut delivered sur la rangée du message", async () => {
    const { message } = await seedMessage();

    const res = await POST(statusRequest({ MessageSid: SID, MessageStatus: "delivered" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.status).toBe("delivered");
    expect(row.errorCode).toBeNull();
  });

  it("est idempotent : le même rappel relivré deux fois donne le même état final", async () => {
    const { message } = await seedMessage();
    const form = { MessageSid: SID, MessageStatus: "delivered" };

    const first = await POST(statusRequest(form));
    const second = await POST(statusRequest(form));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const all = await testDb.select().from(messages);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(message.id);
    expect(all[0].status).toBe("delivered");
    expect(all[0].errorCode).toBeNull();
  });

  it("supprime le numéro (carrier_error) sur un échec permanent 30003", async () => {
    const { message } = await seedMessage();

    const res = await POST(
      statusRequest({
        MessageSid: SID,
        MessageStatus: "undelivered",
        ErrorCode: "30003",
        To: "+15145550101",
      }),
    );
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.status).toBe("undelivered");
    expect(row.errorCode).toBe(30003);

    const sup = await testDb.select().from(suppressions);
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({
      phoneE164: "+15145550101",
      reason: "carrier_error",
      note: "code 30003",
    });

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "sms.carrier_suppression"));
    expect(logs).toHaveLength(1);
    // Masqué : audit_logs n'a pas de chemin de purge, le numéro complet vit
    // dans la rangée suppressions.
    expect(logs[0].entityId).toBe("…0101");
  });

  it("ne régresse jamais le statut : un « sent » tardif n'écrase pas un échec consigné", async () => {
    const { message } = await seedMessage();

    const fail = await POST(
      statusRequest({
        MessageSid: SID,
        MessageStatus: "undelivered",
        ErrorCode: "30003",
        To: "+15145550101",
      }),
    );
    expect(fail.status).toBe(200);

    // Rappel en désordre (ou doublon tardif) : sent < undelivered.
    const late = await POST(statusRequest({ MessageSid: SID, MessageStatus: "sent" }));
    expect(late.status).toBe(200);

    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.status).toBe("undelivered");
    expect(row.errorCode).toBe(30003);
  });

  it("neutralise ErrorCode vide ou « 0 » (aucune erreur consignée)", async () => {
    const { message } = await seedMessage();

    const res = await POST(
      statusRequest({ MessageSid: SID, MessageStatus: "sent", ErrorCode: "" }),
    );
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.status).toBe("sent");
    expect(row.errorCode).toBeNull();

    const sup = await testDb.select().from(suppressions);
    expect(sup).toHaveLength(0);
  });

  it("répond 200 { ok: true } pour un MessageSid inconnu (Twilio ne doit pas retenter)", async () => {
    const res = await POST(
      statusRequest({
        MessageSid: "SMinconnu000000000000000000000000",
        MessageStatus: "delivered",
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "sms.status_unknown_sid"));
    expect(logs).toHaveLength(1);
    expect(logs[0].detail).toMatchObject({
      messageSid: "SMinconnu000000000000000000000000",
      messageStatus: "delivered",
    });
  });

  it("ne supprime PAS le numéro sur un échec transitoire 30008", async () => {
    const { message } = await seedMessage();

    const res = await POST(
      statusRequest({
        MessageSid: SID,
        MessageStatus: "undelivered",
        ErrorCode: "30008",
        To: "+15145550101",
      }),
    );
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(messages).where(eq(messages.id, message.id));
    expect(row.status).toBe("undelivered");
    expect(row.errorCode).toBe(30008);
    expect(await testDb.select().from(suppressions)).toHaveLength(0);
  });
});
