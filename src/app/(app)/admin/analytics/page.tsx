import type { Locale } from "date-fns";
import { enCA } from "date-fns/locale/en-CA";
import { fr } from "date-fns/locale/fr";
import { formatInTimeZone } from "date-fns-tz";
import {
  Activity,
  CalendarCheck,
  ChartColumn,
  Clock,
  Phone,
  PhoneCall,
  Timer,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import {
  ACTIVITY_KINDS,
  formHasTimeAxis,
  isHourProfile,
  resolveForm,
  resolveGrain,
  type ActivityKind,
} from "@/components/analytics/activity";
import {
  ActivityChart,
  ActivityFormSelect,
  ActivityGrainTabs,
  type ActivityDatum,
} from "@/components/analytics/activity-chart";
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
import {
  listDays,
  listHourProfile,
  listHours,
  listWeekStarts,
  resolvePeriod,
} from "@/components/analytics/period";
import { UserStatsTable } from "@/components/analytics/user-stats-table";
import { VizTheme } from "@/components/analytics/viz-theme";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { dispositionDisplayMap } from "@/lib/dispositions";
import { requirePerm } from "@/lib/permissions/server";
import { cn } from "@/lib/utils";
import {
  getActivityBuckets,
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
  await requirePerm("admin.analytics");
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

  // La maille du graphique d'activité. « Heure » a deux lectures et c'est la
  // LONGUEUR de la période qui tranche — l'écran l'annonce sous le titre.
  const grain = resolveGrain(first(sp.grain));
  const hourProfile = isHourProfile(grain, period.dayCount);
  const form = resolveForm(first(sp.form));
  const timeAxis = formHasTimeAxis(form);

  const [kpis, perDay, perWeek, dispositions, userStats, users, activity] = await Promise.all([
    getKpis(filter),
    getCallsPerDay(filter),
    getBookingsPerWeek(filter),
    getDispositionBreakdown(filter),
    getUserStats(filter),
    getUserOptions(),
    getActivityBuckets(filter, grain, hourProfile),
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

  // ── Activité : un axe continu, puis les libellés ───────────────────────────
  //
  // Les cases sans geste valent 0 et restent affichées : un trou dans la frise
  // se lirait comme une compression du temps, pas comme une journée creuse.
  const weekdayLabel = (dateStr: string) =>
    formatInTimeZone(new Date(`${dateStr}T12:00:00Z`), "UTC", "EEE d MMM", {
      locale: dateLocale,
    });
  const hourLabel = (hh: string) => t("activity.hour", { hour: Number(hh) });

  const activityKeys =
    grain === "week"
      ? listWeekStarts(period.fromStr, period.toStr)
      : grain === "day"
        ? listDays(period.fromStr, period.toStr)
        : hourProfile
          ? listHourProfile()
          : listHours(period.fromStr, period.toStr);

  const activityByBucket = new Map<string, Partial<Record<ActivityKind, number>>>();
  for (const row of activity) {
    const slot = activityByBucket.get(row.bucket) ?? {};
    slot[row.kind] = (slot[row.kind] ?? 0) + row.count;
    activityByBucket.set(row.bucket, slot);
  }

  /** L'étiquette d'axe (courte) et celle de l'infobulle (complète). */
  const activityLabels = (key: string): { label: string; full: string } => {
    if (grain === "week") {
      const week = t("charts.weekOf", { date: dayLabel(key) });
      return { label: week, full: week };
    }
    if (grain === "day") return { label: dayLabel(key), full: weekdayLabel(key) };
    if (hourProfile) {
      return {
        label: hourLabel(key),
        full: t("activity.hourRange", { from: Number(key), to: (Number(key) + 1) % 24 }),
      };
    }
    const [day = key, hh = "00"] = key.split(" ");
    return {
      label: `${dayLabel(day)} ${hourLabel(hh)}`,
      full: `${weekdayLabel(day)}, ${hourLabel(hh)}`,
    };
  };

  const activityData: ActivityDatum[] = activityKeys.map((key) => {
    const slot = activityByBucket.get(key) ?? {};
    return {
      key,
      ...activityLabels(key),
      ...(Object.fromEntries(
        ACTIVITY_KINDS.map((kind) => [kind, slot[kind] ?? 0]),
      ) as Record<ActivityKind, number>),
    };
  });

  const dispoTotal = dispositions.reduce((acc, d) => acc + d.count, 0);
  const dispoByKey = new Map(dispositions.map((d) => [d.disposition, d.count]));
  const orderedKeys = [
    ...DONUT_ORDER.filter((k) => dispoByKey.has(k)),
    ...dispositions.map((d) => d.disposition).filter((k) => !DONUT_ORDER.includes(k)),
  ];
  // Les dispositions sont désormais des statuts du pipeline : libellé et
  // couleur viennent de la table categories (repli i18n pour no_answer et les
  // vieilles valeurs orphelines).
  const catRows = await db
    .select({
      id: categories.id,
      key: categories.key,
      nameFr: categories.nameFr,
      nameEn: categories.nameEn,
      color: categories.color,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .orderBy(asc(categories.sortOrder));
  const dispoDisplay = dispositionDisplayMap(catRows, locale);
  const donutData: DispositionDatum[] = orderedKeys.map((key) => {
    const count = dispoByKey.get(key) ?? 0;
    const display = dispoDisplay.get(key);
    return {
      key,
      label:
        display?.label ??
        (t.has(`dispositions.${key}`)
          ? t(`dispositions.${key}`)
          : /^cat:\d+$/.test(key)
            ? t("dispositions.deleted")
            : key),
      count,
      pct: dispoTotal > 0 ? Math.round((count / dispoTotal) * 100) : 0,
      // Les 7 anciennes valeurs gardent leurs variables CSS validées (dont
      // l'ajustement mode sombre de « dncl ») ; les statuts du pipeline
      // prennent leur couleur de catégorie.
      ...(display && !DONUT_ORDER.includes(key) ? { color: display.color } : {}),
    };
  });

  const minutesPerUser = userStats
    .map((u) => ({ name: u.name, minutes: Math.round(u.totalSec / 60) }))
    .sort((a, b) => b.minutes - a.minutes);

  const connectRate =
    kpis.totalCalls > 0 ? Math.round((kpis.connectedCalls / kpis.totalCalls) * 100) : 0;

  const kpiTiles: {
    key: string;
    label: string;
    value: string;
    hint?: string;
    icon: LucideIcon;
    accent?: boolean;
  }[] = [
    { key: "total", label: t("kpi.totalCalls"), value: nf.format(kpis.totalCalls), icon: Phone },
    {
      key: "connected",
      label: t("kpi.connectedCalls"),
      value: nf.format(kpis.connectedCalls),
      hint: t("kpi.connectRate", { rate: connectRate }),
      icon: PhoneCall,
    },
    {
      key: "minutes",
      label: t("kpi.totalMinutes"),
      value: nf.format(Math.round(kpis.totalSec / 60)),
      icon: Clock,
    },
    {
      key: "avg",
      label: t("kpi.avgDuration"),
      value: mmss(kpis.connectedCalls > 0 ? kpis.answeredSec / kpis.connectedCalls : 0),
      hint: t("kpi.avgDurationHint"),
      icon: Timer,
    },
    {
      key: "rdv",
      label: t("kpi.appointments"),
      value: nf.format(kpis.appointments),
      icon: CalendarCheck,
      accent: true,
    },
    {
      key: "leads",
      label: t("kpi.leads"),
      value: nf.format(kpis.leads),
      icon: UserPlus,
      accent: true,
    },
  ];

  return (
    <div className="nx-viz space-y-5 p-4 md:p-6">
      <VizTheme />

      <PageHeader
        icon={<ChartColumn />}
        title={t("title")}
        subtitle={t("subtitle")}
      />

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
          <Card key={tile.key} size="sm" className="shadow-xs">
            <CardContent className="space-y-0.5">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-xs text-muted-foreground">{tile.label}</p>
                <tile.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </div>
              <p
                className={cn(
                  "text-2xl font-semibold tabular-nums",
                  tile.accent && "text-emerald-600 dark:text-emerald-400",
                )}
              >
                {tile.value}
              </p>
              {tile.hint ? (
                <p className="truncate text-xs text-muted-foreground">{tile.hint}</p>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ── Graphiques ── */}
      <section className="grid gap-4 lg:grid-cols-2">
        {/* Ce qu'on a fait, et QUAND — la seule carte qui répond à l'heure. */}
        <Card className="shadow-xs lg:col-span-2">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Activity aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                {t("activity.title")}
              </CardTitle>
              {/* Ce que le dessin montre VRAIMENT — la bascule du profil
                  horaire comme la disparition de l'axe de temps se disent en
                  toutes lettres, jamais par le seul aspect du graphique. */}
              <p className="text-xs text-muted-foreground">
                {!timeAxis
                  ? t("activity.hintNoTime")
                  : hourProfile
                    ? t("activity.hintProfile", { days: period.dayCount })
                    : t(`activity.hint.${grain}`)}
              </p>
            </div>
            {/* `shrink-0` : sans lui, une aide sur deux lignes écrase les
                commandes et le menu de forme passe à la ligne tout seul. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <ActivityGrainTabs grain={grain} disabled={!timeAxis} />
              <ActivityFormSelect form={form} />
            </div>
          </CardHeader>
          <CardContent>
            <ActivityChart data={activityData} form={form} locale={locale} />
          </CardContent>
        </Card>

        <Card className="shadow-xs lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("charts.callsPerDay")}</CardTitle>
          </CardHeader>
          <CardContent className="h-72">
            <CallsPerDayChart data={callsPerDay} />
          </CardContent>
        </Card>

        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle>{t("charts.bookingsPerWeek")}</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <BookingsPerWeekChart data={bookingsPerWeek} />
          </CardContent>
        </Card>

        <Card className="shadow-xs">
          <CardHeader>
            <CardTitle>{t("charts.dispositions")}</CardTitle>
          </CardHeader>
          <CardContent>
            <DispositionsDonut data={donutData} />
          </CardContent>
        </Card>

        <Card className="shadow-xs lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("charts.minutesPerUser")}</CardTitle>
          </CardHeader>
          <CardContent>
            <MinutesPerUserChart data={minutesPerUser} />
          </CardContent>
        </Card>
      </section>

      {/* ── Le tableau clé ── */}
      <Card className="shadow-xs">
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
