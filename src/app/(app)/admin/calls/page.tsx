import type { Locale } from "date-fns";
import { enCA } from "date-fns/locale/en-CA";
import { fr } from "date-fns/locale/fr";
import { formatInTimeZone } from "date-fns-tz";
import { and, desc, eq, gte, ilike, like, lt, or, sql, type SQL } from "drizzle-orm";
import { PhoneCall } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CallsFilters } from "@/components/analytics/calls-filters";
import { CallsList, type CallRow } from "@/components/analytics/calls-list";
import { SyncCallsButton } from "@/components/analytics/sync-calls-button";
import { APP_TZ, dayStartUtc, shiftDateStr } from "@/components/analytics/period";
import { VizTheme } from "@/components/analytics/viz-theme";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { calls, clients, users } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/guards";
import { DISPOSITION_ORDER } from "@/lib/dispositions";
import { formatPhone } from "@/lib/phone";
import { getUserOptions } from "../analytics/queries";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata() {
  const t = await getTranslations("analytics");
  return { title: t("callsPage.title") };
}

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const t = await getTranslations("analytics");
  const locale = await getLocale();
  const dateLocale: Locale = locale === "en" ? enCA : fr;
  const nf = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA");

  // ── Filtres depuis l'URL ──
  const q = (first(sp.q) ?? "").trim().slice(0, 80);
  const userParam = first(sp.user);
  const userId = userParam && UUID_RE.test(userParam) ? userParam : undefined;
  const directionParam = first(sp.direction);
  const direction =
    directionParam === "outbound" || directionParam === "inbound"
      ? directionParam
      : undefined;
  const dispoParam = first(sp.dispo)?.slice(0, 40);
  const disposition = dispoParam || undefined;
  const fromParam = first(sp.from);
  const toParam = first(sp.to);
  const fromStr = fromParam && DATE_RE.test(fromParam) ? fromParam : undefined;
  const toStr = toParam && DATE_RE.test(toParam) ? toParam : undefined;
  const pageParam = Number(first(sp.page));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  const conds: SQL[] = [];
  if (userId) conds.push(eq(calls.userId, userId));
  if (direction) conds.push(eq(calls.direction, direction));
  if (disposition) conds.push(eq(calls.disposition, disposition));
  if (fromStr) conds.push(gte(calls.startedAt, dayStartUtc(fromStr)));
  if (toStr) conds.push(lt(calls.startedAt, dayStartUtc(shiftDateStr(toStr, 1))));
  if (q) {
    const digits = q.replace(/\D/g, "");
    const parts: SQL[] = [ilike(clients.fullName, `%${q}%`)];
    if (digits.length >= 3) {
      parts.push(
        like(calls.fromNumber, `%${digits}%`),
        like(calls.toNumber, `%${digits}%`),
        like(clients.phone, `%${digits}%`),
      );
    }
    const orCond = or(...parts);
    if (orCond) conds.push(orCond);
  }
  const where = conds.length > 0 ? and(...conds) : undefined;

  // ── Requêtes : page + total (agrégé, jamais toutes les lignes) ──
  const [rows, [{ total }], userOptions] = await Promise.all([
    db
      .select({
        id: calls.id,
        startedAt: calls.startedAt,
        direction: calls.direction,
        fromNumber: calls.fromNumber,
        toNumber: calls.toNumber,
        durationSec: calls.durationSec,
        disposition: calls.disposition,
        note: calls.note,
        recordingUrl: calls.recordingUrl,
        userName: users.name,
        clientId: clients.id,
        clientName: clients.fullName,
      })
      .from(calls)
      .innerJoin(users, eq(users.id, calls.userId))
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(where)
      .orderBy(desc(calls.startedAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(calls)
      .innerJoin(users, eq(users.id, calls.userId))
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(where),
    getUserOptions(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const timePattern = locale === "en" ? "h:mm a" : "HH 'h' mm";
  const callRows: CallRow[] = rows.map((row) => {
    const rawNumber =
      row.direction === "outbound"
        ? (row.toNumber ?? row.fromNumber)
        : (row.fromNumber ?? row.toNumber);
    return {
      id: row.id,
      dateLabel: formatInTimeZone(row.startedAt, APP_TZ, "d MMM yyyy", { locale: dateLocale }),
      timeLabel: formatInTimeZone(row.startedAt, APP_TZ, timePattern, { locale: dateLocale }),
      userName: row.userName,
      direction: row.direction,
      clientId: row.clientId,
      clientName: row.clientName,
      number: rawNumber ? formatPhone(rawNumber) : t("callsPage.unknownNumber"),
      durationSec: row.durationSec,
      disposition: row.disposition,
      dispositionLabel: row.disposition
        ? t.has(`dispositions.${row.disposition}`)
          ? t(`dispositions.${row.disposition}`)
          : row.disposition
        : null,
      note: row.note,
      recordingUrl: row.recordingUrl,
    };
  });

  // ── Liens de pagination (les filtres restent) ──
  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (userId) params.set("user", userId);
    if (direction) params.set("direction", direction);
    if (disposition) params.set("dispo", disposition);
    if (fromStr) params.set("from", fromStr);
    if (toStr) params.set("to", toStr);
    if (target > 1) params.set("page", String(target));
    const qs = params.toString();
    return qs ? `/admin/calls?${qs}` : "/admin/calls";
  };

  return (
    <div className="nx-viz space-y-4 p-4 md:p-6">
      <VizTheme />

      <PageHeader
        icon={<PhoneCall />}
        title={t("callsPage.title")}
        subtitle={t("callsPage.subtitle")}
        actions={<SyncCallsButton />}
      />

      <CallsFilters
        q={q}
        userId={userId}
        direction={direction}
        disposition={disposition}
        fromStr={fromStr}
        toStr={toStr}
        users={userOptions}
        dispositions={[...DISPOSITION_ORDER]}
      />

      <p className="text-sm tabular-nums text-muted-foreground">
        {t("callsPage.resultsCount", { count: nf.format(total) })}
      </p>

      <CallsList rows={callRows} />

      {totalPages > 1 ? (
        <nav
          aria-label={t("callsPage.pagination")}
          className="flex items-center justify-between gap-2"
        >
          <Button
            variant="outline"
            className="h-11 md:h-8"
            disabled={page <= 1}
            render={page > 1 ? <Link href={pageHref(page - 1)} /> : undefined}
          >
            {t("callsPage.prev")}
          </Button>
          <span className="text-sm tabular-nums text-muted-foreground">
            {t("callsPage.page", { page, total: totalPages })}
          </span>
          <Button
            variant="outline"
            className="h-11 md:h-8"
            disabled={page >= totalPages}
            render={page < totalPages ? <Link href={pageHref(page + 1)} /> : undefined}
          >
            {t("callsPage.next")}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
