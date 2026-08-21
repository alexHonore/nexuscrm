import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assistants, assistantVersions, guardrailRuns, objectionPacks } from "@/db/schema-sms";
import { compileAssistantPrompt } from "@/lib/agent/compile";
import { DEFAULT_TURN_INSTRUCTIONS } from "@/lib/agent/templates";
import { toolDefsFor } from "@/lib/agent/tools";
import { renderTemplate } from "@/lib/agent/render";
import { resolveRules } from "@/lib/guardrails/resolve";
import {
  currentCore,
  loadAssistantFixtures,
  loadAssistantRules,
  loadCoreFixtures,
  loadCoreRules,
} from "@/lib/guardrails/store";
import { runFixture, runnableFixtures, suitePassed } from "@/lib/guardrails/runner";
import type { FixtureData, FixtureResult } from "@/lib/guardrails/types";
import { getLlmProvider } from "@/lib/llm-server";
import { assistantRowToConfig, type AssistantConfig } from "./schema";

/**
 * Orchestration serveur des assistants : compilation, exécution de la suite,
 * porte d'activation.
 *
 * La porte (§11.4) est vérifiée ICI **et** par un trigger en base
 * (drizzle/0003_phase3-assistants.trigger.sql) : le cahier exige les deux, pour
 * qu'une écriture directe en base ne puisse pas activer un assistant dont le
 * prompt est périmé ou la suite rouge.
 */

/** Marge sous le maxDuration de la route (300 s) pour finir proprement. */
const SUITE_BUDGET_MS = 240_000;

type AssistantRow = typeof assistants.$inferSelect;

async function loadAssistant(assistantId: string): Promise<AssistantRow> {
  const row = await db.query.assistants.findFirst({ where: eq(assistants.id, assistantId) });
  if (!row) throw new Error("assistant_not_found");
  return row;
}

async function loadPacks(ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db.select().from(objectionPacks);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is (typeof rows)[number] => row !== undefined)
    .map((row) => ({
      id: row.id,
      label: row.label,
      items: (row.items as { key: string; triggerHint: string; acknowledge: string; reframe: string; ask: string }[]) ?? [],
    }));
}

/** Règles applicables à un assistant : core + ses forks, dans l'ordre résolu. */
export async function resolvedRulesFor(assistantId: string) {
  const [core, own] = await Promise.all([loadCoreRules(), loadAssistantRules(assistantId)]);
  return resolveRules(core, own);
}

// ── Compilation ──────────────────────────────────────────────────────────────

export interface CompileResult {
  version: number;
  coreVersion: number;
  prompt: string;
  layers: { id: string; source: string; text: string }[];
}

/**
 * Compile L0-L6, gèle un instantané de version et efface `needs_recompile`.
 * Toute sauvegarde de config repose le drapeau — un prompt périmé est un bogue,
 * jamais un choix.
 */
export async function compileAssistant(
  assistantId: string,
  actorId: string | null,
): Promise<CompileResult> {
  const row = await loadAssistant(assistantId);
  const config: AssistantConfig = assistantRowToConfig(row);
  const core = await currentCore();
  const packs = await loadPacks(config.objectionPacks);
  const rules = await resolvedRulesFor(assistantId);

  const compiled = compileAssistantPrompt(
    config,
    { version: core.version, body: core.body },
    packs,
    rules.map((rule) => ({
      key: rule.key,
      label: rule.label,
      promptText: rule.promptText,
      severity: rule.severity,
      enabled: rule.enabled,
      scope: rule.scope,
      overridesKey: rule.overridesKey ?? null,
      orderIndex: rule.orderIndex,
    })),
  );

  const now = new Date();
  await db
    .update(assistants)
    .set({
      compiledPrompt: compiled.prompt,
      compiledCoreVersion: compiled.coreVersion,
      compiledAt: now,
      needsRecompile: false,
      // Un prompt qui change invalide la suite : elle devra être rejouée.
      suitePassed: false,
      updatedAt: now,
    })
    .where(eq(assistants.id, assistantId));

  await db
    .insert(assistantVersions)
    .values({
      assistantId,
      version: row.version,
      snapshot: config,
      compiledPrompt: compiled.prompt,
      coreVersion: compiled.coreVersion,
      createdById: actorId,
    })
    .onConflictDoNothing();

  return {
    version: row.version,
    coreVersion: compiled.coreVersion,
    prompt: compiled.prompt,
    layers: compiled.layers,
  };
}

