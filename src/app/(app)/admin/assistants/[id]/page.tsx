import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AssistantEditor } from "@/components/admin/assistant-editor";
import type { ParamDocView } from "@/components/admin/assistant-editor/param-help";
import type { AssistantEditorData, EditorRule, EditorRun } from "@/components/admin/assistant-editor/types";
import { db } from "@/db";
import { users } from "@/db/schema";
import { assistants, guardrailRules, guardrailRuns, objectionPacks } from "@/db/schema-sms";
import { requireAdmin } from "@/lib/auth/guards";
import { assistantRowToConfig } from "@/lib/assistants/schema";
import { getParamDocs } from "@/lib/docs-server";
import type { GuardrailKind, GuardrailSeverity } from "@/lib/guardrails/types";

export default async function AssistantEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const { tab } = await searchParams;

  // Un segment qui n'est pas un UUID donnerait une erreur Postgres (500) au
  // lieu d'une page introuvable : une faute de frappe n'est pas une panne.
  if (!z.uuid().safeParse(id).success) notFound();

  const row = await db.query.assistants.findFirst({ where: eq(assistants.id, id) });
  if (!row) notFound();

  const [userRows, packRows, coreRuleRows, ownRuleRows, runRows, docs] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(asc(users.name)),
    db.select().from(objectionPacks).orderBy(asc(objectionPacks.label)),
    db
      .select()
      .from(guardrailRules)
      .where(isNull(guardrailRules.assistantId))
      .orderBy(asc(guardrailRules.orderIndex), asc(guardrailRules.key)),
    db
      .select()
      .from(guardrailRules)
      .where(eq(guardrailRules.assistantId, id))
      .orderBy(asc(guardrailRules.orderIndex), asc(guardrailRules.key)),
    db
      .select()
      .from(guardrailRuns)
      .where(and(eq(guardrailRuns.assistantId, id), eq(guardrailRuns.assistantVersion, row.version)))
      .orderBy(desc(guardrailRuns.startedAt))
      .limit(1),
    getParamDocs(),
  ]);

  const toRule = (r: typeof coreRuleRows[number]): EditorRule => ({
    id: r.id,
    key: r.key,
    label: r.label,
    kind: r.kind as GuardrailKind,
    severity: r.severity as GuardrailSeverity,
    enabled: r.enabled,
  });

  const runRow = runRows[0];
  const results =
    (runRow?.results as EditorRun["results"] | null | undefined)?.map((r) => ({
      label: r.label,
      passed: r.passed,
      severity: r.severity,
      reason: r.reason,
      output: r.output,
    })) ?? [];

  const lastRun: EditorRun | null = runRow
    ? {
        id: runRow.id,
        passed: runRow.passed ?? false,
        total: results.length,
        passedCount: results.filter((r) => r.passed).length,
        createdAt: runRow.startedAt.toISOString(),
        results,
      }
    : null;

  const data: AssistantEditorData = {
    id: row.id,
    config: assistantRowToConfig(row),
    status: row.status,
    version: row.version,
    suitePassed: row.suitePassed,
    needsRecompile: row.needsRecompile,
    compiledPrompt: row.compiledPrompt,
    compiledAt: row.compiledAt?.toISOString() ?? null,
    users: userRows,
    packs: packRows.map((p) => ({
      id: p.id,
      label: p.label,
      itemCount: Array.isArray(p.items) ? p.items.length : 0,
    })),
    coreRules: coreRuleRows.map(toRule),
    ownRules: ownRuleRows.map(toRule),
    lastRun,
  };

  // Le registre descend en une fois : chaque champ y puise son aide plutôt que
  // de la porter en dur, ce qui la ferait diverger du schéma.
  const docsByPath: Record<string, ParamDocView> = Object.fromEntries(
    docs.map((d) => [d.path, d]),
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <AssistantEditor data={data} docs={docsByPath} initialTab={tab} />
    </div>
  );
}
