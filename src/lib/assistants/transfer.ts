import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  assistants,
  guardrailFixtures,
  guardrailRules,
  objectionPacks,
} from "@/db/schema-sms";
import { fixtureRowToData, loadCoreRules, ruleRowToData } from "@/lib/guardrails/store";
import type { DocLocale } from "@/lib/docs/types";
import { objectionItemSchema, parseRuleConfig } from "@/lib/guardrails/types";
import { assistantRowToConfig, type AssistantConfig } from "./schema";
import { compileAssistant, runAssistantSuite } from "./service";
import {
  buildBundle,
  parseBundle,
  planImport,
  serializeBundle,
  userBindingPaths,
  type AssistantBundle,
  type Binding,
  type ImportCatalog,
  type ImportWarning,
} from "./portable";

/**
 * Import / export côté serveur : lit la base, appelle le module pur, écrit.
 *
 * Un import produit TOUJOURS un brouillon, quel que soit l'état de l'assistant
 * d'origine. Le fichier vient d'ailleurs : ses garde-fous n'ont jamais été
 * exécutés contre le noyau de CETTE installation, et son prompt a été compilé
 * contre un autre. On compile et on exécute la suite ici — c'est le résultat
 * local qui décide, jamais celui inscrit dans le fichier.
 */

async function labelsFor(config: AssistantConfig): Promise<Record<string, { label: string; hint: string }>> {
  const labels: Record<string, { label: string; hint: string }> = {};

  const userIds = userBindingPaths(config)
    .map((path) => readString(config, path))
    .filter((v): v is string => v !== null);
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(inArray(users.id, userIds));
    for (const row of rows) labels[row.id] = { label: row.name, hint: `${row.email} · ${row.role}` };
  }

  if (config.objectionPacks.length > 0) {
    const rows = await db
      .select({ id: objectionPacks.id, label: objectionPacks.label })
      .from(objectionPacks)
      .where(inArray(objectionPacks.id, config.objectionPacks));
    for (const row of rows) labels[row.id] = { label: row.label, hint: "paquet d'objections" };
  }

  return labels;
}

function readString(config: AssistantConfig, path: string): string | null {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let node: unknown = config;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

export interface ExportOptions {
  /** Annoté par défaut (§15.3) : un fichier relu six mois plus tard. */
  annotate?: boolean;
  now?: Date;
  /** Langue des annotations — celle de qui exporte, pas celle de l'assistant. */
  locale?: DocLocale;
}

export async function exportAssistant(
  assistantId: string,
  options: ExportOptions = {},
): Promise<AssistantBundle> {
  const row = await db.query.assistants.findFirst({ where: eq(assistants.id, assistantId) });
  if (!row) throw new Error("assistant_not_found");
  const config = assistantRowToConfig(row);

  const [ruleRows, fixtureRows, packRows] = await Promise.all([
    db.select().from(guardrailRules).where(eq(guardrailRules.assistantId, assistantId)),
    db.select().from(guardrailFixtures).where(eq(guardrailFixtures.assistantId, assistantId)),
    config.objectionPacks.length > 0
      ? db.select().from(objectionPacks).where(inArray(objectionPacks.id, config.objectionPacks))
      : Promise.resolve([]),
  ]);

  return buildBundle({
    config,
    rules: ruleRows.map(ruleRowToData),
    fixtures: fixtureRows.map(fixtureRowToData),
    objectionPacks: packRows.map((p) => {
      // Un paquet au contenu illisible n'est pas exporté en silence : le
      // fichier serait refusé à l'import sans dire pourquoi.
      const items = objectionItemSchema.array().safeParse(p.items ?? []);
      if (!items.success) throw new Error(`objection_pack_invalid:${p.id}`);
      return { id: p.id, label: p.label, language: p.language, items: items.data, isBuiltin: p.isBuiltin };
    }),
    labels: await labelsFor(config),
    sourceOrg: config.identity.orgName,
    now: options.now ?? new Date(),
    annotate: options.annotate,
    locale: options.locale,
  });
}

export async function exportAssistantFile(
  assistantId: string,
  options: ExportOptions = {},
): Promise<{ filename: string; body: string }> {
  const bundle = await exportAssistant(assistantId, options);
  const slug = bundle.assistant.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return {
    filename: `assistant-${slug || (options.locale === "en" ? "untitled" : "sans-nom")}.json`,
    body: serializeBundle(bundle),
  };
}

// ── Import ───────────────────────────────────────────────────────────────────

export interface ImportPreview {
  bundle: AssistantBundle;
  bindings: Binding[];
  /** Candidats locaux proposés pour chaque liaison d'utilisateur. */
  userChoices: { id: string; name: string; email: string; role: string }[];
  packChoices: { id: string; label: string }[];
  warnings: ImportWarning[];
}

/**
 * Relit un fichier et prépare l'écran de liaison, SANS rien écrire.
 *
 * `resolution` (liaisons déjà choisies) est acceptée pour que les
 * avertissements reflètent les choix en cours, pas un état « rien de résolu ».
 */
export async function previewImport(
  raw: unknown,
  resolution: Record<string, string | null> = {},
): Promise<ImportPreview> {
  const { bundle, warnings } = parseBundle(raw);
  const [userRows, packRows, coreRules] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.isActive, true)),
    db.select({ id: objectionPacks.id, label: objectionPacks.label }).from(objectionPacks),
    loadCoreRules(),
  ]);

  const catalog: ImportCatalog = {
    userIds: new Set(userRows.map((u) => u.id)),
    packIds: new Set(packRows.map((p) => p.id)),
    coreRuleKeys: new Set(coreRules.map((r) => r.key)),
  };
  const plan = planImport(bundle, catalog, resolution);

  return {
    bundle,
    bindings: bundle.bindings,
    userChoices: userRows,
    packChoices: packRows,
    warnings: [...warnings, ...plan.warnings],
  };
}

