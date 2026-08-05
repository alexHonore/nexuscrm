import { desc, eq, and, isNull } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { Pagination } from "@/components/clients/pagination";
import { MarkAllReadButton, NotificationItem } from "./notification-list";

const PAGE_SIZE = 20;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const t = await getTranslations("notifications");

  const sp = await searchParams;
  const pageRaw = typeof sp.page === "string" ? sp.page : "";
  const page = Math.max(1, Number.parseInt(pageRaw, 10) || 1);

  const where = eq(notifications.userId, user.id);
  const [total, unreadCount, rows] = await Promise.all([
    db.$count(notifications, where),
    db.$count(notifications, and(where, isNull(notifications.readAt))),
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
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <MarkAllReadButton disabled={unreadCount === 0} />
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
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
