import { asc, eq, sql } from "drizzle-orm";
import { getLocale } from "next-intl/server";
import { db } from "@/db";
import { categories, clients, sources, users } from "@/db/schema";
import { campaigns } from "@/db/schema-sms";
import { requireUser } from "@/lib/auth/guards";
import type { FilterOption } from "@/components/clients/clients-filters";
import { ClientsWorkspace, type PanelCategory } from "@/components/clients/clients-workspace";

/**
 * /clients master-detail layout: persistent left panel (client list) + detail.
 * The panel is a client component whose state (search, filters, loaded pages,
 * scroll) survives navigation between clients — switching must feel instant.
 */
export default async function ClientsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const locale = await getLocale();

  const [allCategories, allSources, activeUsers, counts, total, allCampaigns] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
    db.query.users.findMany({ where: eq(users.isActive, true), orderBy: [asc(users.name)] }),
    db
      .select({ categoryId: clients.categoryId, count: sql<number>`count(*)::int` })
      .from(clients)
      .groupBy(clients.categoryId),
    db.$count(clients),
    // Les campagnes ARCHIVÉES restent proposées : « qui était dans la
    // réactivation du printemps » est une question qu'on se pose justement
    // une fois la campagne finie.
    db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).orderBy(asc(campaigns.name)),
  ]);

  const countByCategory = new Map(counts.map((c) => [c.categoryId, c.count]));

  const panelCategories: PanelCategory[] = allCategories.map((c) => ({
    id: c.id,
    label: locale === "en" ? c.nameEn : c.nameFr,
    color: c.color,
    count: countByCategory.get(c.id) ?? 0,
  }));
  const sourceOptions: FilterOption[] = allSources.map((s) => ({
    value: String(s.id),
    label: s.name,
    color: s.color,
  }));
  const userOptions: FilterOption[] = activeUsers.map((u) => ({ value: u.id, label: u.name }));
  const campaignOptions: FilterOption[] = allCampaigns.map((c) => ({ value: c.id, label: c.name }));

  return (
    <ClientsWorkspace
      isAdmin={user.role === "admin"}
      categories={panelCategories}
      sources={sourceOptions}
      users={userOptions}
      campaigns={campaignOptions}
      totalClients={total}
      noCategoryCount={countByCategory.get(null) ?? 0}
    >
      {children}
    </ClientsWorkspace>
  );
}
