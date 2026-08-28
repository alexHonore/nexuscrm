import { asc, eq, sql } from "drizzle-orm";
import { getLocale } from "next-intl/server";
import { db } from "@/db";
import { categories, clients, sources, users } from "@/db/schema";
import { campaigns } from "@/db/schema-sms";
import { requireActor, scopeFor, visibilityCondition } from "@/lib/permissions/server";
import type { FilterOption } from "@/components/clients/clients-filters";
import { ClientsWorkspace, type PanelCategory } from "@/components/clients/clients-workspace";

/**
 * /clients master-detail layout: persistent left panel (client list) + detail.
 * The panel is a client component whose state (search, filters, loaded pages,
 * scroll) survives navigation between clients — switching must feel instant.
 *
 * Les COMPTES du panneau (total, pastilles par catégorie) sont bornés à la
 * portée du regard, comme la liste elle-même : un total juste au-dessus d'une
 * liste filtrée annoncerait le nombre de fiches qu'on cache. Même raison pour
 * le filtre « assignée à » : n'y figurent que les détenteurs dont ce regard
 * peut voir au moins les fiches — proposer un nom, c'est déjà dire qu'il
 * existe et qu'il détient quelque chose.
 */
export default async function ClientsLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const locale = await getLocale();
  const [visible, scope] = await Promise.all([visibilityCondition(actor), scopeFor(actor)]);

  const [allCategories, allSources, activeUsers, counts, total, allCampaigns] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
    db.query.users.findMany({ where: eq(users.isActive, true), orderBy: [asc(users.name)] }),
    db
      .select({ categoryId: clients.categoryId, count: sql<number>`count(*)::int` })
      .from(clients)
      .where(visible)
      .groupBy(clients.categoryId),
    db.$count(clients, visible),
    // Les campagnes ARCHIVÉES restent proposées : « qui était dans la
    // réactivation du printemps » est une question qu'on se pose justement
    // une fois la campagne finie.
    db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).orderBy(asc(campaigns.name)),
  ]);

  /** Détenteurs dont ce regard voit au moins une fiche possible. */
  const visibleHolders = (id: string): boolean => {
    if (scope.kind === "all") return true;
    if (scope.kind === "none") return false;
    return id === actor.user.id ? scope.own : scope.userIds.includes(id);
  };

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
  const userOptions: FilterOption[] = activeUsers
    .filter((u) => visibleHolders(u.id))
    .map((u) => ({ value: u.id, label: u.name }));
  const campaignOptions: FilterOption[] = allCampaigns.map((c) => ({ value: c.id, label: c.name }));

  return (
    <ClientsWorkspace
      /*
       * Un booléen PAR GESTE, jamais un « est-il administrateur ».
       *
       * L'ET de cinq droits refermait tout le panneau sur qui n'en avait que
       * quatre : un rôle autorisé à créer une fiche mais pas à agir en masse
       * perdait aussi le bouton « + », le changement de statut et la source.
       * Chaque outil lit désormais SON droit — et le serveur revérifie chaque
       * geste, fiche par fiche.
       */
      can={{
        create: actor.can("clients.create"),
        bulk: actor.can("clients.bulk"),
        category: actor.can("clients.category"),
        // Changer la source à même la ligne, c'est modifier la fiche.
        source: actor.can("clients.edit"),
        assign: actor.can("clients.assign"),
        delete: actor.can("clients.delete"),
        // Inscrire une sélection à une campagne relève du module campagnes.
        campaign: actor.can("admin.campaigns"),
      }}
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
