import { and, asc, desc, eq, gte, ilike, isNotNull, like, lt, or, sql, type SQL } from "drizzle-orm";
import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { PhoneOffIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/db";
import { categories, clients, sources, users } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { formatPhone } from "@/lib/phone";
import { AddClientDialog } from "@/components/clients/add-client-dialog";
import { AssignSelect } from "@/components/clients/assign-select";
import { CategoryChip } from "@/components/clients/category-chip";
import { ClientsFilters, type FilterOption } from "@/components/clients/clients-filters";
import { DeleteClientButton } from "@/components/clients/delete-client-button";
import { Pagination } from "@/components/clients/pagination";
import { APP_TZ, torontoDayRange } from "@/components/clients/timezone";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = Record<string, string | string[] | undefined>;

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const t = await getTranslations("clients");
  const locale = await getLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const isAdmin = user.role === "admin";

  const sp = await searchParams;
  const q = str(sp.q).trim();
  const categoryParam = str(sp.category);
  const sourceParam = str(sp.source);
  const assignedParam = str(sp.assigned);
  const statusParam = str(sp.status);
  const page = Math.max(1, Number.parseInt(str(sp.page), 10) || 1);

  const now = new Date();
  const { start, end } = torontoDayRange(now);

  const conditions: SQL[] = [];
  if (q) {
    const digits = q.replace(/\D/g, "");
    const textMatchers = [
      ilike(clients.fullName, `%${q}%`),
      ilike(clients.email, `%${q}%`),
    ];
    const phoneMatchers =
      digits.length >= 3
        ? [like(clients.phone, `%${digits}%`), like(clients.phoneAlt, `%${digits}%`)]
        : [];
    const merged = or(...textMatchers, ...phoneMatchers);
    if (merged) conditions.push(merged);
  }
  if (/^\d+$/.test(categoryParam)) conditions.push(eq(clients.categoryId, Number(categoryParam)));
  if (/^\d+$/.test(sourceParam)) conditions.push(eq(clients.sourceId, Number(sourceParam)));
  if (UUID_RE.test(assignedParam)) conditions.push(eq(clients.assignedToId, assignedParam));
  if (statusParam === "late") {
    conditions.push(isNotNull(clients.nextFollowupAt), lt(clients.nextFollowupAt, now));
  } else if (statusParam === "today") {
    conditions.push(gte(clients.nextFollowupAt, start), lt(clients.nextFollowupAt, end));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [total, rows, allCategories, allSources, activeUsers] = await Promise.all([
    db.$count(clients, where),
    db.query.clients.findMany({
      where,
      with: { category: true, source: true, assignedTo: true },
      orderBy: [
        desc(
          sql`GREATEST(COALESCE(${clients.lastContactedAt}, to_timestamp(0)), ${clients.updatedAt})`,
        ),
      ],
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
    db.query.users.findMany({ where: eq(users.isActive, true), orderBy: [asc(users.name)] }),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const categoryName = (c: { nameFr: string; nameEn: string }) =>
    locale === "en" ? c.nameEn : c.nameFr;

  const categoryOptions: FilterOption[] = allCategories.map((c) => ({
    value: String(c.id),
    label: categoryName(c),
  }));
  const sourceOptions: FilterOption[] = allSources.map((s) => ({
    value: String(s.id),
    label: s.name,
  }));
  const userOptions: FilterOption[] = activeUsers.map((u) => ({ value: u.id, label: u.name }));

  const fmtDate = (d: Date | null) =>
    d ? formatInTimeZone(d, APP_TZ, "d MMM yyyy HH:mm", { locale: dfnsLocale }) : "—";

  const queryParams: Record<string, string> = {};
  if (q) queryParams.q = q;
  if (categoryParam) queryParams.category = categoryParam;
  if (sourceParam) queryParams.source = sourceParam;
  if (assignedParam) queryParams.assigned = assignedParam;
  if (statusParam) queryParams.status = statusParam;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 md:px-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("list.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("list.count", { count: total })}</p>
        </div>
        {isAdmin ? (
          <AddClientDialog categories={categoryOptions} sources={sourceOptions} users={userOptions} />
        ) : null}
      </div>

      <ClientsFilters categories={categoryOptions} sources={sourceOptions} users={userOptions} />

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("list.empty")}
        </p>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden rounded-xl bg-card ring-1 ring-foreground/10 md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("list.columns.name")}</TableHead>
                  <TableHead>{t("list.columns.phone")}</TableHead>
                  <TableHead>{t("list.columns.category")}</TableHead>
                  <TableHead>{t("list.columns.source")}</TableHead>
                  <TableHead>{t("list.columns.nextFollowup")}</TableHead>
                  <TableHead>{t("list.columns.lastContacted")}</TableHead>
                  <TableHead>{t("list.columns.assignedTo")}</TableHead>
                  {isAdmin ? <TableHead className="text-right">{t("list.columns.actions")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => {
                  const overdueFollowup = c.nextFollowupAt !== null && c.nextFollowupAt < now;
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="max-w-52">
                        <Link
                          href={`/clients/${c.id}`}
                          className="flex items-center gap-1.5 truncate font-medium hover:underline"
                        >
                          {c.doNotCall ? (
                            <PhoneOffIcon
                              className="size-3.5 shrink-0 text-destructive"
                              aria-label={t("list.doNotCall")}
                            />
                          ) : null}
                          <span className="truncate">{c.fullName}</span>
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums">{formatPhone(c.phone)}</TableCell>
                      <TableCell>
                        {c.category ? (
                          <CategoryChip name={categoryName(c.category)} color={c.category.color} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-32 truncate text-muted-foreground">
                        {c.source?.name ?? "—"}
                      </TableCell>
                      <TableCell className={overdueFollowup ? "font-medium text-destructive" : undefined}>
                        {fmtDate(c.nextFollowupAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(c.lastContactedAt)}</TableCell>
                      <TableCell>
                        {isAdmin ? (
                          <AssignSelect clientId={c.id} users={userOptions} value={c.assignedToId} />
                        ) : (
                          (c.assignedTo?.name ?? t("list.unassigned"))
                        )}
                      </TableCell>
                      {isAdmin ? (
                        <TableCell className="text-right">
                          <DeleteClientButton clientId={c.id} clientName={c.fullName} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-2 md:hidden">
            {rows.map((c) => {
              const overdueFollowup = c.nextFollowupAt !== null && c.nextFollowupAt < now;
              return (
                <li key={c.id}>
                  <Link
                    href={`/clients/${c.id}`}
                    className="block min-h-11 rounded-xl bg-card p-3 ring-1 ring-foreground/10 active:bg-muted"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {c.doNotCall ? (
                            <PhoneOffIcon
                              className="size-3.5 shrink-0 text-destructive"
                              aria-label={t("list.doNotCall")}
                            />
                          ) : null}
                          <span className="truncate">{c.fullName}</span>
                        </p>
                        <p className="text-sm text-muted-foreground tabular-nums">
                          {formatPhone(c.phone)}
                        </p>
                      </div>
                      {c.category ? (
                        <CategoryChip
                          name={categoryName(c.category)}
                          color={c.category.color}
                          className="shrink-0"
                        />
                      ) : null}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      {c.source ? <span>{c.source.name}</span> : null}
                      <span className={overdueFollowup ? "font-medium text-destructive" : undefined}>
                        {t("list.columns.nextFollowup")} : {fmtDate(c.nextFollowupAt)}
                      </span>
                      <span>
                        {t("list.columns.lastContacted")} : {fmtDate(c.lastContactedAt)}
                      </span>
                      <span>{c.assignedTo?.name ?? t("list.unassigned")}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>

          <Pagination
            page={page}
            pages={pages}
            basePath="/clients"
            params={queryParams}
            labels={{
              previous: t("list.previous"),
              next: t("list.next"),
              page: t("list.page", { page, pages }),
            }}
          />
        </>
      )}
    </div>
  );
}
