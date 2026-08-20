import "server-only";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  guardrailFixtures,
  guardrailRules,
  objectionPacks,
  promptCores,
} from "@/db/schema-sms";
import {
  CORE_PROMPT_V1,
  DEFAULT_GUARDRAIL_FIXTURES,
  DEFAULT_GUARDRAIL_RULES,
  DEFAULT_OBJECTION_PACKS,
} from "./kernel";
import type { FixtureData, GuardrailKind, GuardrailSeverity, RuleData } from "./types";
import { fixtureExpectationsSchema, fixtureSetupSchema } from "./types";

/**
 * Accès base des garde-fous : semence idempotente, lecture typée, et le
 * « Réinitialiser » qui restaure exactement l'état d'origine.
 *
 * Le moteur lit TOUJOURS ces rangées. Rien ici ne réintroduit une règle que
 * l'admin a désactivée : `seedGuardrailDefaults` n'insère que ce qui manque
 * (onConflictDoNothing), et seul un « réinitialiser » explicite réécrit une
 * rangée existante.
 */

type RuleRow = typeof guardrailRules.$inferSelect;
type FixtureRow = typeof guardrailFixtures.$inferSelect;

export function ruleRowToData(row: RuleRow): RuleData {
  return {
    id: row.id,
    scope: row.scope === "assistant" ? "assistant" : "core",
    assistantId: row.assistantId,
    key: row.key,
    label: row.label,
    description: row.description,
    kind: row.kind as GuardrailKind,
    config: row.config,
    promptText: row.promptText,
    severity: row.severity as GuardrailSeverity,
    enabled: row.enabled,
    overridesKey: row.overridesKey,
    orderIndex: row.orderIndex,
  };
}

export function fixtureRowToData(row: FixtureRow): FixtureData {
  return {
    id: row.id,
    scope: row.scope === "assistant" ? "assistant" : "core",
    assistantId: row.assistantId,
    label: row.label,
    setup: fixtureSetupSchema.parse(row.setup),
    inbound: row.inbound,
    expectations: fixtureExpectationsSchema.parse(row.expectations),
    severity: row.severity as GuardrailSeverity,
    enabled: row.enabled,
    orderIndex: row.orderIndex,
  };
}

// ── Lecture ──────────────────────────────────────────────────────────────────

export async function loadCoreRules(): Promise<RuleData[]> {
  const rows = await db
    .select()
    .from(guardrailRules)
    .where(isNull(guardrailRules.assistantId))
    .orderBy(asc(guardrailRules.orderIndex), asc(guardrailRules.key));
  return rows.map(ruleRowToData);
}

export async function loadAssistantRules(assistantId: string): Promise<RuleData[]> {
  const rows = await db
    .select()
    .from(guardrailRules)
    .where(eq(guardrailRules.assistantId, assistantId))
    .orderBy(asc(guardrailRules.orderIndex), asc(guardrailRules.key));
  return rows.map(ruleRowToData);
}

export async function loadCoreFixtures(): Promise<FixtureData[]> {
  const rows = await db
    .select()
    .from(guardrailFixtures)
    .where(isNull(guardrailFixtures.assistantId))
    .orderBy(asc(guardrailFixtures.orderIndex));
  return rows.map(fixtureRowToData);
}

export async function loadAssistantFixtures(assistantId: string): Promise<FixtureData[]> {
  const rows = await db
    .select()
    .from(guardrailFixtures)
    .where(eq(guardrailFixtures.assistantId, assistantId))
    .orderBy(asc(guardrailFixtures.orderIndex));
  return rows.map(fixtureRowToData);
}

/** Version courante du corps L0 — la porte d'activation la compare. */
export async function currentCore(): Promise<{ version: number; body: string }> {
  const [latest] = await db
    .select({ version: promptCores.version, body: promptCores.body })
    .from(promptCores)
    .orderBy(desc(promptCores.version))
    .limit(1);
  if (!latest) throw new Error("prompt_cores vide : exécuter le seed SMS");
  return latest;
}

// ── Semence ──────────────────────────────────────────────────────────────────

/**
 * Insère ce qui manque. Idempotent : rejouer le seed ne ressuscite pas une
 * règle supprimée par l'admin dans la même exécution… mais un `reset` explicite
 * le fait, et c'est le bouton prévu pour ça (§16.6).
 */
