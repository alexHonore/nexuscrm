/**
 * Intégration — porte d'activation des assistants (§11.4).
 *
 * Le cahier l'exige DEUX fois : dans l'action serveur ET par un trigger en
 * base. On vérifie donc les deux chemins, dont l'écriture SQL directe qui
 * tenterait de contourner l'application.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, resetDb, sqlRaw, testDb } from "./helpers/db";
import { assistants, promptCores } from "@/db/schema-sms";
import { assistantConfigSchema } from "@/lib/assistants/schema";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { checkActivation, activateAssistant, compileAssistant } = await import(
  "@/lib/assistants/service"
);
const { seedGuardrailDefaults } = await import("@/lib/guardrails/store");
const { runnableFixtures } = await import("@/lib/guardrails/runner");
const { toolDefsFor } = await import("@/lib/agent/tools");

async function makeAssistant(overrides: Partial<typeof assistants.$inferInsert> = {}) {
  const config = assistantConfigSchema.parse({
    name: "Acheteur FB",
    identity: {},
    goal: {
      primary: { type: "video_meeting", durationMin: 30, appointmentType: "meet" },
      fallbacks: [],
    },
    approach: {},
    model: {},
  });
  const [row] = await testDb
    .insert(assistants)
    .values({
      name: config.name,
      description: config.description,
      language: config.language,
      identity: config.identity,
      goal: config.goal,
      approach: config.approach,
      knowledge: config.knowledge,
      objectionPacks: config.objectionPacks,
      tools: config.tools,
      model: config.model,
      status: "draft",
      needsRecompile: true,
      ...overrides,
    })
    .returning();
  return row;
}

describe("porte d'activation", () => {
  beforeEach(async () => {
    await resetDb();
    await seedGuardrailDefaults();
  });
  afterAll(closeDb);

  it("refuse un assistant jamais compilé (stale_compile)", async () => {
    const assistant = await makeAssistant();
    const check = await checkActivation(assistant.id);
    expect(check).toMatchObject({ allowed: false, reason: "stale_compile" });
  });

  it("après compilation, refuse encore tant que la suite n'est pas verte", async () => {
    const assistant = await makeAssistant();
    await compileAssistant(assistant.id, null);

    const check = await checkActivation(assistant.id);
    expect(check).toMatchObject({ allowed: false, reason: "suite_not_passed" });

    // L'assistant est bien resté en draft.
    const [row] = await testDb.select().from(assistants).where(eq(assistants.id, assistant.id));
    expect(row.status).toBe("draft");
    expect(row.compiledPrompt).toBeTruthy();
    expect(row.needsRecompile).toBe(false);
  });

  it("autorise quand le prompt est à jour ET la suite verte", async () => {
    const assistant = await makeAssistant();
    await compileAssistant(assistant.id, null);
    await testDb
      .update(assistants)
      .set({ suitePassed: true })
      .where(eq(assistants.id, assistant.id));

    const result = await activateAssistant(assistant.id);
    expect(result.allowed).toBe(true);

    const [row] = await testDb.select().from(assistants).where(eq(assistants.id, assistant.id));
    expect(row.status).toBe("active");
  });

  it("require_suite_pass = false : la porte devient consultative (§11.2.3)", async () => {
    const assistant = await makeAssistant({ requireSuitePass: false });
    await compileAssistant(assistant.id, null);

    // Suite rouge, mais l'admin a désactivé la barrière.
    const result = await activateAssistant(assistant.id);
    expect(result.allowed).toBe(true);

    const [row] = await testDb.select().from(assistants).where(eq(assistants.id, assistant.id));
    expect(row.status).toBe("active");
    // La recompilation, elle, reste exigée : un prompt périmé est un bogue.
    expect(row.suitePassed).toBe(false);
  });

  it("un noyau plus récent périme la compilation — l'assistant redevient inactivable", async () => {
    const assistant = await makeAssistant();
    await compileAssistant(assistant.id, null);
    await testDb
      .update(assistants)
      .set({ suitePassed: true })
      .where(eq(assistants.id, assistant.id));
    expect((await checkActivation(assistant.id)).allowed).toBe(true);

    // Bump du corps L0 : tout assistant compilé contre v1 est désormais périmé.
    await testDb.insert(promptCores).values({ version: 2, body: "# RÔLE\nnouveau noyau" });

    expect(await checkActivation(assistant.id)).toMatchObject({
      allowed: false,
      reason: "stale_compile",
    });
  });

  it("la compilation invalide la suite précédente", async () => {
    const assistant = await makeAssistant();
    await compileAssistant(assistant.id, null);
    await testDb.update(assistants).set({ suitePassed: true }).where(eq(assistants.id, assistant.id));

    await compileAssistant(assistant.id, null);
    const [row] = await testDb.select().from(assistants).where(eq(assistants.id, assistant.id));
    expect(row.suitePassed).toBe(false);
  });

  // ── Le trigger : la même règle, côté base ──────────────────────────────────

  it("§21 — une écriture SQL DIRECTE ne peut pas activer un assistant périmé", async () => {
    const assistant = await makeAssistant();

    await expect(
      sqlRaw`update assistants set status = 'active' where id = ${assistant.id}`,
    ).rejects.toThrow(/activation_gate: stale_compile/);

    const [row] = await testDb.select().from(assistants).where(eq(assistants.id, assistant.id));
    expect(row.status).toBe("draft");
  });

  it("§21 — une écriture SQL directe ne peut pas activer un assistant à suite rouge", async () => {
    const assistant = await makeAssistant();
    await compileAssistant(assistant.id, null);

    await expect(
      sqlRaw`update assistants set status = 'active' where id = ${assistant.id}`,
    ).rejects.toThrow(/activation_gate: suite_not_passed/);
  });

  it("le trigger laisse passer un assistant conforme", async () => {
    const assistant = await makeAssistant();
    await compileAssistant(assistant.id, null);
    await testDb.update(assistants).set({ suitePassed: true }).where(eq(assistants.id, assistant.id));

    await sqlRaw`update assistants set status = 'active' where id = ${assistant.id}`;
    const [row] = await testDb.select().from(assistants).where(eq(assistants.id, assistant.id));
    expect(row.status).toBe("active");
  });

  it("un assistant DÉJÀ actif peut être mis à jour sans repasser la porte", async () => {
    const assistant = await makeAssistant();
    await compileAssistant(assistant.id, null);
    await testDb.update(assistants).set({ suitePassed: true }).where(eq(assistants.id, assistant.id));
    await activateAssistant(assistant.id);

    // Une écriture ordinaire sur une rangée active ne doit pas être refusée.
    await sqlRaw`update assistants set description = 'note' where id = ${assistant.id}`;
    const [row] = await testDb.select().from(assistants).where(eq(assistants.id, assistant.id));
    expect(row.status).toBe("active");
    expect(row.description).toBe("note");
  });
});

describe("la suite offre les outils de l'assistant au modèle", () => {
  it("les fixtures qui exigent un appel d'outil ne peuvent pas être vertes sans outils", () => {
    // Garde-fou de régression. Le générateur de la suite doit recevoir
    // `tools` : sans lui, `toolCalls` est TOUJOURS vide, donc
    // `mustCallTool: ["stop"]` échoue toujours et `mustNotCallTool` réussit
    // toujours. Deux fixtures « STOP » bloquantes restaient rouges pour de
    // bon, ce qui rendait impossible l'activation de tout assistant exigeant
    // une suite verte — et `mustNotCallTool` était un test qui ne pouvait
    // rien attraper.
    const source = readFileSync(
      join(process.cwd(), "src", "lib", "assistants", "service.ts"),
      "utf8",
    );
    expect(source).toContain("tools: toolDefsFor(config.tools");
  });

  it("toolDefsFor rend bien les outils attendus par les fixtures semées", () => {
    const defs = toolDefsFor(["stop", "handoff", "book_meeting"]);
    expect(defs.map((d) => d.name).sort()).toEqual(["book_meeting", "handoff", "stop"]);
    // Les fixtures du noyau attendent « stop » et « handoff ».
    expect(defs.some((d) => d.name === "stop")).toBe(true);
  });

  it("les fixtures semées exigent réellement des appels d'outils", async () => {
    await seedGuardrailDefaults();
    const fixtures = await import("@/lib/guardrails/store").then((m) => m.loadCoreFixtures());
    const withTools = runnableFixtures(fixtures).filter(
      (f) => f.expectations.mustCallTool.length > 0,
    );
    expect(withTools.length).toBeGreaterThan(0);
  });
});
