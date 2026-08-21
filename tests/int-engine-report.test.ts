/**
 * Intégration — bilan du moteur.
 *
 * Le principe à tenir : les désabonnements comptent AUTANT que les réponses, et
 * ce qui n'est pas parti autant que ce qui est parti. Un bilan qui n'affiche
 * que les succès laisse conclure l'inverse de la réalité.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeClient, makeConversation, makeSmsNumber, makeUser, resetDb, testDb } from "./helpers/db";
import { agentTurnTraces, assistants, campaignEnrollments, campaigns, messages, suppressions } from "@/db/schema-sms";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { engineSummary, perAssistant, perCampaign } = await import("@/lib/golive-server/reporting");

const NOW = new Date("2026-08-21T15:00:00Z");
const recent = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000);

let numberId: string;
let conversationId: string;
let assistantId: string;

beforeEach(async () => {
  await resetDb();
  await makeUser({ role: "admin" });
  numberId = (await makeSmsNumber()).id;
  const client = await makeClient();
  conversationId = (
    await makeConversation({ clientId: client.id, clientPhone: client.phone, smsNumberId: numberId })
  ).id;
  const [a] = await testDb
    .insert(assistants)
    // Brouillon : la porte d'activation refuse — à raison — un assistant
    // « actif » sans prompt compilé. Le bilan ne dépend pas du statut.
    .values({
      name: "Acheteur FB", status: "draft",
      identity: {}, goal: { primary: { type: "qualify_only" }, fallbacks: [] },
      approach: {}, model: {},
    })
    .returning();
  assistantId = a.id;
});

afterAll(async () => {
  await closeDb();
});

describe("résumé", () => {
  it("compte les envois, les LIVRAISONS et les ÉCHECS séparément", async () => {
    await testDb.insert(messages).values([
      { conversationId, direction: "out", body: "a", source: "ladder", status: "delivered", createdAt: recent(2) },
      { conversationId, direction: "out", body: "b", source: "agent", status: "sent", createdAt: recent(2) },
      { conversationId, direction: "out", body: "c", source: "agent", status: "failed", errorCode: 30007, createdAt: recent(1) },
      { conversationId, direction: "in", body: "oui", source: "human", status: "received", createdAt: recent(1) },
    ]);

    const s = await engineSummary(30, NOW);
    expect(s.outbound).toBe(3);
    expect(s.delivered).toBe(1);
    // « sent » veut dire accepté par l'opérateur, PAS remis : le confondre avec
    // « livré » gonflerait le taux de livraison.
    expect(s.failed).toBe(1);
    expect(s.inbound).toBe(1);
    expect(s.conversationsWithReply).toBe(1);
  });

  it("les désabonnements sont comptés sur la période", async () => {
    await testDb.insert(suppressions).values([
      { phoneE164: "+14185550001", reason: "sms_stop", createdAt: recent(5) },
      // Un désabonnement ancien compte dans le total, pas dans la période.
      { phoneE164: "+14185550002", reason: "sms_stop", createdAt: new Date("2026-01-01T00:00:00Z") },
      // Une suppression pour erreur opérateur n'est PAS un désabonnement.
      { phoneE164: "+14185550003", reason: "carrier_error", createdAt: recent(5) },
    ]);

    const s = await engineSummary(30, NOW);
    expect(s.optOuts).toBe(1);
    expect(s.suppressedTotal).toBe(3);
  });

  it("les issues des tours et le coût viennent des traces", async () => {
    await testDb.insert(agentTurnTraces).values([
      { conversationId, assistantId, systemPrompt: "p", provider: "openrouter", modelRequested: "m", outcome: "sent", costUsd: "0.00120", createdAt: recent(2) },
      { conversationId, assistantId, systemPrompt: "p", provider: "openrouter", modelRequested: "m", outcome: "blocked", costUsd: "0.00080", createdAt: recent(2) },
      { conversationId, assistantId, systemPrompt: "p", provider: "openrouter", modelRequested: "m", outcome: "handoff", costUsd: "0.00050", createdAt: recent(1) },
    ]);

    const s = await engineSummary(30, NOW);
    expect(s.agentTurns).toBe(3);
    expect(s.handoffs).toBe(1);
    expect(s.blockedDrafts).toBe(1);
    // Le coût vient des traces, jamais d'une estimation maison.
    expect(s.costUsd).toBeCloseTo(0.0025, 5);
  });

  it("la fenêtre exclut ce qui est hors période", async () => {
    await testDb.insert(messages).values({
      conversationId, direction: "out", body: "vieux", source: "agent",
      status: "delivered", createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect((await engineSummary(30, NOW)).outbound).toBe(0);
    expect((await engineSummary(365, NOW)).outbound).toBe(1);
  });

  it("une base vide ne renvoie ni NaN ni null", async () => {
    const s = await engineSummary(30, NOW);
    expect(s.outbound).toBe(0);
    expect(s.costUsd).toBe(0);
  });
});

describe("par assistant", () => {
  it("un assistant sans aucun tour apparaît quand même, à zéro", async () => {
    // Le faire disparaître donnerait l'illusion qu'il n'existe pas, alors
    // qu'un assistant actif et muet est précisément ce qu'on veut voir.
    const rows = await perAssistant(30, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Acheteur FB", turns: 0, costUsd: 0 });
  });

  it("les issues sont ventilées par assistant", async () => {
    await testDb.insert(agentTurnTraces).values([
      { conversationId, assistantId, systemPrompt: "p", provider: "openrouter", modelRequested: "m", outcome: "sent", costUsd: "0.001", createdAt: recent(1) },
      { conversationId, assistantId, systemPrompt: "p", provider: "openrouter", modelRequested: "m", outcome: "sent", costUsd: "0.001", createdAt: recent(1) },
      { conversationId, assistantId, systemPrompt: "p", provider: "openrouter", modelRequested: "m", outcome: "blocked", costUsd: "0.001", createdAt: recent(1) },
    ]);
    const [row] = await perAssistant(30, NOW);
    expect(row.turns).toBe(3);
    expect(row.sent).toBe(2);
    expect(row.blocked).toBe(1);
    expect(row.costUsd).toBeCloseTo(0.003, 5);
  });
});

describe("par campagne", () => {
  it("le taux d'arrêt est calculé À CÔTÉ du taux de réponse", async () => {
    const [campaign] = await testDb
      .insert(campaigns)
      .values({ name: "Réactivation", status: "active", trigger: { kind: "manual" }, ladder: [] })
      .returning();

    const clients = [];
    for (let i = 0; i < 10; i += 1) clients.push(await makeClient());
    await testDb.insert(campaignEnrollments).values(
      clients.map((c, i) => ({
        campaignId: campaign.id,
        clientId: c.id,
        status: (i < 3 ? "replied" : i < 4 ? "stopped" : "active") as
          | "replied" | "stopped" | "active",
      })),
    );

    const [row] = await perCampaign();
    expect(row.enrolled).toBe(10);
    expect(row.replyRate).toBe(30);
    // 1 arrêt sur 10 : un bon taux de réponse ne l'efface pas.
    expect(row.stopRate).toBe(10);
  });

  it("une campagne sans inscrit rend 0, pas NaN", async () => {
    await testDb
      .insert(campaigns)
      .values({ name: "Vide", status: "draft", trigger: { kind: "manual" }, ladder: [] });
    const [row] = await perCampaign();
    expect(row.replyRate).toBe(0);
    expect(row.stopRate).toBe(0);
  });
});
