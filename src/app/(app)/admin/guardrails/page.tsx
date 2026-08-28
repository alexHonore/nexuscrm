import { asc, desc, isNull } from "drizzle-orm";
import { ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import {
  GuardrailsClient,
  type GuardrailFixtureDto,
  type GuardrailRuleDto,
  type PromptCoreDto,
} from "@/components/admin/guardrails-client";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { guardrailFixtures, guardrailRules, promptCores } from "@/db/schema-sms";
import type { GuardrailKind, GuardrailSeverity } from "@/lib/guardrails/types";
import { requirePerm } from "@/lib/permissions/server";

export default async function AdminGuardrailsPage() {
  await requirePerm("admin.guardrails");
  const t = await getTranslations("assistants");

  const [ruleRows, fixtureRows, coreRows] = await Promise.all([
    db
      .select()
      .from(guardrailRules)
      .where(isNull(guardrailRules.assistantId))
      .orderBy(asc(guardrailRules.orderIndex), asc(guardrailRules.key)),
    db
      .select()
      .from(guardrailFixtures)
      .where(isNull(guardrailFixtures.assistantId))
      .orderBy(asc(guardrailFixtures.orderIndex)),
    db.select().from(promptCores).orderBy(desc(promptCores.version)).limit(1),
  ]);

  const rules: GuardrailRuleDto[] = ruleRows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    description: r.description,
    config: r.config,
    promptText: r.promptText,
    kind: r.kind as GuardrailKind,
    severity: r.severity as GuardrailSeverity,
    enabled: r.enabled,
    modifiedFromDefault: r.modifiedFromDefault,
    updatedAt: r.updatedAt.toISOString(),
  }));

  const fixtures: GuardrailFixtureDto[] = fixtureRows.map((f) => ({
    id: f.id,
    label: f.label,
    inbound: f.inbound,
    setup: f.setup,
    expectations: f.expectations,
    severity: f.severity as GuardrailSeverity,
    enabled: f.enabled,
    modifiedFromDefault: f.modifiedFromDefault,
    updatedAt: f.updatedAt.toISOString(),
  }));

  const coreRow = coreRows[0];
  const core: PromptCoreDto = coreRow
    ? { version: coreRow.version, body: coreRow.body, createdAt: coreRow.createdAt.toISOString() }
    : null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <PageHeader icon={<ShieldCheck />} title={t("guardrails.title")} subtitle={t("guardrails.subtitle")} />
      <GuardrailsClient rules={rules} fixtures={fixtures} core={core} />
    </div>
  );
}
