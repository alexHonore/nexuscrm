/**
 * Intégration — consommation IA + SMS (module `getConsumption` et la route).
 *
 *  · IA : coût et jetons RÉELS, sommés des traces de tour, par modèle, bornés à
 *    la période (heure de Toronto).
 *  · SMS : segments comptés — seulement les sortants réellement partis chez
 *    Twilio (twilio_sid posé) — et une estimation = segments × taux réglé.
 *  · Route : RBAC, plage validée, réglage du taux.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { closeDb, makeClient, makeConversation, makeSmsNumber, makeUser, resetDb, testDb } from "./helpers/db";
import { agentTurnTraces, messages } from "@/db/schema-sms";

const CTX = vi.hoisted(() => ({ jar: new Map<string, string>(), hdrs: new Headers(), twilioCost: null as null | { costUsd: number; priceUnit: string } }));
vi.mock("server-only", () => ({}));
// Twilio Usage Records : mocké — on ne tape pas le réseau. `twilioCost` null =
// Twilio indisponible → l'estimation par segments s'applique.
vi.mock("@/lib/sms-server/twilio-usage", () => ({
  getTwilioSmsCost: async () => CTX.twilioCost,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (CTX.jar.has(n) ? { name: n, value: CTX.jar.get(n)! } : undefined),
    set: (n: string, v: string) => void CTX.jar.set(n, v),
    delete: (n: string) => void CTX.jar.delete(n),
  }),
  headers: async () => CTX.hdrs,
}));

const { getConsumption } = await import("@/lib/consumption");
const { getSetting } = await import("@/lib/settings");
const { GET, PATCH } = await import("@/app/api/admin/consumption/route");
const { NextRequest } = await import("next/server");

async function login(role: "admin" | "caller") {
  const user = await makeUser({ role });
  const token = await new SignJWT({ uid: user.id, role, tv: user.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
  return user;
}

const IN = new Date("2026-08-15T12:00:00.000Z"); // dans la période
const OUT = new Date("2026-07-31T12:00:00.000Z"); // avant la période
const FROM = "2026-08-01";
const TO = "2026-08-31";

async function seedTraces(conversationId: string) {
  const base = {
    conversationId,
    systemPrompt: "S",
    provider: "openrouter",
    outcome: "sent",
  };
  await testDb.insert(agentTurnTraces).values([
    { ...base, modelRequested: "claude-sonnet-5", tokensIn: 100, tokensOut: 50, costUsd: "0.01000", createdAt: IN },
    { ...base, modelRequested: "claude-sonnet-5", tokensIn: 200, tokensOut: 80, costUsd: "0.02000", createdAt: IN },
    // modelServed prime sur modelRequested pour le regroupement.
    { ...base, modelRequested: "auto", modelServed: "gpt-4o-mini", tokensIn: 40, tokensOut: 20, costUsd: "0.00500", createdAt: IN },
    // Hors période : ignoré.
    { ...base, modelRequested: "claude-sonnet-5", tokensIn: 999, tokensOut: 999, costUsd: "9.99999", createdAt: OUT },
  ]);
}

async function seedMessages(conversationId: string) {
  const rows: (typeof messages.$inferInsert)[] = [
    { conversationId, direction: "out", body: "a", source: "agent", twilioSid: "SM1", segments: 2, createdAt: IN },
    { conversationId, direction: "out", body: "b", source: "agent", twilioSid: "SM2", segments: 1, createdAt: IN },
    // Sauté avant l'envoi (pas de twilio_sid) : NON facturé, exclu.
    { conversationId, direction: "out", body: "c", source: "agent", segments: 3, skipReason: "suppressed", createdAt: IN },
    // Entrant.
    { conversationId, direction: "in", body: "d", source: "human", twilioSid: "SM3", segments: 1, createdAt: IN },
    // Sortant hors période : exclu.
    { conversationId, direction: "out", body: "e", source: "agent", twilioSid: "SM4", segments: 5, createdAt: OUT },
  ];
  await testDb.insert(messages).values(rows);
}

async function scene() {
  const client = await makeClient();
  const number = await makeSmsNumber();
  const conv = await makeConversation({ clientId: client.id, smsNumberId: number.id, clientPhone: client.phone });
  await seedTraces(conv.id);
  await seedMessages(conv.id);
  return { conv, client };
}

describe("getConsumption", () => {
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
    CTX.twilioCost = null;
  });

  it("IA : somme le coût et les jetons RÉELS par modèle, dans la période", async () => {
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.ai.turns).toBe(3); // l'hors-période est exclu
    expect(r.ai.tokensIn).toBe(340);
    expect(r.ai.tokensOut).toBe(150);
    expect(r.ai.costUsd).toBeCloseTo(0.035, 5);
    // Deux modèles ; sonnet (2 tours, 0,03) avant gpt (1 tour, 0,005).
    expect(r.ai.byModel.map((m) => m.model)).toEqual(["claude-sonnet-5", "gpt-4o-mini"]);
    expect(r.ai.byModel[0].turns).toBe(2);
    expect(r.ai.byModel[0].costUsd).toBeCloseTo(0.03, 5);
  });

  it("SMS : compte les segments facturés ; sans Twilio, le coût est une ESTIMATION", async () => {
    CTX.twilioCost = null; // Twilio indisponible
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.sms.outboundMessages).toBe(2); // le « sauté » sans sid est exclu
    expect(r.sms.outboundSegments).toBe(3); // 2 + 1 (pas le 3 du sauté)
    expect(r.sms.inboundMessages).toBe(1);
    expect(r.sms.inboundSegments).toBe(1);
    expect(r.sms.segmentCostUsd).toBeCloseTo(0.0079, 6);
    expect(r.sms.estimatedCostUsd).toBeCloseTo(4 * 0.0079, 6);
    // Repli : source « estimate », coût = estimation, pas de réel.
    expect(r.sms.costSource).toBe("estimate");
    expect(r.sms.realCostUsd).toBeNull();
    expect(r.sms.costUsd).toBeCloseTo(4 * 0.0079, 6);
  });

  it("SMS : quand Twilio répond, c'est le coût RÉEL facturé qui prime", async () => {
    CTX.twilioCost = { costUsd: 1.23, priceUnit: "usd" };
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.sms.costSource).toBe("twilio");
    expect(r.sms.realCostUsd).toBeCloseTo(1.23, 6);
    expect(r.sms.costUsd).toBeCloseTo(1.23, 6); // pas l'estimation
    // Les segments comptés restent visibles à titre d'information.
    expect(r.sms.outboundSegments).toBe(3);
  });

  it("période vide : tout à zéro, pas de plantage", async () => {
    const r = await getConsumption("2020-01-01", "2020-01-31");
    expect(r.ai.turns).toBe(0);
    expect(r.ai.costUsd).toBe(0);
    expect(r.sms.outboundSegments).toBe(0);
    expect(r.sms.estimatedCostUsd).toBe(0);
  });
});

describe("route /api/admin/consumption", () => {
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
    CTX.twilioCost = null;
  });
  afterAll(closeDb);

  const url = (from: string, to: string) =>
    new NextRequest(`http://x/api/admin/consumption?from=${from}&to=${to}`);

  it("GET : admin obtient le rapport, plage invalide 422", async () => {
    await login("admin");
    await scene();
    const ok = await GET(url(FROM, TO));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ai.turns).toBe(3);
    expect(body.sms.outboundSegments).toBe(3);

    const bad = await GET(url("pas-une-date", TO));
    expect(bad.status).toBe(422);
    // Date de FORME valide mais impossible (mois 13) : 422, pas un 500.
    const impossible = await GET(url("2026-13-01", "2026-13-01"));
    expect(impossible.status).toBe(422);
  });

  it("GET : téléphoniste 403, anonyme 401", async () => {
    const anon = await GET(url(FROM, TO));
    expect(anon.status).toBe(401);
    await login("caller");
    const denied = await GET(url(FROM, TO));
    expect(denied.status).toBe(403);
  });

  it("PATCH : règle le taux d'estimation SMS et le persiste", async () => {
    await login("admin");
    const res = await PATCH(
      new NextRequest("http://x/api/admin/consumption", {
        method: "PATCH",
        body: JSON.stringify({ smsSegmentCostUsd: 0.02 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect((await getSetting("consumption")).smsSegmentCostUsd).toBeCloseTo(0.02, 6);
    // Et l'estimation reflète le nouveau taux.
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.sms.estimatedCostUsd).toBeCloseTo(4 * 0.02, 6);
  });

  it("PATCH : téléphoniste 403, taux négatif 422", async () => {
    await login("caller");
    const denied = await PATCH(
      new NextRequest("http://x/api/admin/consumption", {
        method: "PATCH",
        body: JSON.stringify({ smsSegmentCostUsd: 0.01 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(denied.status).toBe(403);
    await login("admin");
    const bad = await PATCH(
      new NextRequest("http://x/api/admin/consumption", {
        method: "PATCH",
        body: JSON.stringify({ smsSegmentCostUsd: -1 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(bad.status).toBe(422);
  });
});
