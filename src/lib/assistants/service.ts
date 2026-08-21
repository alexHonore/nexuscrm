import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistants, assistantVersions, guardrailRuns, objectionPacks } from "@/db/schema-sms";
import { compileAssistantPrompt, type ObjectionPack } from "@/lib/agent/compile";
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
import { objectionItemSchema, type FixtureData, type FixtureResult } from "@/lib/guardrails/types";
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
 *
 * Deux écritures ici sont des « compare-and-set » : la fin de la compilation
 * et la fin de la suite. Toutes deux durent (la suite, jusqu'à quatre minutes)
 * et écrivent des drapeaux que la porte d'activation lit. Entre-temps, un
 * autre onglet, un import ou un collègue a pu enregistrer une configuration ou
 * recompiler : écrire sans condition poserait alors un vert obtenu contre un
 * prompt qui n'existe plus, ou effacerait un drapeau de recompilation tout
 * juste posé. Le point de comparaison est `updated_at` (toute écriture de
 * config le bouge) et `compiled_at`.
 */

/** Marge sous le maxDuration de la route (300 s) pour finir proprement. */
const SUITE_BUDGET_MS = 240_000;

type AssistantRow = typeof assistants.$inferSelect;

async function loadAssistant(assistantId: string): Promise<AssistantRow> {
  const row = await db.query.assistants.findFirst({ where: eq(assistants.id, assistantId) });
  if (!row) throw new Error("assistant_not_found");
  return row;
}

/**
 * Égalité d'horodatage robuste : Postgres garde les microsecondes, le pilote
 * JS tronque à la milliseconde. Comparer les deux bruts ferait échouer la
 * condition sur toute rangée écrite par un `now()` de la base.
 */
function sameInstant(column: typeof assistants.updatedAt | typeof assistants.compiledAt, value: Date | null) {
  // ISO explicite : dans un fragment `sql`, le pilote ne sérialise pas un Date.
  return value === null
    ? sql`${column} is null`
    : sql`date_trunc('milliseconds', ${column}) = ${value.toISOString()}::timestamptz`;
}

async function loadPacks(ids: string[]): Promise<ObjectionPack[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(objectionPacks);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is (typeof rows)[number] => row !== undefined)
    .map((row) => {
      // Un paquet au contenu illisible (jsonb bricolé, fichier importé) ne
      // doit pas compiler du charabia dans le prompt : l'erreur nomme le paquet.
      const items = objectionItemSchema.array().safeParse(row.items ?? []);
      if (!items.success) throw new Error(`objection_pack_invalid:${row.id}`);
      return { id: row.id, label: row.label, items: items.data };
    });
}

/** Règles applicables à un assistant : core + ses forks, dans l'ordre résolu. */
export async function resolvedRulesFor(assistantId: string) {
  const [core, own] = await Promise.all([loadCoreRules(), loadAssistantRules(assistantId)]);
  return resolveRules(core, own);
}

// ── Compilation ──────────────────────────────────────────────────────────────

export interface CompileResult {
  /** Nouveau numéro de version — incrémenté à CHAQUE compilation. */
  version: number;
  coreVersion: number;
  prompt: string;
  layers: { id: string; source: string; text: string }[];
}

