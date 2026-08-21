import { asc, desc, eq, sql } from "drizzle-orm";
import { Megaphone } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { CampaignsListClient, type CampaignListItem } from "@/components/admin/campaigns-list-client";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { campaignEnrollments, campaigns } from "@/db/schema-sms";
import { requireAdmin } from "@/lib/auth/guards";
import type { TriggerKind } from "@/lib/campaigns/schema";

export default async function AdminCampaignsPage() {
  await requireAdmin();
  const t = await getTranslations("campaigns");

  const countFor = (status: string) =>
    sql<number>`(select count(*)::int from ${campaignEnrollments}
      where ${campaignEnrollments.campaignId} = ${campaigns.id}
        and ${campaignEnrollments.status} = ${status})`;

  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      description: campaigns.description,
      status: campaigns.status,
      trigger: campaigns.trigger,
      updatedAt: campaigns.updatedAt,
      enrolled: sql<number>`(select count(*)::int from ${campaignEnrollments}
        where ${campaignEnrollments.campaignId} = ${campaigns.id})`,
      active: countFor("active"),
      replied: countFor("replied"),
      stopped: countFor("stopped"),
    })
    .from(campaigns)
    .where(sql`${campaigns.status} <> 'archived'`)
    .orderBy(desc(campaigns.updatedAt), asc(campaigns.name));

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
