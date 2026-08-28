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

const CTX = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  hdrs: new Headers(),
  twilioCost: null as null | { costUsd: number; priceUnit: string },
  twilioBalance: null as null | { balanceUsd: number; currency: string; authKind: "apiKey" },
  twilioDaily: null as null | Record<string, { date: string; costUsd: number; messages: number }[]>,
  openrouterAccount: null as null | { totalUsageUsd: number; totalCreditsUsd: number },
}));
vi.mock("server-only", () => ({}));
// Twilio Usage Records : mocké — on ne tape pas le réseau. `twilioCost` null =
// Twilio indisponible → l'estimation par segments s'applique.
vi.mock("@/lib/sms-server/twilio-usage", () => ({
  getTwilioSmsCost: async () => CTX.twilioCost,
  // Solde du compte et journées facturées : même règle — `null` veut dire
  // « Twilio n'a pas répondu », et le rapport doit rester complet sans eux.
  getTwilioBalance: async () => CTX.twilioBalance,
  // Une catégorie ABSENTE de la table du scénario vaut « Twilio n'a pas
  // répondu » (null), pas « aucune journée facturée » ([]) : c'est justement la
  // distinction que le rapport doit préserver.
  getTwilioDailySmsUsage: async (_from: string, _to: string, category: string) =>
    CTX.twilioDaily === null ? null : (CTX.twilioDaily[category] ?? null),
}));
// L'ancre du compte OpenRouter : mockée — on ne tape pas le réseau. null =
// clé absente ou API injoignable, le rapport doit rester complet sans elle.
vi.mock("@/lib/llm-server/openrouter-usage", () => ({
  getOpenRouterAccountUsage: async () => CTX.openrouterAccount,
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
    CTX.twilioBalance = null;
    CTX.twilioDaily = null;
    CTX.openrouterAccount = null;
  });

  it("IA : l'ancre du COMPTE OpenRouter accompagne la somme des traces", async () => {
    // La somme des traces a une histoire (sous-comptage d'avant le correctif) ;
    // le chiffre du fournisseur, lui, ne dépend pas de notre comptage.
    CTX.openrouterAccount = { totalUsageUsd: 7.14, totalCreditsUsd: 15 };
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.ai.account).toEqual({ totalUsageUsd: 7.14, totalCreditsUsd: 15 });
  });

  it("IA : sans clé OpenRouter, l'ancre est null — jamais un zéro qui ment", async () => {
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.ai.account).toBeNull();
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

  // ══ Jour par jour ═════════════════════════════════════════════════════════

  it("jour par jour : une ligne PAR JOUR de la période, trous remplis à 0", async () => {
    // Les journées creuses doivent exister : sans elles, l'axe du temps saute
    // des jours et le graphique ment sur la forme de la dépense.
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.ai.daily).toHaveLength(31);
    expect(r.transcripts.daily).toHaveLength(31);
    expect(r.sms.dailyVolume).toHaveLength(31);
    expect(r.ai.daily[0]).toEqual({ date: "2026-08-01", costUsd: 0 });
    expect(r.ai.daily.at(-1)?.date).toBe("2026-08-31");

    // La somme des journées égale le total de la période — sinon le graphique
    // et le grand chiffre raconteraient deux histoires.
    const sum = r.ai.daily.reduce((acc, d) => acc + d.costUsd, 0);
    expect(sum).toBeCloseTo(r.ai.costUsd, 6);

    // Le 15 août (heure de Toronto) porte les trois traces de la scène.
    const day = r.ai.daily.find((d) => d.date === "2026-08-15");
    expect(day?.costUsd).toBeCloseTo(0.035, 6);

    // Volume SMS : segments comptés le bon jour, jamais convertis en argent.
    const smsDay = r.sms.dailyVolume.find((d) => d.date === "2026-08-15");
    expect(smsDay).toMatchObject({ outboundSegments: 3, inboundSegments: 1, outboundMessages: 2 });
  });

  it("Twilio muet : dépense quotidienne et solde à NULL, jamais des zéros", async () => {
    // « Indisponible » et « rien dépensé » sont deux nouvelles opposées sur une
    // page d'argent : le rapport doit permettre de les distinguer.
    CTX.twilioDaily = null;
    CTX.twilioBalance = null;
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.sms.dailyCost).toBeNull();
    expect(r.sms.carrierFeesUsd).toBeNull();
    expect(r.sms.balance).toBeNull();
    // Le volume, lui, vient de NOTRE base : il reste connu.
    expect(r.sms.dailyVolume).toHaveLength(31);
  });

  it("Twilio répond : frais de transporteur À PART, et journées GMT additionnées", async () => {
    // La catégorie `sms` n'inclut PAS les frais de transporteur : les fondre
    // dans le coût des messages changerait en silence un chiffre déjà lu.
    CTX.twilioCost = { costUsd: 1.23, priceUnit: "usd" };
    CTX.twilioDaily = {
      sms: [{ date: "2026-08-15", costUsd: 1.23, messages: 3 }],
      "sms-messages-carrierfees": [{ date: "2026-08-15", costUsd: 0.09, messages: 0 }],
    };
    CTX.twilioBalance = { balanceUsd: 12.29, currency: "USD", authKind: "apiKey" };
    await scene();
    const r = await getConsumption(FROM, TO);

    expect(r.sms.costUsd).toBeCloseTo(1.23, 6); // les MESSAGES seuls
    expect(r.sms.carrierFeesUsd).toBeCloseTo(0.09, 6); // les frais, à part
    expect(r.sms.balance).toEqual({ balanceUsd: 12.29, currency: "USD" });

    expect(r.sms.dailyCost).toHaveLength(31);
    const day = r.sms.dailyCost?.find((d) => d.date === "2026-08-15");
    // La journée porte messages + frais : c'est la dépense Twilio de ce jour.
    expect(day?.costUsd).toBeCloseTo(1.32, 6);
    const total = r.sms.dailyCost?.reduce((acc, d) => acc + d.costUsd, 0) ?? 0;
    expect(total).toBeCloseTo(1.32, 6);
  });

  it("une seule catégorie Twilio répond : la série quotidienne est INCONNUE", async () => {
    // Une série bâtie sur les seuls messages serait courte des frais sans le
    // dire — et l'écran s'en sert aussi pour le montant de la période. Tant
    // qu'il manque une catégorie, la réponse honnête est « on ne sait pas ».
    CTX.twilioCost = { costUsd: 1.23, priceUnit: "usd" };
    CTX.twilioDaily = { sms: [{ date: "2026-08-15", costUsd: 1.23, messages: 3 }] };
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.sms.dailyCost).toBeNull();
    expect(r.sms.carrierFeesUsd).toBeNull();
    // Le coût de la période, lui, reste connu : c'est le DÉTAIL qui manque.
    expect(r.sms.costUsd).toBeCloseTo(1.23, 6);
  });

  it("solde Twilio NÉGATIF : conservé tel quel (c'est la panne, pas son approche)", async () => {
    CTX.twilioBalance = { balanceUsd: -3.41, currency: "USD", authKind: "apiKey" };
    await scene();
    const r = await getConsumption(FROM, TO);
    expect(r.sms.balance?.balanceUsd).toBeCloseTo(-3.41, 6);
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
