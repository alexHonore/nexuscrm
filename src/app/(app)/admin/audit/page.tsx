import { and, desc, eq, gte, inArray, like, lte, sql, type SQL } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import { ScrollText } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { AuditDetailCard, AuditDetailRow } from "@/components/admin/audit-detail-dialog";
import { AuditFilters } from "@/components/admin/audit-filters";
import type { OptionDto } from "@/components/admin/types";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { loadDirectory, requirePerm, withVisibility } from "@/lib/permissions/server";
import { cn } from "@/lib/utils";
import {
  AUDIT_TZ,
  buildAuditEntry,
  citedClientIds,
  isUuid,
  type AuditActionFamily,
  type AuditLookups,
} from "./audit-view";

/** Teintes douces par famille d'action — translucides, lisibles dans les deux thèmes. */
const FAMILY_TONE: Record<AuditActionFamily, string> = {
  create: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  delete: "bg-destructive/10 text-destructive",
  update: "bg-primary/10 text-primary",
  auth: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  data: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  other: "bg-muted text-muted-foreground",
};

/** Badge doux : libellé de l'action teinté selon sa famille de verbe. */
function ActionBadge({ family, label }: { family: AuditActionFamily; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center rounded-md px-2 py-0.5 text-xs font-medium",
        FAMILY_TONE[family],
      )}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

const TZ = AUDIT_TZ;
const PAGE_SIZE = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Borne d'une journée (heure de Toronto) à partir d'un paramètre d'URL, ou
 * undefined s'il est absent, mal formé ou désigne un jour qui n'existe pas
 * (2026-02-30) — le pilote ne sait pas sérialiser une date invalide et la page
 * tomberait en erreur au lieu d'ignorer le filtre.
 */
