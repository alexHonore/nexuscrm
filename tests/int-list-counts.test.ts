/**
 * Intégration — les compteurs des listes disent la vérité.
 *
 * Dans la liste des champs d'un select, drizzle rend `${table.id}` sans
 * qualificateur ; une sous-requête corrélée le résolvait sur SA table et
 * chaque campagne affichait « 0 inscrit » quelle que soit la base. Ces tests
 * comparent l'écran à la base.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeClient, makeConversation, makeSmsNumber, resetDb, testDb } from "./helpers/db";
import { assistants, campaignEnrollments, campaigns, messages } from "@/db/schema-sms";

vi.mock("server-only", () => ({}));
const { listCampaignsWithCounts } = await import("@/lib/campaigns-server/list");
const { listAssistantsWithCounts } = await import("@/lib/assistants/list");

afterAll(closeDb);

describe("compteurs de liste", () => {
  beforeEach(resetDb);

  it("campagnes : inscrits / en cours / réponses / arrêts viennent des VRAIES inscriptions", async () => {
    const [a] = await testDb.insert(campaigns).values({ name: "A", trigger: { kind: "manual" } }).returning();
    const [b] = await testDb.insert(campaigns).values({ name: "B", trigger: { kind: "manual" } }).returning();
    const c1 = await makeClient({ phone: "+15145550191" });
    const c2 = await makeClient({ phone: "+15145550192" });
    const c3 = await makeClient({ phone: "+15145550193" });
    await testDb.insert(campaignEnrollments).values([
      { campaignId: a.id, clientId: c1.id, status: "active" },
      { campaignId: a.id, clientId: c2.id, status: "replied" },
      { campaignId: a.id, clientId: c3.id, status: "stopped" },
      { campaignId: b.id, clientId: c1.id, status: "active" },
    ]);
    const rows = await listCampaignsWithCounts();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.A).toMatchObject({ enrolled: 3, active: 1, replied: 1, stopped: 1 });
    expect(byName.B).toMatchObject({ enrolled: 1, active: 1, replied: 0, stopped: 0 });
  });

  it("assistants : le nombre de messages écrits est celui de la base", async () => {
    const [x] = await testDb.insert(assistants).values({ name: "X", status: "draft", identity: {}, goal: {}, approach: {}, model: {} }).returning();
    await testDb.insert(assistants).values({ name: "Y", status: "draft", identity: {}, goal: {}, approach: {}, model: {} });
    const number = await makeSmsNumber();
    const client = await makeClient({ phone: "+15145550194" });
    const thread = await makeConversation({ clientId: client.id, clientPhone: client.phone, smsNumberId: number.id });
    await testDb.insert(messages).values([
      { conversationId: thread.id, direction: "out", body: "a", source: "agent", assistantId: x.id },
      { conversationId: thread.id, direction: "out", body: "b", source: "agent", assistantId: x.id },
    ]);
    const { rows } = await listAssistantsWithCounts();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.X.messageCount).toBe(2);
    expect(byName.Y.messageCount).toBe(0);
  });
});