export interface ImportResult {
  assistantId: string;
  warnings: ImportWarning[];
  compiled: boolean;
  /** Pourquoi la compilation a échoué — distinct d'un échec de suite : l'un
   * veut dire « le prompt n'existe pas », l'autre « il se comporte mal ». */
  compileError: string | null;
  suitePassed: boolean;
  suiteError: string | null;
}

export interface ImportOptions {
  /** valeur d'origine → identifiant local choisi par l'administrateur. */
  resolution?: Record<string, string | null>;
  actorId: string | null;
  /** Exécuter la suite après l'import (par défaut oui). */
  runSuite?: boolean;
  /** Nom imposé — sinon celui du fichier, suffixé s'il est déjà pris. */
  nameOverride?: string;
}

export async function importAssistant(
  raw: unknown,
  options: ImportOptions,
): Promise<ImportResult> {
  const { bundle, warnings: parseWarnings } = parseBundle(raw);

  const [userRows, packRows, coreRules] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.isActive, true)),
    db.select({ id: objectionPacks.id }).from(objectionPacks),
    loadCoreRules(),
  ]);
  const catalog: ImportCatalog = {
    userIds: new Set(userRows.map((u) => u.id)),
    packIds: new Set(packRows.map((p) => p.id)),
    coreRuleKeys: new Set(coreRules.map((r) => r.key)),
  };

  const plan = planImport(bundle, catalog, options.resolution ?? {});
  const config = plan.config;
  config.name = options.nameOverride ?? (await uniqueName(config.name));

  const assistantId = await db.transaction(async (tx) => {
    for (const pack of plan.packsToCreate) {
      await tx
        .insert(objectionPacks)
        .values({
          id: pack.id,
          label: pack.label,
          language: pack.language,
          items: pack.items,
          // Un paquet venu d'un fichier n'est JAMAIS intégré : « intégré »
          // signifie « semé par cette installation », et c'est ce drapeau qui
          // décide de ce que « Réinitialiser » restaure.
          isBuiltin: false,
        })
        .onConflictDoNothing();
    }

    const [row] = await tx
      .insert(assistants)
      .values({
        name: config.name,
        description: config.description,
        // Brouillon imposé : voir l'entête.
        status: "draft",
        language: config.language,
        identity: config.identity,
        goal: config.goal,
        approach: config.approach,
        knowledge: config.knowledge,
        objectionPacks: config.objectionPacks,
        tools: config.tools,
        model: config.model,
        promptMode: config.promptMode,
        systemPromptOverride: config.systemPromptOverride,
        layerOverrides: config.layerOverrides,
        turnInstructions: config.turnInstructions,
        includeRuntimeLayer: config.includeRuntimeLayer,
        requireSuitePass: config.requireSuitePass,
        needsRecompile: true,
        suitePassed: false,
        createdById: options.actorId,
      })
      .returning({ id: assistants.id });

    for (const rule of plan.rules) {
      await tx.insert(guardrailRules).values({
        scope: "assistant",
        assistantId: row.id,
        key: rule.key,
        label: rule.label,
        description: rule.description,
        kind: rule.kind,
        // Config NORMALISÉE (défauts posés), comme l'API à la création : la
        // lecture du fichier l'a déjà validée selon le `kind`.
        config: parseRuleConfig(rule.kind, rule.config ?? {}) as Record<string, unknown>,
        promptText: rule.promptText,
        severity: rule.severity,
        origin: "imported",
        overridesKey: rule.overridesKey,
        enabled: rule.enabled,
        orderIndex: rule.orderIndex,
        updatedById: options.actorId,
      });
    }

    for (const fixture of plan.fixtures) {
      await tx.insert(guardrailFixtures).values({
        scope: "assistant",
        assistantId: row.id,
        key: fixture.key,
        label: fixture.label,
        setup: fixture.setup,
        inbound: fixture.inbound,
        expectations: fixture.expectations,
        severity: fixture.severity,
        origin: "imported",
        enabled: fixture.enabled,
        orderIndex: fixture.orderIndex,
      });
    }

    return row.id;
  });

  const warnings = [...parseWarnings, ...plan.warnings];

  // Compilation et suite HORS transaction : la suite appelle le modèle, ce qui
  // immobiliserait une connexion du pool pendant des minutes.
  let compiled = false;
  let compileError: string | null = null;
  let suiteOk = false;
  let suiteError: string | null = null;
  try {
    await compileAssistant(assistantId, options.actorId);
    compiled = true;
  } catch (error) {
    compileError = error instanceof Error ? error.message : "compile_failed";
  }

  if (compiled && options.runSuite !== false) {
    try {
      const outcome = await runAssistantSuite(assistantId, options.actorId);
      suiteOk = outcome.passed;
    } catch (error) {
      suiteError = error instanceof Error ? error.message : "suite_failed";
    }
  }

  return { assistantId, warnings, compiled, compileError, suitePassed: suiteOk, suiteError };
}

/** « Acheteur FB » importé deux fois donne « Acheteur FB (2) ». */
async function uniqueName(base: string): Promise<string> {
  const rows = await db.select({ name: assistants.name }).from(assistants);
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}
