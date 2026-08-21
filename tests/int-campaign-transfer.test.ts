/**
 * Intégration — import/export d'une campagne contre la base.
 *
 * La partie pure est couverte ailleurs ; ici on vérifie ce que seul le serveur
 * décide : les étiquettes viennent des VRAIES tables, l'import écrit un
 * BROUILLON, et la relecture d'un fichier exporté retombe sur les bons
 * identifiants locaux.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  closeDb,
  makeCategory,
  makeSmsNumber,
  makeSource,
  makeUser,
  resetDb,
  testDb,
} from "./helpers/db";
import { assistants, campaigns } from "@/db/schema-sms";
import { assistantConfigSchema } from "@/lib/assistants/schema";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { exportCampaign, exportCampaignFile, importCampaign, previewCampaignImport } = await import(
  "@/lib/campaigns-server/transfer"
);

const NOW = new Date("2026-08-21T12:00:00.000Z");

async function scene() {
  const broker = await makeUser({ email: "alex@example.com", name: "Alex-Honoré", role: "admin" });
  const category = await makeCategory({ key: "callback", nameFr: "À rappeler", nameEn: "Callback" });
  const source = await makeSource({ name: "Facebook" });
  const number = await makeSmsNumber({ e164: "+15814810742", label: "Ligne" });
  const cfg = assistantConfigSchema.parse({
    name: "Acheteur FB",
    identity: {},
    approach: {},
    model: {},
    goal: { primary: { type: "qualify_only", requiredFields: [] } },
  });
  const [assistant] = await testDb
    .insert(assistants)
    .values({
      name: cfg.name,
      status: "draft",
      identity: cfg.identity,
      goal: cfg.goal,
      approach: cfg.approach,
      knowledge: cfg.knowledge,
      model: cfg.model,
      tools: cfg.tools,
    })
    .returning();
  const [campaign] = await testDb
    .insert(campaigns)
    .values({
      name: "Réactivation 180 j",
      description: "Vieux leads",
      status: "active",
      assistantId: assistant.id,
      smsNumberId: number.id,
      trigger: { kind: "lead_created", sourceIds: [source.id] },
      audience: { categoryIds: [category.id], assignedToIds: [broker.id], notContactedForDays: 180 },
      ladder: [{ delayHours: 0, body: null, label: "ouverture" }],
    })
    .returning();
  return { broker, category, source, number, assistant, campaign };
}

afterAll(closeDb);

describe("export", () => {
  beforeEach(resetDb);

  it("les liaisons portent les étiquettes des VRAIES tables", async () => {
    const { campaign } = await scene();
    const bundle = await exportCampaign(campaign.id, { now: NOW });
    const labels = Object.fromEntries(bundle.bindings.map((b) => [b.path, b.label]));
    expect(labels["assistantId"]).toBe("Acheteur FB");
    expect(labels["smsNumberId"]).toBe("+15814810742");
    expect(labels["audience.categoryIds[]"]).toBe("À rappeler");
    expect(labels["trigger.sourceIds[]"]).toBe("Facebook");
    expect(labels["audience.assignedToIds[]"]).toBe("alex@example.com");
    expect(bundle.campaign.assistantId).toBeNull();
  });

  it("le nom de fichier est lisible, sans accent", async () => {
    const { campaign } = await scene();
    const file = await exportCampaignFile(campaign.id, { now: NOW });
    expect(file.filename).toBe("campagne-reactivation-180-j.json");
    expect(file.body).toContain('"format": "nexus.campaign/v1"');
  });
});

describe("import", () => {
  beforeEach(resetDb);

  it("exporter puis importer ICI retombe sur les identifiants locaux, en BROUILLON", async () => {
    const { campaign, assistant, number, category, source, broker } = await scene();
    const bundle = await exportCampaign(campaign.id, { now: NOW });

    const result = await importCampaign(bundle, { actorId: broker.id });
    const row = await testDb.query.campaigns.findFirst({ where: eq(campaigns.id, result.campaignId) });
    expect(row!.status).toBe("draft");
    expect(row!.name).toBe("Réactivation 180 j (2)");
    expect(row!.assistantId).toBe(assistant.id);
    expect(row!.smsNumberId).toBe(number.id);
    expect((row!.audience as { categoryIds: number[] }).categoryIds).toEqual([category.id]);
    expect((row!.audience as { assignedToIds: string[] }).assignedToIds).toEqual([broker.id]);
    expect((row!.trigger as { sourceIds: number[] }).sourceIds).toEqual([source.id]);
    expect(result.warnings.filter((w) => w.code === "unresolved_binding")).toEqual([]);
  });

  it("dans une base où rien ne porte ces noms, les liaisons restent vides et préviennent", async () => {
    const { campaign, broker } = await scene();
    const bundle = await exportCampaign(campaign.id, { now: NOW });
    await resetDb();
    const actor = await makeUser({ email: "autre@example.com" });
    void broker;
    const result = await importCampaign(bundle, { actorId: actor.id });
    const row = await testDb.query.campaigns.findFirst({ where: eq(campaigns.id, result.campaignId) });
    expect(row!.assistantId).toBeNull();
    expect(row!.smsNumberId).toBeNull();
    expect((row!.audience as { categoryIds: number[] }).categoryIds).toEqual([]);
    expect(result.warnings.filter((w) => w.code === "unresolved_binding").length).toBeGreaterThanOrEqual(5);
  });

  it("la prévisualisation n'écrit rien et montre ce qui s'est relié tout seul", async () => {
    const { campaign, assistant } = await scene();
    const bundle = await exportCampaign(campaign.id, { now: NOW });
    const before = (await testDb.select().from(campaigns)).length;
    const preview = await previewCampaignImport(bundle);
    expect((await testDb.select().from(campaigns)).length).toBe(before);
    expect(preview.resolved[assistant.id]).toBe(assistant.id);
    expect(preview.catalog.assistants.map((a) => a.name)).toContain("Acheteur FB");
  });

  it("un fichier d'assistant n'est pas une campagne", async () => {
    await expect(
      importCampaign({ format: "nexus.assistant/v1", exportedAt: "x", assistant: {} }, { actorId: null }),
    ).rejects.toThrow();
  });
});