// ── Suite de garde-fous ──────────────────────────────────────────────────────

/** Bloc L7 d'une fixture — le tour est rejoué dans son contexte d'origine. */
function runtimeBlockFor(row: AssistantRow, config: AssistantConfig, fixture: FixtureData): string {
  const template = row.turnInstructions ?? DEFAULT_TURN_INSTRUCTIONS;
  const qualification = Object.entries(fixture.setup.qualification)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  const rung = fixture.setup.rung;
  const step =
    rung === "primary"
      ? config.goal.primary
      : (config.goal.fallbacks[Number(rung.split(":")[1] ?? 0)] ?? config.goal.primary);

  const { text } = renderTemplate(template, {
    "lead.prenom": "Marie",
    "lead.source": "Facebook",
    "lead.besoin": "vendre",
    "lead.secteur": "Québec",
    "lead.budget": "",
    qualification: qualification === "" ? "aucune" : qualification,
    "goal.type": step.type,
    "goal.rung": rung,
    "goal.required_fields": step.requiredFields.join(", ") || "aucune",
    slots: "jeudi 14h, vendredi 18h30",
    turns_used: fixture.setup.turnsUsed,
    max_turns: config.approach.maxTurns,
    soft_refusals: 0,
    now_local: "mercredi 14h00",
    send_window: "9h-20h",
    "assistant.name": config.name,
    org: config.identity.orgName,
  });
  return row.includeRuntimeLayer ? text : "";
}

export interface SuiteOutcome {
  runId: string;
  passed: boolean;
  results: FixtureResult[];
}

/**
 * Rejoue toutes les fixtures activées (core + celles de l'assistant) contre le
 * prompt compilé, outils SIMULÉS, et consigne l'exécution.
 */
