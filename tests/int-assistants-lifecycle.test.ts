/**
 * Intégration — cycle de vie d'un assistant : versions, désactivation,
 * archivage terminal, et les écritures « compare-and-set » de la compilation
 * et de la suite.
 *
 * Ce que ce fichier verrouille :
 *  · chaque compilation incrémente la version et gèle un instantané ;
 *  · un vert de suite ne se pose JAMAIS sur une configuration qui a changé
 *    pendant l'exécution ;
 *  · une compilation n'efface pas un drapeau posé entre sa lecture et son
 *    écriture ;
 *  · « archivé » est terminal (serveur ET trigger) ; désactiver ramène en
 *    brouillon, est audité, et un prompt vide ne passe pas la porte en base.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, sqlRaw, testDb } from "./helpers/db";
import { auditLogs } from "@/db/schema";
import { assistants, assistantVersions, guardrailFixtures, guardrailRuns } from "@/db/schema-sms";
import { assistantConfigSchema } from "@/lib/assistants/schema";
import { LLMProviderError } from "@/lib/llm/types";

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  /** Crochets d'interférence : simulent un collègue qui enregistre pendant. */
  hooks: {
    beforeCore: null as null | (() => Promise<void>),
    onGenerate: null as null | (() => Promise<void>),
    /** Panne qui DURE : elle frappe tous les crans, pas seulement le premier. */
    persistentGenerateError: null as string | null,
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = ctx.cookies.get(name);
      return v ? { name, value: v } : undefined;
    },
    set: (n: string, v: string) => ctx.cookies.set(n, v),
    delete: (n: string) => ctx.cookies.delete(n),
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/guardrails/store", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/guardrails/store")>();
  return {
    ...mod,
    currentCore: async () => {
      const hook = ctx.hooks.beforeCore;
      ctx.hooks.beforeCore = null;
      if (hook) await hook();
      return mod.currentCore();
    },
  };
});
vi.mock("@/lib/llm-server", () => ({
  getLlmProvider: () => ({
    generate: async (input: { temperature?: number; maxTokens?: number }) => {
      // Le juge (classifieur) est reconnaissable à ses paramètres fixes.
      if (input.temperature === 0 && input.maxTokens === 300) {
        return { text: '{"passed":true,"reason":"conforme"}', toolCalls: [] };
      }
      if (ctx.hooks.persistentGenerateError) {
        throw new LLMProviderError(ctx.hooks.persistentGenerateError, "openrouter", 503, true);
      }
      const hook = ctx.hooks.onGenerate;
      ctx.hooks.onGenerate = null;
      if (hook) await hook();
      return { text: "Je vous mets en contact avec le courtier. Achat ou vente?", toolCalls: [] };
    },
  }),
}));

const {
  activateAssistant,
  checkActivation,
  compileAssistant,
  deactivateAssistant,
  runAssistantSuite,
} = await import("@/lib/assistants/service");
const { seedGuardrailDefaults } = await import("@/lib/guardrails/store");
const deactivateRoute = await import("@/app/api/assistants/[id]/deactivate/route");
const activateRoute = await import("@/app/api/assistants/[id]/activate/route");
const compileRoute = await import("@/app/api/assistants/[id]/compile/route");

let adminId: string;

function req(url: string, method: string) {
  return new NextRequest(`http://localhost:3000${url}`, { method });
}

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

async function rowOf(id: string) {
  const row = await testDb.query.assistants.findFirst({ where: eq(assistants.id, id) });
  return row!;
}