function dayBound(value: string | undefined, suffix: string): Date | undefined {
  if (!value || !DATE_RE.test(value)) return undefined;
  const d = fromZonedTime(`${value}${suffix}`, TZ);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requirePerm("admin.audit");
  const [t, tAccess, locale, params] = await Promise.all([
    getTranslations("admin"),
    // « Masqué » est écrit une seule fois, chez les fiches.
    getTranslations("clients"),
    getLocale(),
    searchParams,
  ]);
  const dateLocale = locale === "fr" ? fr : enCA;

  // Paramètres d'URL validés : un filtre mal formé (uuid ou date) est ignoré
  // plutôt qu'envoyé à Postgres, qui refuserait et ferait tomber la page.
  const action = first(params.action);
  const userIdParam = first(params.userId);
  const userId = isUuid(userIdParam) ? userIdParam : undefined;
  const fromDate = dayBound(first(params.from), "T00:00:00");
  const toDate = dayBound(first(params.to), "T23:59:59.999");
  const from = fromDate ? first(params.from) : undefined;
  const to = toDate ? first(params.to) : undefined;
  const page = Math.max(1, Number(first(params.page)) || 1);

  const filters: SQL[] = [];
  if (action) filters.push(like(auditLogs.action, `${action}%`));
  if (userId) filters.push(eq(auditLogs.userId, userId));
  if (fromDate) filters.push(gte(auditLogs.createdAt, fromDate));
  if (toDate) filters.push(lte(auditLogs.createdAt, toDate));
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
  //
  // Le journal est global (il DOIT l'être : c'est sa raison d'être), mais il ne
  // rouvre pas ce que la matrice ferme. La correspondance id → nom se bâtit
  // donc sur les seules fiches que ce regard peut voir ; les autres lignes
  // restent, désignées par leur identifiant. Une deuxième liste, non filtrée,
  // dit seulement lesquelles EXISTENT encore : une fiche supprimée n'a plus de
  // détenteur, donc plus de compartiment — c'est le droit du rôle qui tranche
  // alors, sinon auditer une suppression ne montrerait plus rien de ce qui a
  // été supprimé.
  const clientIds = citedClientIds(rows.map((r) => r.log));
  const [visibleClients, existingClients] = clientIds.length
    ? await Promise.all([
        db
          .select({ id: clients.id, fullName: clients.fullName, holderId: clients.assignedToId })
          .from(clients)
          .where(await withVisibility(actor, inArray(clients.id, clientIds))),
        db
          .select({ id: clients.id })
          .from(clients)
          .where(inArray(clients.id, clientIds)),
      ])
    : [[], []];

  // Le compartiment ne dépend que du DÉTENTEUR : une résolution par détenteur,
  // pas une par ligne — la page en affiche cinquante.
  const { cfg, roleOf } = await loadDirectory();
  const grantsCache = new Map<string, Grants>();
  const grantsOfHolder = (assignedToId: string | null): Grants => {
    const key = assignedToId ?? "";
    const hit = grantsCache.get(key);
    if (hit) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const g = grantsFor(cfg, actor.role, bucketFor(actor.user.id, { assignedToId }, holder));
    grantsCache.set(key, g);
    return g;
  };
  const contactOpenIds = new Set(
    visibleClients.filter((c) => grantsOfHolder(c.holderId).contact).map((c) => c.id),
  );
  const stillExists = new Set(existingClients.map((c) => c.id));

  const lookups: AuditLookups = {
    users: new Map(allUsers.map((u) => [u.id, u.name])),
    categories: new Map(allCategories.map((c) => [c.id, locale === "fr" ? c.nameFr : c.nameEn])),
    sources: new Map(allSources.map((s) => [s.id, s.name])),
    clients: new Map(visibleClients.map((c) => [c.id, c.fullName])),
    // Les rôles sont configurés : leur nom se lit dans le réglage, dans la
    // langue de l'écran — et un rôle supprimé depuis reste son identifiant.
    roles: new Map(cfg.roles.map((r) => [r.id, locale === "fr" ? r.nameFr : r.nameEn])),
    // Une ligne sans fiche (un DID, un réglage) ou portant sur une fiche
    // disparue n'a plus de compartiment à interroger : c'est le droit du rôle,
    // le plafond, qui dit si un numéro peut encore se lire.
    contactOpen: (clientId) =>
      clientId !== null && stillExists.has(clientId)
        ? contactOpenIds.has(clientId)
        : actor.can("clients.contact"),
  };

  /** Aperçu en ligne : « Téléphone, Catégorie +2 » — le détail reste dans le dialogue. */
  const changeSummary = (changes: { label: string }[]): string | null => {
    if (changes.length === 0) return null;
    const shown = changes.slice(0, 3).map((c) => c.label);
    const rest = changes.length - shown.length;
    return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
  };

  const entries = rows.map(({ log, userName }) => {
    const entry = buildAuditEntry(log, userName, {
      t,
      dateLocale,
      lookups,
      mask: tAccess("access.masked"),
    });
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
      <PageHeader
        icon={<ScrollText />}
        title={t("audit.title")}
        subtitle={t("audit.subtitle", { count: total })}
      />

      <AuditFilters actions={prefixRows.map((p) => p.prefix)} users={userOptions} />

      {/* ── Tableau (desktop) ── */}
      <div className="hidden overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10 md:block">
        <Table className="[&_th]:h-10 [&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider">
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
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
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="whitespace-normal p-0">
                  <EmptyState icon={<ScrollText />} title={t("audit.empty")} />
                </TableCell>
              </TableRow>
            ) : (
              entries.map(({ entry, summary }) => (
                <AuditDetailRow key={entry.id} entry={entry}>
                  <TableCell className="text-xs whitespace-nowrap tabular-nums">
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
                    <ActionBadge family={entry.family} label={entry.actionLabel} />
                    {entry.actionLabel === entry.action ? null : (
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                        {entry.action}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-xs">
                    {entry.entityLabel ? (
                      <>
                        {entry.entityLabel}
                        {/* Fiche fermée à ce regard (ou supprimée) : son
                            identifiant, jamais son nom — une ligne d'audit doit
                            quand même dire sur QUOI elle porte. */}
                        {entry.entityName
                          ? ` · ${entry.entityName}`
                          : entry.clientHidden
                            ? ` · ${entry.entityId}`
                            : ""}
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
          <EmptyState
            icon={<ScrollText />}
            title={t("audit.empty")}
            className="rounded-xl bg-card shadow-xs ring-1 ring-foreground/10"
          />
        ) : (
          entries.map(({ entry, summary }) => (
            <AuditDetailCard key={entry.id} entry={entry}>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <ActionBadge family={entry.family} label={entry.actionLabel} />
                <span className="text-xs text-muted-foreground tabular-nums">{entry.dateLabel}</span>
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
                  <span className="ml-2 text-xs break-all text-muted-foreground">
                    {entry.entityLabel}
                    {entry.entityName
                      ? ` · ${entry.entityName}`
                      : entry.clientHidden
                        ? ` · ${entry.entityId}`
                        : ""}
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
