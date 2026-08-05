import type { Locale } from "date-fns";
import { enCA } from "date-fns/locale/en-CA";
import { fr } from "date-fns/locale/fr";
import { formatInTimeZone } from "date-fns-tz";
import { getLocale, getTranslations } from "next-intl/server";
import { AnalyticsFilters } from "@/components/analytics/analytics-filters";
import {
  BookingsPerWeekChart,
  CallsPerDayChart,
  DispositionsDonut,
  MinutesPerUserChart,
  type BookingsPerWeekDatum,
  type CallsPerDayDatum,
  type DispositionDatum,
} from "@/components/analytics/charts";
import { listDays, resolvePeriod } from "@/components/analytics/period";
import { UserStatsTable } from "@/components/analytics/user-stats-table";
import { VizTheme } from "@/components/analytics/viz-theme";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";
import {
  getBookingsPerWeek,
  getCallsPerDay,
  getDispositionBreakdown,
  getKpis,
  getUserOptions,
  getUserStats,
  type AnalyticsFilter,
} from "./queries";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ordre d'affichage de l'anneau — validé pour la séparation daltonisme (paires adjacentes + bouclage). */
const DONUT_ORDER = [
  "booked",
  "voicemail",
  "callback",
  "no_answer",
  "not_interested",
  "not_qualified",
  "dncl",
];

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function mmss(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export async function generateMetadata() {
  const t = await getTranslations("analytics");
  return { title: t("title") };
}

export default async function AnalyticsPage({
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

  const period = resolvePeriod({
    period: first(sp.period),
    from: first(sp.from),
    to: first(sp.to),
  });
  const userParam = first(sp.user);
  const userId = userParam && UUID_RE.test(userParam) ? userParam : undefined;

  const filter: AnalyticsFilter = {
    fromUtc: period.fromUtc,
    toUtcExclusive: period.toUtcExclusive,
    userId,
  };

  const [kpis, perDay, perWeek, dispositions, userStats, users] = await Promise.all([
    getKpis(filter),
    getCallsPerDay(filter),
    getBookingsPerWeek(filter),
    getDispositionBreakdown(filter),
    getUserStats(filter),
    getUserOptions(),
  ]);

  const dayLabel = (dateStr: string) =>
    formatInTimeZone(new Date(`${dateStr}T12:00:00Z`), "UTC", "d MMM", { locale: dateLocale });

  // Jours manquants remplis à 0 pour un axe temporel continu.
  const perDayMap = new Map(perDay.map((d) => [d.day, d]));
  const callsPerDay: CallsPerDayDatum[] = listDays(period.fromStr, period.toStr).map((day) => ({
    key: day,
    label: dayLabel(day),
    answered: perDayMap.get(day)?.answered ?? 0,
    missed: perDayMap.get(day)?.missed ?? 0,
  }));

  const bookingsPerWeek: BookingsPerWeekDatum[] = perWeek.map((w) => ({
    key: w.weekStart,
    label: t("charts.weekOf", { date: dayLabel(w.weekStart) }),
    count: w.count,
  }));

  const dispoTotal = dispositions.reduce((acc, d) => acc + d.count, 0);
  const dispoByKey = new Map(dispositions.map((d) => [d.disposition, d.count]));
  const orderedKeys = [
    ...DONUT_ORDER.filter((k) => dispoByKey.has(k)),
    ...dispositions.map((d) => d.disposition).filter((k) => !DONUT_ORDER.includes(k)),
  ];
  const donutData: DispositionDatum[] = orderedKeys.map((key) => {
    const count = dispoByKey.get(key) ?? 0;
    return {
      key,
      label: t.has(`dispositions.${key}`) ? t(`dispositions.${key}`) : key,
      count,
      pct: dispoTotal > 0 ? Math.round((count / dispoTotal) * 100) : 0,
    };
  });

  const minutesPerUser = userStats
    .map((u) => ({ name: u.name, minutes: Math.round(u.totalSec / 60) }))
    .sort((a, b) => b.minutes - a.minutes);

  const connectRate =
    kpis.totalCalls > 0 ? Math.round((kpis.connectedCalls / kpis.totalCalls) * 100) : 0;

  const kpiTiles: { key: string; label: string; value: string; hint?: string }[] = [
    { key: "total", label: t("kpi.totalCalls"), value: nf.format(kpis.totalCalls) },
    {
      key: "connected",
      label: t("kpi.connectedCalls"),
      value: nf.format(kpis.connectedCalls),
      hint: t("kpi.connectRate", { rate: connectRate }),
    },
    {
      key: "minutes",
      label: t("kpi.totalMinutes"),
      value: nf.format(Math.round(kpis.totalSec / 60)),
    },
    {
      key: "avg",
      label: t("kpi.avgDuration"),
      value: mmss(kpis.connectedCalls > 0 ? kpis.answeredSec / kpis.connectedCalls : 0),
      hint: t("kpi.avgDurationHint"),
    },
    { key: "rdv", label: t("kpi.appointments"), value: nf.format(kpis.appointments) },
    { key: "leads", label: t("kpi.leads"), value: nf.format(kpis.leads) },
  ];

  return (
    <div className="nx-viz space-y-5 p-4 md:p-6">
      <VizTheme />

      <header>
        <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>

      {/* Une seule rangée de filtres — elle borne tout ce qui suit. */}
      <AnalyticsFilters
        preset={period.preset}
        fromStr={period.fromStr}
        toStr={period.toStr}
        userId={userId}
        users={users}
      />

      {/* ── Tuiles KPI ── */}
      <section aria-label={t("kpi.sectionLabel")} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {kpiTiles.map((tile) => (
          <Card key={tile.key} size="sm">
            <CardContent className="space-y-0.5">
              <p className="truncate text-xs text-muted-foreground">{tile.label}</p>
              <p className="text-2xl font-semibold">{tile.value}</p>
              {tile.hint ? (
                <p className="truncate text-xs text-muted-foreground">{tile.hint}</p>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ── Graphiques ── */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("charts.callsPerDay")}</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <CallsPerDayChart data={callsPerDay} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("charts.bookingsPerWeek")}</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <BookingsPerWeekChart data={bookingsPerWeek} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("charts.dispositions")}</CardTitle>
          </CardHeader>
          <CardContent>
            <DispositionsDonut data={donutData} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("charts.minutesPerUser")}</CardTitle>
          </CardHeader>
          <CardContent>
            <MinutesPerUserChart data={minutesPerUser} />
          </CardContent>
        </Card>
      </section>

      {/* ── Le tableau clé ── */}
      <Card>
        <CardHeader>
          <CardTitle>{t("table.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <UserStatsTable rows={userStats} />
        </CardContent>
      </Card>
    </div>
  );
}