/**
 * Compile L0-L6, incrémente la version, gèle un instantané et efface
 * `needs_recompile`. Toute sauvegarde de config repose le drapeau — un prompt
 * périmé est un bogue, jamais un choix.
 *
 * La version monte à chaque compilation : c'est elle que les traces, les
 * exécutions de suite et les conversations référencent. Sans incrément, seul
 * le premier prompt était gelé et « reconstituer ce que disait l'assistant le
 * mois dernier » devenait impossible.
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

  // Un prompt vide (mode libre sans texte) n'est pas un prompt : on refuse
  // ici plutôt que de l'enregistrer et de laisser la porte le découvrir sous
  // un « stale_compile » trompeur.
  if (compiled.prompt.trim() === "") throw new Error("empty_prompt");

  const now = new Date();
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(assistants)
      .set({
        version: sql`${assistants.version} + 1`,
        compiledPrompt: compiled.prompt,
        compiledCoreVersion: compiled.coreVersion,
        compiledAt: now,
        needsRecompile: false,
        // Un prompt qui change invalide la suite : elle devra être rejouée.
        suitePassed: false,
        updatedAt: now,
      })
      // Compare-and-set : si la configuration a bougé depuis la lecture, ce
      // prompt a été compilé à partir d'une config qui n'est plus celle de la
      // rangée — et effacer `needs_recompile` mentirait.
      .where(and(eq(assistants.id, assistantId), sameInstant(assistants.updatedAt, row.updatedAt)))
      .returning({ version: assistants.version });
    if (!updated) throw new Error("assistant_changed_during_compile");

    await tx.insert(assistantVersions).values({
      assistantId,
      version: updated.version,
      snapshot: config,
      compiledPrompt: compiled.prompt,
      coreVersion: compiled.coreVersion,
      createdById: actorId,
    });

    return {
      version: updated.version,
      coreVersion: compiled.coreVersion,
      prompt: compiled.prompt,
      layers: compiled.layers,
    };
  });
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
  /**
   * Vrai quand la configuration ou le prompt a changé PENDANT l'exécution :
   * les résultats décrivent un assistant qui n'existe plus, le drapeau
   * `suite_passed` est resté faux et la suite est à relancer.
   */
  superseded: boolean;
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
  // L'empreinte renvoyée (updated_at, compiled_at) est celle que la fin de
  // la suite devra retrouver intacte pour avoir le droit d'écrire son vert.
  const [claimed] = await db
    .update(assistants)
    .set({ suitePassed: false, suiteRunId: run.id })
    .where(eq(assistants.id, assistantId))
    .returning({ updatedAt: assistants.updatedAt, compiledAt: assistants.compiledAt });

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
            ...(config.model.reasoningEffort === "none"
              ? {}
              : { reasoningEffort: config.model.reasoningEffort }),
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

  // Compare-and-set : le vert ne se pose que sur la rangée TELLE QUE la suite
  // l'a testée. Une sauvegarde, une recompilation, une règle de noyau changée
  // ou une autre suite lancée entre-temps font échouer la condition — et
  // `suite_passed` reste faux, comme la réclamation du début l'a posé.
  const [settled] = await db
    .update(assistants)
    .set({ suitePassed: passed, suiteRunId: run.id, updatedAt: finishedAt })
    .where(
      and(
        eq(assistants.id, assistantId),
        eq(assistants.suiteRunId, run.id),
        sameInstant(assistants.updatedAt, claimed?.updatedAt ?? row.updatedAt),
        sameInstant(assistants.compiledAt, claimed?.compiledAt ?? row.compiledAt),
      ),
    )
    .returning({ id: assistants.id });
  const superseded = !settled;

  await db
    .update(guardrailRuns)
    .set({
      finishedAt,
      // Une exécution dépassée est consignée ROUGE : afficher « 14/14 » en vert
      // pour un prompt qui n'existe plus ferait croire à une suite valable.
      passed: passed && !superseded,
      results: superseded
        ? [
            ...results,
            {
              fixtureId: null,
              label: "configuration modifiée pendant la suite — résultat écarté",
              severity: "block",
              passed: false,
              reason: "la configuration ou le prompt a changé pendant l'exécution : relancer la suite",
              output: "",
              toolsCalled: [],
            },
          ]
        : results,
    })
    .where(eq(guardrailRuns.id, run.id));

  return { runId: run.id, passed: passed && !superseded, results, superseded };
}

// ── Porte d'activation (§11.4) ───────────────────────────────────────────────

export type ActivationRefusal = "archived" | "stale_compile" | "suite_not_passed";

export interface ActivationCheck {
  allowed: boolean;
  reason?: ActivationRefusal;
  /** Fixtures bloquantes en échec — nommées dans l'infobulle de l'UI. */
  failingFixtures: string[];
}

export async function checkActivation(assistantId: string): Promise<ActivationCheck> {
  const row = await loadAssistant(assistantId);

  // « Archivé » est terminal : l'assistant a été retiré parce qu'il avait
  // parlé à des clients. Le remettre en service par la même porte qu'un
  // brouillon le ferait réapparaître dans les campagnes sans que personne ne
  // l'ait décidé explicitement.
  if (row.status === "archived") {
    return { allowed: false, reason: "archived", failingFixtures: [] };
  }

  const core = await currentCore();
  // Un prompt vide ou blanc n'est pas plus un prompt qu'un NULL (même règle
  // que le trigger : btrim(compiled_prompt) = '').
  if (
    !row.compiledPrompt ||
    row.compiledPrompt.trim() === "" ||
    row.compiledCoreVersion !== core.version ||
    row.needsRecompile
  ) {
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

export type DeactivationResult =
  | { ok: true; changed: boolean; status: "draft" }
  | { ok: false; reason: "archived" };

/**
 * Retire un assistant du service : il repasse en BROUILLON. Pas de porte ici
 * (on ne fait qu'ôter), mais un assistant archivé reste archivé — le
 * brouillon est l'état d'où l'on réactive, et l'archivage est terminal.
 */
export async function deactivateAssistant(assistantId: string): Promise<DeactivationResult> {
  const row = await loadAssistant(assistantId);
  if (row.status === "archived") return { ok: false, reason: "archived" };
  if (row.status === "draft") return { ok: true, changed: false, status: "draft" };
  await db
    .update(assistants)
    .set({ status: "draft", updatedAt: new Date() })
    .where(eq(assistants.id, assistantId));
  return { ok: true, changed: true, status: "draft" };
}
