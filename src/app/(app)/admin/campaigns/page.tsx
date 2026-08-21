import { eq } from "drizzle-orm";
import { Megaphone } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { CampaignsListClient, type CampaignListItem } from "@/components/admin/campaigns-list-client";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { campaigns } from "@/db/schema-sms";
import { requireAdmin } from "@/lib/auth/guards";
import type { TriggerKind } from "@/lib/campaigns/schema";
import { listCampaignsWithCounts } from "@/lib/campaigns-server/list";

export default async function AdminCampaignsPage() {
  await requireAdmin();
  const t = await getTranslations("campaigns");

  const rows = await listCampaignsWithCounts();

  const [archived] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campaigns)
    .where(eq(campaigns.status, "archived"));

  const items: CampaignListItem[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    triggerKind: ((r.trigger as { kind?: string })?.kind ?? "manual") as TriggerKind,
    enrolled: r.enrolled,
    active: r.active,
    replied: r.replied,
    stopped: r.stopped,
    updatedAt: r.updatedAt.toISOString(),
  }));

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <PageHeader icon={<Megaphone />} title={t("list.title")} subtitle={t("list.subtitle")} />
      <CampaignsListClient items={items} archivedCount={archived?.n ?? 0} />
    </div>
  );
}