export async function seedGuardrailDefaults(): Promise<{
  core: boolean;
  rules: number;
  fixtures: number;
  packs: number;
}> {
  const coreInserted = await db
    .insert(promptCores)
    .values({ version: 1, body: CORE_PROMPT_V1, notes: "Semence initiale (cahier §10.1)" })
    .onConflictDoNothing()
    .returning({ version: promptCores.version });

  let rules = 0;
  for (const rule of DEFAULT_GUARDRAIL_RULES) {
    const snapshot = {
      label: rule.label,
      description: rule.description ?? null,
      kind: rule.kind,
      config: rule.config,
      promptText: rule.promptText,
      severity: rule.severity,
      enabled: true,
      orderIndex: rule.orderIndex,
    };
    const inserted = await db
      .insert(guardrailRules)
      .values({
        scope: "core",
        assistantId: null,
        key: rule.key,
        label: rule.label,
        description: rule.description ?? null,
        kind: rule.kind,
        config: rule.config as Record<string, unknown>,
        promptText: rule.promptText,
        severity: rule.severity,
        origin: "default",
        defaultSnapshot: snapshot,
        modifiedFromDefault: false,
        enabled: true,
        orderIndex: rule.orderIndex,
      })
      .onConflictDoNothing()
      .returning({ id: guardrailRules.id });
    rules += inserted.length;
  }

  let fixtures = 0;
  const existing = await db
    .select({ label: guardrailFixtures.label })
    .from(guardrailFixtures)
    .where(isNull(guardrailFixtures.assistantId));
  const known = new Set(existing.map((row) => row.label));
  for (const fixture of DEFAULT_GUARDRAIL_FIXTURES) {
    if (known.has(fixture.label)) continue;
    const snapshot = {
      label: fixture.label,
      setup: fixture.setup,
      inbound: fixture.inbound,
      expectations: fixture.expectations,
      severity: fixture.severity,
      enabled: true,
      orderIndex: fixture.orderIndex,
    };
    await db.insert(guardrailFixtures).values({
      scope: "core",
      assistantId: null,
      label: fixture.label,
      setup: fixture.setup,
      inbound: fixture.inbound,
      expectations: fixture.expectations,
      severity: fixture.severity,
      origin: "default",
      defaultSnapshot: snapshot,
      modifiedFromDefault: false,
      enabled: true,
      orderIndex: fixture.orderIndex,
    });
    fixtures += 1;
  }

  let packs = 0;
  for (const pack of DEFAULT_OBJECTION_PACKS) {
    const inserted = await db
      .insert(objectionPacks)
      .values({
        id: pack.id,
        label: pack.label,
        language: pack.language,
        items: pack.items,
        isBuiltin: true,
      })
      .onConflictDoNothing()
      .returning({ id: objectionPacks.id });
    packs += inserted.length;
  }

  return { core: coreInserted.length > 0, rules, fixtures, packs };
}

/**
 * « Tout réinitialiser aux valeurs par défaut » (§16.6) : restaure chaque
 * rangée `origin='default'` depuis son instantané ET recrée celles qui ont été
 * supprimées. C'est le bouton d'annulation de toute la section.
 */
export async function resetGuardrailDefaults(): Promise<{ restored: number; recreated: number }> {
  let restored = 0;

  const ruleRows = await db
    .select()
    .from(guardrailRules)
    .where(and(isNull(guardrailRules.assistantId), eq(guardrailRules.origin, "default")));
  for (const row of ruleRows) {
    const snapshot = row.defaultSnapshot as Record<string, unknown> | null;
    if (!snapshot) continue;
    await db
      .update(guardrailRules)
      .set({
        label: String(snapshot.label ?? row.label),
        description: (snapshot.description as string | null) ?? null,
        kind: String(snapshot.kind ?? row.kind),
        config: (snapshot.config as Record<string, unknown>) ?? {},
        promptText: (snapshot.promptText as string | null) ?? null,
        severity: String(snapshot.severity ?? "block"),
        enabled: snapshot.enabled !== false,
        orderIndex: Number(snapshot.orderIndex ?? row.orderIndex),
        modifiedFromDefault: false,
        updatedAt: new Date(),
      })
      .where(eq(guardrailRules.id, row.id));
    restored += 1;
  }

  const fixtureRows = await db
    .select()
    .from(guardrailFixtures)
    .where(and(isNull(guardrailFixtures.assistantId), eq(guardrailFixtures.origin, "default")));
  for (const row of fixtureRows) {
    const snapshot = row.defaultSnapshot as Record<string, unknown> | null;
    if (!snapshot) continue;
    await db
      .update(guardrailFixtures)
      .set({
        label: String(snapshot.label ?? row.label),
        setup: snapshot.setup ?? {},
        inbound: String(snapshot.inbound ?? row.inbound),
        expectations: snapshot.expectations ?? {},
        severity: String(snapshot.severity ?? "block"),
        enabled: snapshot.enabled !== false,
        orderIndex: Number(snapshot.orderIndex ?? row.orderIndex),
        modifiedFromDefault: false,
        updatedAt: new Date(),
      })
      .where(eq(guardrailFixtures.id, row.id));
    restored += 1;
  }

  // Recrée ce qui a été supprimé.
  const before = await db.select({ id: guardrailRules.id }).from(guardrailRules);
  const seeded = await seedGuardrailDefaults();
  const after = await db.select({ id: guardrailRules.id }).from(guardrailRules);

  return { restored, recreated: after.length - before.length + seeded.fixtures };
}
