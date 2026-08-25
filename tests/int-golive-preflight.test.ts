/**
 * Intégration — battement du répartiteur et contrôle avant mise en service.
 *
 * Le battement touche la MÊME rangée de réglages que l'interrupteur d'arrêt.
 * Un cycle par minute qui réécrirait tout l'objet pourrait ressusciter un
 * interrupteur qu'un administrateur vient de relever — le contrôle de sécurité
 * le plus important du moteur ne doit pas dépendre d'une course.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, resetDb, testDb } from "./helpers/db";
import { settings } from "@/db/schema";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { runDispatchCycle } = await import("@/lib/jobs/dispatch");
const { settingsSendGate } = await import("@/lib/sms-server");
const { getSetting } = await import("@/lib/settings");

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

describe("battement du répartiteur", () => {
  it("un cycle écrit le battement, même sans aucun job", async () => {
    // Se fier au dernier job réclamé dirait « arrêté » chaque fois que la file
    // est simplement vide.
    await runDispatchCycle();

    const row = await testDb.query.settings.findFirst({ where: eq(settings.key, "sms") });
    const value = row!.value as { lastDispatchAt: string };
    expect(value.lastDispatchAt).toBeTruthy();
    expect(Date.now() - new Date(value.lastDispatchAt).getTime()).toBeLessThan(60_000);
  });

  it("le battement NE RESSUSCITE PAS un interrupteur d'arrêt relevé", async () => {
    await testDb.insert(settings).values({
      key: "sms",
      value: { killSwitch: true, killSwitchReason: "incident" },
    });
    expect(await settingsSendGate.isSendingAllowed()).toBe(false);

    await runDispatchCycle();

    // L'interrupteur tient, et la raison n'a pas été effacée.
    const after = await getSetting("sms");
    expect(after.killSwitch).toBe(true);
    expect(after.killSwitchReason).toBe("incident");
    expect(after.lastDispatchAt).toBeTruthy();
    expect(await settingsSendGate.isSendingAllowed()).toBe(false);
  });

  it("le battement ne réarme pas non plus un interrupteur BAISSÉ", async () => {
    await testDb.insert(settings).values({
      key: "sms",
      value: { killSwitch: false },
    });
    await runDispatchCycle();

    const after = await getSetting("sms");
    expect(after.killSwitch).toBe(false);
    // Et les autres réglages sont intacts.
    expect(await settingsSendGate.isSendingAllowed()).toBe(true);
  });

  it("deux cycles successifs avancent le battement", async () => {
    await runDispatchCycle();
    const first = (await getSetting("sms")).lastDispatchAt;
    await new Promise((r) => setTimeout(r, 15));
    await runDispatchCycle();
    const second = (await getSetting("sms")).lastDispatchAt;
    expect(new Date(second!).getTime()).toBeGreaterThanOrEqual(new Date(first!).getTime());
  });
});

describe("collectPreflight — les clés PAR ASSISTANT sortent de la vraie base", () => {
  // L'angle mort de l'incident du 2026-08-25 : « llm_provider » vert (une clé
  // OpenRouter existe) pendant que le REPLI des assistants actifs vise
  // anthropic, sans clé. Le rapport doit nommer l'assistant et le fournisseur.
  const saved = {
    openrouter: process.env.OPENROUTER_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  const restore = () => {
    for (const [key, value] of [
      ["OPENROUTER_API_KEY", saved.openrouter],
      ["ANTHROPIC_API_KEY", saved.anthropic],
      ["GOOGLE_API_KEY", saved.google],
      ["OPENAI_API_KEY", saved.openai],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const insertActive = async (name: string, model: Record<string, unknown>) => {
    const { assistants, promptCores } = await import("@/db/schema-sms");
    // La porte d'activation (trigger) exige un compilé au core le plus récent.
    await testDb
      .insert(promptCores)
      .values({ version: 1, body: "core (test)" })
      .onConflictDoNothing();
    await testDb.insert(assistants).values({
      name,
      identity: {},
      goal: {},
      approach: {},
      model,
      status: "active",
      compiledPrompt: "compilé (test)",
      compiledCoreVersion: 1,
      compiledAt: new Date(),
      needsRecompile: false,
      requireSuitePass: false,
    });
  };

  it("repli sans clé : avertissement nommé ; générateur sans clé : blocage nommé", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await insertActive("Réactivation", {
        provider: "openrouter",
        model: "openai/gpt-5.6-luna",
        classifier: { provider: "openrouter", model: "google/gemini-2.5-flash" },
        fallback: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      await insertActive("Prospection", {
        provider: "google",
        model: "gemini-2.5-pro",
        classifier: { provider: "openrouter", model: "google/gemini-2.5-flash" },
        fallback: null,
      });

      const { collectPreflight } = await import("@/lib/golive-server");
      const report = await collectPreflight();

      const fallbackCheck = report.checks.find((c) => c.id === "assistant_fallback_keys");
      expect(fallbackCheck?.ok).toBe(false);
      expect(fallbackCheck?.detail).toBe("Réactivation : anthropic");
      expect(report.warnings).toContain("assistant_fallback_keys");

      const modelCheck = report.checks.find((c) => c.id === "assistant_model_keys");
      expect(modelCheck?.ok).toBe(false);
      expect(modelCheck?.detail).toBe("Prospection : google");
      expect(report.blockers).toContain("assistant_model_keys");
    } finally {
      restore();
    }
  });

  it("toutes les clés présentes : les deux contrôles sont verts", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      await insertActive("Réactivation", {
        provider: "openrouter",
        model: "openai/gpt-5.6-luna",
        classifier: { provider: "openrouter", model: "google/gemini-2.5-flash" },
        fallback: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      const { collectPreflight } = await import("@/lib/golive-server");
      const report = await collectPreflight();
      expect(report.checks.find((c) => c.id === "assistant_model_keys")?.ok).toBe(true);
      expect(report.checks.find((c) => c.id === "assistant_fallback_keys")?.ok).toBe(true);
    } finally {
      restore();
    }
  });
});