export async function runAssistantSuite(
  assistantId: string,
  actorId: string | null,
): Promise<SuiteOutcome> {
  const row = await loadAssistant(assistantId);
  if (!row.compiledPrompt) throw new Error("assistant_not_compiled");
  const config = assistantRowToConfig(row);
  const core = await currentCore();

  const [coreFixtures, ownFixtures, rules] = await Promise.all([
    loadCoreFixtures(),
    loadAssistantFixtures(assistantId),
    resolvedRulesFor(assistantId),
  ]);
  const fixtures = runnableFixtures([...coreFixtures, ...ownFixtures]);

  const generator = getLlmProvider(config.model.provider);
  const classifier = getLlmProvider(config.model.classifier.provider);

  const [run] = await db
    .insert(guardrailRuns)
    .values({
      assistantId,
      assistantVersion: row.version,
      coreVersion: core.version,
      model: `${config.model.provider}/${config.model.model}`,
      triggeredById: actorId,
    })
    .returning({ id: guardrailRuns.id });

  // Une suite qui démarre INVALIDE immédiatement le vert précédent : si le
  // processus meurt en cours de route (délai Vercel, panne fournisseur),
  // l'assistant ne doit surtout pas rester activable sur une ancienne suite.
  await db
    .update(assistants)
    .set({ suitePassed: false, suiteRunId: run.id })
    .where(eq(assistants.id, assistantId));

  // Budget de temps : 14 fixtures × (générateur + juge) peuvent dépasser le
  // maxDuration de la route. On s'arrête proprement et on consigne l'échec
  // plutôt que de se faire tuer au milieu.
  const deadline = Date.now() + SUITE_BUDGET_MS;

  const results: FixtureResult[] = [];
  try {
  for (const fixture of fixtures) {
    if (Date.now() > deadline) {
      results.push({
        fixtureId: fixture.id ?? null,
        label: fixture.label,
        severity: fixture.severity,
        passed: false,
        reason: "budget de temps de la suite épuisé — non exécutée",
        output: "",
        toolsCalled: [],
      });
      continue;
    }
    const result = await runFixture(
      fixture,
      row.compiledPrompt,
      runtimeBlockFor(row, config, fixture),
      {
        generate: async ({ system, messages }) => {
          const out = await generator.generate({
            system,
            messages,
            model: config.model.model,
            maxTokens: config.model.maxTokens,
            temperature: config.model.temperature,
            routing: config.model.routing as unknown as Record<string, unknown>,
            // Les outils DOIVENT être offerts : sans eux le modèle ne peut
            // jamais en appeler un, `mustCallTool` échoue toujours et
            // `mustNotCallTool` réussit toujours — deux fixtures « STOP »
            // bloquantes restaient rouges pour de bon, rendant impossible
            // l'activation de tout assistant exigeant une suite verte.
            tools: toolDefsFor(config.tools),
          });
          // Outils SIMULÉS : on note les appels, aucun handler ne tourne.
          return {
            text: out.text,
            // `id` conservé : c'est lui qui rattache le résultat à l'appel.
            toolCalls: out.toolCalls.map((c) => ({ id: c.id, name: c.name })),
          };
        },
        judge: async ({ system, user }) => {
          const out = await classifier.generate({
            system,
            messages: [{ role: "user", content: user }],
            model: config.model.classifier.model,
            maxTokens: 300,
            temperature: 0,
          });
          return out.text;
        },
        rules,
      },
    );
    results.push(result);
  }
  } catch (err) {
    // Échec inattendu : on consigne l'exécution comme rouge AVANT de remonter.
    const finishedAt = new Date();
    await db
      .update(guardrailRuns)
      .set({
        finishedAt,
        passed: false,
        results: [
          ...results,
          {
            fixtureId: null,
            label: "exécution interrompue",
            severity: "block",
            passed: false,
            reason: err instanceof Error ? err.message : String(err),
            output: "",
            toolsCalled: [],
          },
        ],
      })
      .where(eq(guardrailRuns.id, run.id));
    throw err;
  }

  const passed = suitePassed(results);
  const finishedAt = new Date();
  await db
    .update(guardrailRuns)
    .set({ finishedAt, passed, results })
    .where(eq(guardrailRuns.id, run.id));
  await db
    .update(assistants)
    .set({ suitePassed: passed, suiteRunId: run.id, updatedAt: finishedAt })
    .where(eq(assistants.id, assistantId));

  return { runId: run.id, passed, results };
}

// ── Porte d'activation (§11.4) ───────────────────────────────────────────────

export type ActivationRefusal = "stale_compile" | "suite_not_passed";

export interface ActivationCheck {
  allowed: boolean;
  reason?: ActivationRefusal;
  /** Fixtures bloquantes en échec — nommées dans l'infobulle de l'UI. */
  failingFixtures: string[];
}

export async function checkActivation(assistantId: string): Promise<ActivationCheck> {
  const row = await loadAssistant(assistantId);
  const core = await currentCore();

  if (!row.compiledPrompt || row.compiledCoreVersion !== core.version || row.needsRecompile) {
    return { allowed: false, reason: "stale_compile", failingFixtures: [] };
  }
  if (row.requireSuitePass && !row.suitePassed) {
    const failing: string[] = [];
    if (row.suiteRunId) {
      const run = await db.query.guardrailRuns.findFirst({
        where: eq(guardrailRuns.id, row.suiteRunId),
      });
      const results = (run?.results as FixtureResult[] | null) ?? [];
      failing.push(...results.filter((r) => !r.passed && r.severity === "block").map((r) => r.label));
    }
    return { allowed: false, reason: "suite_not_passed", failingFixtures: failing };
  }
  return { allowed: true, failingFixtures: [] };
}

export async function activateAssistant(assistantId: string): Promise<ActivationCheck> {
  const check = await checkActivation(assistantId);
  if (!check.allowed) return check;
  await db
    .update(assistants)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(assistants.id, assistantId));
  return check;
}
