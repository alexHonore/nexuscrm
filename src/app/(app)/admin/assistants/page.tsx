import { asc, desc, eq, sql } from "drizzle-orm";
import { Bot } from "lucide-react";
import { getTranslations } from "next-intl/server";
import {
  AssistantsListClient,
  type AssistantListItem,
} from "@/components/admin/assistants-list-client";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { assistants, messages } from "@/db/schema-sms";
import { requireAdmin } from "@/lib/auth/guards";
import type { GoalType } from "@/lib/assistants/schema";

export default async function AdminAssistantsPage() {
  await requireAdmin();
  const t = await getTranslations("assistants");

  const rows = await db
    .select({
      id: assistants.id,
      name: assistants.name,
      description: assistants.description,
      status: assistants.status,
      version: assistants.version,
      goal: assistants.goal,
      suitePassed: assistants.suitePassed,
      needsRecompile: assistants.needsRecompile,
      compiledAt: assistants.compiledAt,
      updatedAt: assistants.updatedAt,
      // Un assistant qui a écrit ne peut être qu'archivé : la liste le sait
      // d'avance pour que le dialogue annonce le bon geste.
      messageCount: sql<number>`(
        select count(*)::int from ${messages} where ${messages.assistantId} = ${assistants.id}
      )`,
    })
    .from(assistants)
    .where(sql`${assistants.status} <> 'archived'`)
    .orderBy(desc(assistants.updatedAt), asc(assistants.name));

  const archived = await db
    .select({ id: assistants.id })
    .from(assistants)
    .where(eq(assistants.status, "archived"));

  const items: AssistantListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    version: r.version,
    goalType: ((r.goal as { primary?: { type?: string } })?.primary?.type ?? "qualify_only") as GoalType,
    suitePassed: r.suitePassed,
    needsRecompile: r.needsRecompile,
    everCompiled: r.compiledAt !== null,
    hasWritten: r.messageCount > 0,
    updatedAt: r.updatedAt.toISOString(),
  }));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <PageHeader icon={<Bot />} title={t("list.title")} subtitle={t("list.subtitle")} />
      <AssistantsListClient items={items} archivedCount={archived.length} />
    </div>
  );
}
