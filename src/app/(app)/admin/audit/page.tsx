import { and, desc, eq, gte, like, lte, sql, type SQL } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AuditFilters } from "@/components/admin/audit-filters";
import type { OptionDto } from "@/components/admin/types";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/guards";
import { cn } from "@/lib/utils";

const TZ = "America/Toronto";
const PAGE_SIZE = 50;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const [t, locale, params] = await Promise.all([getTranslations("admin"), getLocale(), searchParams]);
  const dateLocale = locale === "fr" ? fr : enCA;

  const action = first(params.action);
  const userId = first(params.userId);
  const from = first(params.from);
  const to = first(params.to);
  const page = Math.max(1, Number(first(params.page)) || 1);

  const filters: SQL[] = [];
  if (action) filters.push(like(auditLogs.action, `${action}%`));
  if (userId) filters.push(eq(auditLogs.userId, userId));
  if (from) filters.push(gte(auditLogs.createdAt, fromZonedTime(`${from}T00:00:00`, TZ)));
  if (to) filters.push(lte(auditLogs.createdAt, fromZonedTime(`${to}T23:59:59.999`, TZ)));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const [rows, total, prefixRows, allUsers] = await Promise.all([
    db
      .select({ log: auditLogs, userName: users.name })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.$count(auditLogs, where),
    db
      .selectDistinct({ prefix: sql<string>`split_part(${auditLogs.action}, '.', 1)` })
      .from(auditLogs)
      .orderBy(sql`1`),
    db.query.users.findMany({ columns: { id: true, name: true } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const userOptions: OptionDto[] = allUsers.map((u) => ({ value: u.id, label: u.name }));

  const fmtDate = (d: Date) => formatInTimeZone(d, TZ, "d MMM yyyy, HH:mm:ss", { locale: dateLocale });

  const pageHref = (p: number) => {
    const qs = new URLSearchParams();
    if (action) qs.set("action", action);
    if (userId) qs.set("userId", userId);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return s ? `/admin/audit?${s}` : "/admin/audit";
  };

  const detailBlock = (detail: unknown) =>
    detail != null ? (
      <details className="group">
        <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
          {t("audit.detail")}
        </summary>
        <pre className="mt-1 max-w-xs overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
          {JSON.stringify(detail, null, 2)}
        </pre>
      </details>
    ) : (
      <span className="text-xs text-muted-foreground">—</span>
    );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      <h1 className="font-heading text-xl font-semibold tracking-tight">{t("audit.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("audit.subtitle", { count: total })}</p>

      <AuditFilters actions={prefixRows.map((p) => p.prefix)} users={userOptions} />

      {/* ── Tableau (desktop) ── */}
      <div className="hidden overflow-hidden rounded-xl ring-1 ring-foreground/10 md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("audit.date")}</TableHead>
              <TableHead>{t("audit.user")}</TableHead>
              <TableHead>{t("audit.action")}</TableHead>
              <TableHead>{t("audit.entity")}</TableHead>
              <TableHead>{t("audit.ip")}</TableHead>
              <TableHead>{t("audit.detail")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {t("audit.empty")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map(({ log, userName }) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs whitespace-nowrap">{fmtDate(log.createdAt)}</TableCell>
                  <TableCell className="max-w-32 truncate text-sm">
                    {userName ?? <span className="text-muted-foreground">{t("audit.system")}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {log.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-40 truncate font-mono text-xs">
                    {log.entity ? `${log.entity}${log.entityId ? ` · ${log.entityId}` : ""}` : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{log.ip ?? "—"}</TableCell>
                  <TableCell>{detailBlock(log.detail)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Cartes (mobile) ── */}
      <div className="space-y-3 md:hidden">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("audit.empty")}</p>
        ) : (
          rows.map(({ log, userName }) => (
            <div key={log.id} className="space-y-1.5 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="outline" className="font-mono text-[11px]">
                  {log.action}
                </Badge>
                <span className="text-xs text-muted-foreground">{fmtDate(log.createdAt)}</span>
              </div>
              <p className="text-sm">
                {userName ?? <span className="text-muted-foreground">{t("audit.system")}</span>}
                {log.entity ? (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {log.entity}
                    {log.entityId ? ` · ${log.entityId}` : ""}
                  </span>
                ) : null}
              </p>
              {log.ip ? <p className="font-mono text-xs text-muted-foreground">{log.ip}</p> : null}
              {detailBlock(log.detail)}
            </div>
          ))
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between">
          {page > 1 ? (
            <Link
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 md:min-h-8")}
              href={pageHref(page - 1)}
            >
              {t("audit.previous")}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">
            {t("audit.pageOf", { page, total: totalPages })}
          </span>
          {page < totalPages ? (
            <Link
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 md:min-h-8")}
              href={pageHref(page + 1)}
            >
              {t("audit.next")}
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </div>
  );
}