beforeEach(async () => {
  await resetDb();
  await seedGuardrailDefaults();
  ctx.cookies.clear();
  ctx.hooks.beforeCore = null;
  ctx.hooks.onGenerate = null;
  ctx.hooks.persistentGenerateError = null;
  const admin = await makeUser({ role: "admin" });
  adminId = admin.id;
  const token = await new SignJWT({ uid: admin.id, role: "admin", tv: admin.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set("nexus_session", token);
});

afterAll(closeDb);

describe("versions", () => {
  it("chaque compilation incrémente la version et gèle un instantané distinct", async () => {
    const a = await makeAssistant();
    const first = await compileAssistant(a.id, adminId);
    expect(first.version).toBe(2);

    // Sauvegarde entre les deux : l'identité change, donc L1 aussi.
    await testDb
      .update(assistants)
      .set({ identity: { ...(a.identity as object), orgName: "Équipe Lévis" }, needsRecompile: true, updatedAt: new Date() })
      .where(eq(assistants.id, a.id));
    const second = await compileAssistant(a.id, adminId);
    expect(second.version).toBe(3);
    expect(second.prompt).not.toBe(first.prompt);

    const snapshots = await testDb
      .select()
      .from(assistantVersions)
      .where(eq(assistantVersions.assistantId, a.id))
      .orderBy(asc(assistantVersions.version));
    // Avant : un seul instantané, les suivants avalés par onConflictDoNothing.
    expect(snapshots.map((s) => s.version)).toEqual([2, 3]);
    expect(snapshots[0].compiledPrompt).toBe(first.prompt);
    expect(snapshots[1].compiledPrompt).toBe(second.prompt);
    expect((await rowOf(a.id)).version).toBe(3);
  });

  it("une configuration qui change PENDANT la compilation fait échouer l'écriture", async () => {
    const a = await makeAssistant();
    // Un collègue enregistre entre la lecture de la rangée et l'écriture.
    ctx.hooks.beforeCore = async () => {
      await testDb
        .update(assistants)
        .set({ needsRecompile: true, updatedAt: new Date(Date.now() + 5) })
        .where(eq(assistants.id, a.id));
    };
    await expect(compileAssistant(a.id, adminId)).rejects.toThrow("assistant_changed_during_compile");

    const row = await rowOf(a.id);
    // Le drapeau posé par la sauvegarde concurrente n'a PAS été effacé.
    expect(row.needsRecompile).toBe(true);
    expect(row.compiledPrompt).toBeNull();
    expect(await testDb.select().from(assistantVersions)).toHaveLength(0);
  });

  it("la route de compilation répond 409 quand la configuration a bougé", async () => {
    const a = await makeAssistant();
    ctx.hooks.beforeCore = async () => {
      await testDb
        .update(assistants)
        .set({ updatedAt: new Date(Date.now() + 5) })
        .where(eq(assistants.id, a.id));
    };
    const res = await compileRoute.POST(req(`/api/assistants/${a.id}/compile`, "POST"), {
      params: Promise.resolve({ id: a.id }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("assistant_changed");
  });

  it("un prompt libre vide ne compile pas (empty_prompt), rien n'est écrit", async () => {
    const a = await makeAssistant({ promptMode: "raw", systemPromptOverride: null });
    await expect(compileAssistant(a.id, adminId)).rejects.toThrow("empty_prompt");
    const row = await rowOf(a.id);
    expect(row.compiledPrompt).toBeNull();
    expect(row.needsRecompile).toBe(true);
  });
});

describe("suite — compare-and-set", () => {
  async function onlyOwnFixture(assistantId: string) {
    // Les fixtures du noyau exigent des appels d'outils que le faux modèle ne
    // fait pas : on ne garde qu'un scénario propre à l'assistant.
    await testDb.update(guardrailFixtures).set({ enabled: false });
    await testDb.insert(guardrailFixtures).values({
      scope: "assistant",
      assistantId,
      label: "Répond poliment",
      setup: { priorTurns: [], qualification: {}, rung: "primary", turnsUsed: 0 },
      inbound: "Bonjour",
      expectations: { mustCallTool: [], mustNotCallTool: [], mustMatch: [], mustNotMatch: [], judge: null, maxChars: null },
      severity: "block",
      origin: "custom",
      enabled: true,
      orderIndex: 0,
    });
  }

  it("sans interférence, un vert se pose", async () => {
    const a = await makeAssistant();
    await compileAssistant(a.id, adminId);
    await onlyOwnFixture(a.id);

    const outcome = await runAssistantSuite(a.id, adminId);
    expect(outcome.passed).toBe(true);
    expect(outcome.superseded).toBe(false);
    expect((await rowOf(a.id)).suitePassed).toBe(true);
  });

  it("un 429 passager de l'amont ne peint plus la fixture en rouge", async () => {
    // Le cas signalé le 2026-08-27 : « Raison de l'échec : erreur du modèle :
    // llm_upstream_429 … Please retry shortly ». La suite appelait le modèle
    // SANS repli ni reprise : trois secondes d'embouteillage rendaient
    // l'assistant inactivable et forçaient à repayer les quatorze fixtures.
    const a = await makeAssistant();
    await compileAssistant(a.id, adminId);
    await onlyOwnFixture(a.id);

    ctx.hooks.onGenerate = async () => {
      throw new LLMProviderError(
        "llm_upstream_429: openai/gpt-5.6-luna is temporarily rate-limited upstream",
        "openrouter",
        429,
        true,
      );
    };

    const outcome = await runAssistantSuite(a.id, adminId);

    expect(outcome.results.map((r) => r.reason)).toEqual([null]);
    expect(outcome.passed).toBe(true);
    expect((await rowOf(a.id)).suitePassed).toBe(true);
  });

  it("une panne QUI DURE reste un échec de fixture, pas un faux vert", async () => {
    const a = await makeAssistant();
    await compileAssistant(a.id, adminId);
    await onlyOwnFixture(a.id);
    // Le crochet ne se désarme pas : tous les crans tombent.
    ctx.hooks.persistentGenerateError = "llm_http_503: upstream down";

    const outcome = await runAssistantSuite(a.id, adminId);

    expect(outcome.passed).toBe(false);
    expect(outcome.results[0]?.reason).toMatch(/erreur du modèle : llm_http_503/);
  });

  it("une sauvegarde PENDANT la suite : le vert n'est PAS posé, l'exécution est marquée écartée", async () => {
    const a = await makeAssistant();
    await compileAssistant(a.id, adminId);
    await onlyOwnFixture(a.id);

    ctx.hooks.onGenerate = async () => {
      // Même effet qu'un PATCH : updated_at bouge, la suite est invalidée.
      await testDb
        .update(assistants)
        .set({ suitePassed: false, updatedAt: new Date(Date.now() + 5) })
        .where(eq(assistants.id, a.id));
    };
    const outcome = await runAssistantSuite(a.id, adminId);
    expect(outcome.superseded).toBe(true);
    expect(outcome.passed).toBe(false);

    const row = await rowOf(a.id);
    // Le vert obtenu contre l'ANCIENNE configuration ne vaut pas pour la nouvelle.
    expect(row.suitePassed).toBe(false);
    expect((await checkActivation(a.id)).reason).toBe("suite_not_passed");

    const [run] = await testDb.select().from(guardrailRuns).where(eq(guardrailRuns.id, outcome.runId));
    expect(run.passed).toBe(false);
    const results = run.results as { label: string }[];
    expect(results.at(-1)?.label).toMatch(/écarté/);
  });

  it("une recompilation PENDANT la suite invalide aussi le résultat", async () => {
    const a = await makeAssistant();
    await compileAssistant(a.id, adminId);
    await onlyOwnFixture(a.id);

    ctx.hooks.onGenerate = async () => {
      await compileAssistant(a.id, adminId);
    };
    const outcome = await runAssistantSuite(a.id, adminId);
    expect(outcome.superseded).toBe(true);
    expect((await rowOf(a.id)).suitePassed).toBe(false);
  });
});

describe("désactivation et archivage", () => {
  async function activeAssistant() {
    const a = await makeAssistant();
    await compileAssistant(a.id, adminId);
    await testDb.update(assistants).set({ suitePassed: true }).where(eq(assistants.id, a.id));
    expect((await activateAssistant(a.id)).allowed).toBe(true);
    return a;
  }

  it("POST /deactivate ramène un assistant actif en brouillon, et l'audite", async () => {
    const a = await activeAssistant();
    const res = await deactivateRoute.POST(req(`/api/assistants/${a.id}/deactivate`, "POST"), {
      params: Promise.resolve({ id: a.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "draft", changed: true });
    expect((await rowOf(a.id)).status).toBe("draft");

    const audit = await testDb.select().from(auditLogs);
    expect(audit.some((r) => r.action === "assistant.deactivate" && r.entityId === a.id)).toBe(true);

    // Idempotent : un brouillon reste un brouillon, sans second audit.
    const again = await deactivateRoute.POST(req(`/api/assistants/${a.id}/deactivate`, "POST"), {
      params: Promise.resolve({ id: a.id }),
    });
    expect(await again.json()).toMatchObject({ ok: true, changed: false });
    expect((await testDb.select().from(auditLogs)).filter((r) => r.action === "assistant.deactivate")).toHaveLength(1);
  });

  it("un assistant désactivé repasse par la porte pour être réactivé", async () => {
    const a = await activeAssistant();
    await deactivateAssistant(a.id);
    // Le vert est toujours là : la porte le laisse repasser.
    expect((await checkActivation(a.id)).allowed).toBe(true);
    await testDb.update(assistants).set({ needsRecompile: true }).where(eq(assistants.id, a.id));
    expect((await checkActivation(a.id)).reason).toBe("stale_compile");
  });

  it("« archivé » est TERMINAL : ni la porte serveur, ni la route, ni le trigger ne réactivent", async () => {
    const a = await activeAssistant();
    await testDb.update(assistants).set({ status: "archived" }).where(eq(assistants.id, a.id));

    expect(await checkActivation(a.id)).toMatchObject({ allowed: false, reason: "archived" });
    expect((await activateAssistant(a.id)).allowed).toBe(false);

    const res = await activateRoute.POST(req(`/api/assistants/${a.id}/activate`, "POST"), {
      params: Promise.resolve({ id: a.id }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("archived");

    // Tous les autres critères sont verts : seul l'archivage bloque, en base aussi.
    await expect(
      sqlRaw`update assistants set status = 'active' where id = ${a.id}`,
    ).rejects.toThrow(/activation_gate: archived/);

    const deact = await deactivateRoute.POST(req(`/api/assistants/${a.id}/deactivate`, "POST"), {
      params: Promise.resolve({ id: a.id }),
    });
    expect(deact.status).toBe(409);
    expect((await rowOf(a.id)).status).toBe("archived");
  });

  it("§21 — le trigger refuse un prompt compilé VIDE, comme la porte serveur", async () => {
    const a = await makeAssistant({
      compiledPrompt: "   ",
      compiledCoreVersion: 1,
      compiledAt: new Date(),
      needsRecompile: false,
      suitePassed: true,
      requireSuitePass: false,
    });
    await expect(
      sqlRaw`update assistants set status = 'active' where id = ${a.id}`,
    ).rejects.toThrow(/activation_gate: stale_compile/);
    expect((await checkActivation(a.id)).reason).toBe("stale_compile");
  });
});
