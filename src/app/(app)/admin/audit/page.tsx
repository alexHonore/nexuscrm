import { and, desc, eq, gte, inArray, like, lte, sql, type SQL } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AuditDetailCard, AuditDetailRow } from "@/components/admin/audit-detail-dialog";
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
import { auditLogs, clients, users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/guards";
import { cn } from "@/lib/utils";
import { AUDIT_TZ, buildAuditEntry, isUuid, type AuditLookups } from "./audit-view";

const TZ = AUDIT_TZ;
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

  // Les tables de correspondance (utilisateurs, catégories, sources) sont
  // minuscules : on les charge en entier, une fois, pour résoudre les id des
  // 50 lignes affichées sans une seule requête par ligne.
  const [rows, total, prefixRows, allUsers, allCategories, allSources] = await Promise.all([
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
    db.query.categories.findMany({ columns: { id: true, nameFr: true, nameEn: true } }),
    db.query.sources.findMany({ columns: { id: true, name: true } }),
  ]);

  // Noms des fiches citées par cette page — une seule requête, ids uniques.
  const clientIds = [
    ...new Set(
      rows
        .filter((r) => r.log.entity === "client" && isUuid(r.log.entityId))
        .map((r) => r.log.entityId as string),
    ),
  ];
  const clientRows = clientIds.length
    ? await db
        .select({ id: clients.id, fullName: clients.fullName })
        .from(clients)
        .where(inArray(clients.id, clientIds))
    : [];

  const lookups: AuditLookups = {
    users: new Map(allUsers.map((u) => [u.id, u.name])),
    categories: new Map(allCategories.map((c) => [c.id, locale === "fr" ? c.nameFr : c.nameEn])),
    sources: new Map(allSources.map((s) => [s.id, s.name])),
    clients: new Map(clientRows.map((c) => [c.id, c.fullName])),
  };

  /** Aperçu en ligne : « Téléphone, Catégorie +2 » — le détail reste dans le dialogue. */
  const changeSummary = (changes: { label: string }[]): string | null => {
    if (changes.length === 0) return null;
    const shown = changes.slice(0, 3).map((c) => c.label);
    const rest = changes.length - shown.length;
    return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
  };

  const entries = rows.map(({ log, userName }) => {
    const entry = buildAuditEntry(log, userName, { t, dateLocale, lookups });
    return { entry, summary: changeSummary(entry.changes) };
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const userOptions: OptionDto[] = allUsers.map((u) => ({ value: u.id, label: u.name }));

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
              <TableHead>{t("audit.changesColumn")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("audit.details")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {t("audit.empty")}
                </TableCell>
              </TableRow>
            ) : (
              entries.map(({ entry, summary }) => (
                <AuditDetailRow key={entry.id} entry={entry}>
                  <TableCell className="text-xs whitespace-nowrap">
                    <time dateTime={entry.dateIso}>{entry.dateLabel}</time>
                  </TableCell>
                  <TableCell className="max-w-32 truncate text-sm">
                    {entry.isSystem ? (
                      <span className="text-muted-foreground">{entry.userLabel}</span>
                    ) : (
                      entry.userLabel
                    )}
                  </TableCell>
                  <TableCell className="max-w-52">
                    <span className="block text-sm">{entry.actionLabel}</span>
                    {entry.actionLabel === entry.action ? null : (
                      <span className="block font-mono text-[11px] text-muted-foreground">
                        {entry.action}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-xs">
                    {entry.entityLabel ? (
                      <>
                        {entry.entityLabel}
                        {entry.entityName ? ` · ${entry.entityName}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{entry.ip ?? "—"}</TableCell>
                  <TableCell className="max-w-56 truncate text-xs text-muted-foreground">
                    {summary ?? "—"}
                  </TableCell>
                </AuditDetailRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Cartes (mobile) ── */}
      <div className="space-y-3 md:hidden">
        {entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("audit.empty")}</p>
        ) : (
          entries.map(({ entry, summary }) => (
            <AuditDetailCard key={entry.id} entry={entry}>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{entry.actionLabel}</span>
                <span className="text-xs text-muted-foreground">{entry.dateLabel}</span>
              </span>
              {entry.actionLabel === entry.action ? null : (
                <Badge variant="outline" className="font-mono text-[11px]">
                  {entry.action}
                </Badge>
              )}
              <span className="block text-sm">
                {entry.isSystem ? (
                  <span className="text-muted-foreground">{entry.userLabel}</span>
                ) : (
                  entry.userLabel
                )}
                {entry.entityLabel ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {entry.entityLabel}
                    {entry.entityName ? ` · ${entry.entityName}` : ""}
                  </span>
                ) : null}
              </span>
              {summary ? (
                <span className="block text-xs text-muted-foreground">{summary}</span>
              ) : null}
              {entry.ip ? (
                <span className="block font-mono text-xs text-muted-foreground">{entry.ip}</span>
              ) : null}
            </AuditDetailCard>
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
