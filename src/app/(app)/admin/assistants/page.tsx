import { Bot } from "lucide-react";
import { getTranslations } from "next-intl/server";
import {
  AssistantsListClient,
  type AssistantListItem,
} from "@/components/admin/assistants-list-client";
import { PageHeader } from "@/components/shell/page-header";
import type { GoalType } from "@/lib/assistants/schema";
import { listAssistantsWithCounts } from "@/lib/assistants/list";
import { requirePerm } from "@/lib/permissions/server";

export default async function AdminAssistantsPage() {
  const actor = await requirePerm("admin.assistants");
  // VOIR n'est pas MODIFIER : le droit de lecture ouvre cet écran, celui
  // d'écriture décide seul des gestes qu'on y propose. Le calcul se fait ici,
  // au serveur, parce que c'est lui qui connaît le rôle — l'écran n'en reçoit
  // que la réponse.
  const canEdit = actor.can("admin.assistantsEdit");
  const t = await getTranslations("assistants");

  const { rows, archivedCount } = await listAssistantsWithCounts();

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
      <AssistantsListClient items={items} archivedCount={archivedCount} canEdit={canEdit} />
    </div>
  );
}
