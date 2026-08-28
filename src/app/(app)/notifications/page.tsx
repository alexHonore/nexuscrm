import { desc, eq, and, isNull, sql } from "drizzle-orm";
import { Bell, BellOff } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { clients, notifications } from "@/db/schema";
import { requireActor, visibilityCondition } from "@/lib/permissions/server";
import { Pagination } from "@/components/clients/pagination";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { MarkAllReadButton, NotificationItem } from "./notification-list";

const PAGE_SIZE = 20;

/**
 * La cloche — et ce qu'elle n'a plus le droit de dire.
 *
 * Une notification est du contenu qui SURVIT : « Marie Tremblay (418 555-1234)
 * vous a rappelé » reste écrit le jour où la fiche passe au courtier et
 * disparaît des listes. On ne réécrit pas le passé, on le TAIT : une
 * notification qui mène à une fiche hors de portée n'est pas rendue.
 *
 * Le filtre est dans le WHERE et non après la requête, pour que le compte non
 * lu et la pagination disent la même chose que la liste — un compteur qui
 * dépasse la liste est exactement l'aveu qu'on cherche à éviter.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const t = await getTranslations("notifications");

  const sp = await searchParams;
  const pageRaw = typeof sp.page === "string" ? sp.page : "";
  const page = Math.max(1, Number.parseInt(pageRaw, 10) || 1);

  const visible = await visibilityCondition(actor);
  // L'identifiant porté par le lien, ou NULL quand la notification mène
  // ailleurs (journal d'appels, réglages, agenda). Le motif exige un UUID
  // COMPLET : « /clients/xxx » ne doit pas produire un cast qui explose.
  const linkedClientId = sql`substring(${notifications.link} from '^/clients/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})')`;
  const where = and(
    eq(notifications.userId, actor.user.id),
    // Portée totale (le courtier) : aucune condition à ajouter. Sinon, la fiche
    // liée doit exister ET être atteignable — une fiche supprimée fait donc
    // disparaître sa notification, ce qui vaut mieux qu'un lien mort.
    visible
      ? sql`(
          ${linkedClientId} is null
          or exists (
            select 1 from ${clients}
            where ${clients.id} = (${linkedClientId})::uuid and ${visible}
          )
        )`
      : undefined,
  );

  const [total, unreadCount, unreadEverything, rows] = await Promise.all([
    db.$count(notifications, where),
    db.$count(notifications, and(where, isNull(notifications.readAt))),
    // Le MÊME compte, sans le filtre : la pastille de la coquille le calcule
    // ainsi (src/app/(app)/layout.tsx). Sans lui, une notification cachée et
    // non lue laisserait la pastille allumée avec « Tout marquer comme lu »
    // grisé — un badge qu'on ne peut plus éteindre. Il ne sert qu'à ÇA : le
    // nombre affiché reste celui de ce que cet écran montre.
    db.$count(
      notifications,
      and(eq(notifications.userId, actor.user.id), isNull(notifications.readAt)),
    ),
    db.query.notifications.findMany({
      where,
      orderBy: [desc(notifications.createdAt)],
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6 md:px-8">
      <PageHeader
        icon={<Bell />}
        title={t("title")}
        titleAccessory={
          unreadCount > 0 ? (
            <Badge className="tabular-nums">
              <span aria-hidden>{unreadCount}</span>
              <span className="sr-only">{t("unreadCount", { count: unreadCount })}</span>
            </Badge>
          ) : null
        }
        actions={<MarkAllReadButton disabled={unreadEverything === 0} />}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<BellOff />}
          title={t("empty")}
          hint={t("emptyHint")}
          className="rounded-xl border border-dashed"
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((n) => (
            <NotificationItem
              key={n.id}
              notification={{
                id: n.id,
                type: n.type,
                title: n.title,
                body: n.body,
                link: n.link,
                read: n.readAt !== null,
                createdAt: n.createdAt.toISOString(),
              }}
            />
          ))}
        </ul>
      )}

      <Pagination
        page={page}
        pages={pages}
        basePath="/notifications"
        params={{}}
        labels={{
          previous: t("previous"),
          next: t("next"),
          page: t("page", { page, pages }),
        }}
      />
    </div>
  );
}
