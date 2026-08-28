import type { Locale } from "date-fns";
import { enCA } from "date-fns/locale/en-CA";
import { fr } from "date-fns/locale/fr";
import { formatInTimeZone } from "date-fns-tz";
import { and, asc, desc, eq, gte, isNull, lt, sql, type SQL } from "drizzle-orm";
import {
  CalendarCheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  PhoneCallIcon,
} from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { dayStartUtc, shiftDateStr, todayStr } from "@/components/analytics/period";
import {
  CallsFilters,
  type CallsDirection,
  type CallsPeriod,
} from "@/components/calls/calls-filters";
import {
  CallsDayList,
  type CallDayGroup,
  type CallRowData,
} from "@/components/calls/calls-list";
import { APP_TZ, torontoDayRange } from "@/components/clients/timezone";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { db } from "@/db";
import { appointments, calls, categories, clients } from "@/db/schema";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { loadDirectory, requireActor } from "@/lib/permissions/server";
import {
  DISPOSITION_CONFIG,
  dispositionDisplayMap,
  pipelineDispositionOptions,
} from "@/lib/dispositions";
import { formatPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function mmss(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export async function generateMetadata() {
  const t = await getTranslations("phone");
  return { title: t("callsPage.title") };
}

export default async function MyCallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // ── RBAC ──────────────────────────────────────────────────────────────────
  // `admin.calls` = suivre les appels de l'ÉQUIPE. Sans ce droit, le journal
  // reste personnel, quel que soit le nom du rôle : c'est la matrice qui
  // tranche, plus le littéral « admin ».
  const actor = await requireActor();
  const user = actor.user;
  const seesTeam = actor.can("admin.calls");
  const sp = await searchParams;
  const t = await getTranslations("phone");
  // « Masqué » est écrit une seule fois, chez les fiches.
  const tAccess = await getTranslations("clients");
  const locale = await getLocale();
  const dateLocale: Locale = locale === "en" ? enCA : fr;
  const nf = new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA");

  // ── Filtres depuis l'URL (aucun paramètre ne peut élargir la portée) ──
  const periodParam = first(sp.period);
  const period: CallsPeriod = periodParam === "7" || periodParam === "30" ? periodParam : "today";
  const directionParam = first(sp.direction);
  const direction: CallsDirection | undefined =
    directionParam === "outbound" || directionParam === "inbound" ? directionParam : undefined;
  // Clé de catégorie, « cat:<id> », « no_answer » ou ancienne valeur — un
  // filtre inconnu ne renvoie simplement aucune ligne.
  const dispoParam = first(sp.dispo);
  const disposition =
    dispoParam && /^[a-z0-9_:-]{1,64}$/i.test(dispoParam) ? dispoParam : undefined;
  const missed = first(sp.missed) === "1";
  const pageParam = Number(first(sp.page));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  // ── Bornes Toronto ──
  const now = new Date();
  const { start: todayStart, end: todayEnd } = torontoDayRange(now);
  const today = todayStr(now);
  const periodStart =
    period === "today" ? todayStart : dayStartUtc(shiftDateStr(today, -(Number(period) - 1)));

  // WHERE : appliqué côté serveur, aucun paramètre d'URL ne l'élargit.
  const conds: SQL[] = [
    ...(seesTeam ? [] : [eq(calls.userId, user.id)]),
    gte(calls.startedAt, periodStart),
    lt(calls.startedAt, todayEnd),
  ];
  // Manqués = entrants jamais décrochés (même définition que les analytiques).
  // Une URL forgée « direction=outbound&missed=1 » serait contradictoire :
  // « manqués » l'emporte sur la direction.
  if (direction && !(missed && direction === "outbound")) {
    conds.push(eq(calls.direction, direction));
  }
  if (disposition) conds.push(eq(calls.disposition, disposition));
  if (missed) conds.push(eq(calls.direction, "inbound"), isNull(calls.answeredAt));
  const where = and(...conds);

  const [rows, total, [todayStats], bookedToday, catRows] = await Promise.all([
    db
      .select({
        id: calls.id,
        startedAt: calls.startedAt,
        direction: calls.direction,
        answeredAt: calls.answeredAt,
        fromNumber: calls.fromNumber,
        toNumber: calls.toNumber,
        durationSec: calls.durationSec,
        disposition: calls.disposition,
        note: calls.note,
        clientId: clients.id,
        clientName: clients.fullName,
        clientDoNotCall: clients.doNotCall,
        holderId: clients.assignedToId,
      })
      .from(calls)
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(where)
      .orderBy(desc(calls.startedAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.$count(calls, where),
    // Statistiques du jour (indépendantes des filtres) — même approche que le tableau de bord.
    db
      .select({
        count: sql<number>`count(*)::int`,
        answeredSeconds: sql<number>`coalesce(sum(${calls.durationSec}) filter (where ${calls.answeredAt} is not null), 0)::int`,
      })
      .from(calls)
      .where(
        and(eq(calls.userId, user.id), gte(calls.startedAt, todayStart), lt(calls.startedAt, todayEnd)),
      ),
    db.$count(
      appointments,
      and(
        eq(appointments.userId, user.id),
        gte(appointments.createdAt, todayStart),
        lt(appointments.createdAt, todayEnd),
      ),
    ),
    db
      .select({
        id: categories.id,
        key: categories.key,
        nameFr: categories.nameFr,
        nameEn: categories.nameEn,
        color: categories.color,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .orderBy(asc(categories.sortOrder)),
  ]);

  // Dispositions = statuts du pipeline : options de filtre et affichage des
  // pastilles viennent de la table categories (repli i18n pour no_answer et
  // les vieilles valeurs orphelines).
  const dispositionOptions = pipelineDispositionOptions(
    catRows,
    locale,
    t("disposition.options.no_answer"),
  );
  const dispoDisplay = dispositionDisplayMap(catRows, locale);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Suivre les appels de l'équipe n'est pas voir toutes les FICHES : un appel
  // reste journalisé (il a bien eu lieu), mais il ne NOMME sa fiche que si le
  // compartiment de celle-ci l'ouvre à ce regard — sinon la ligne se lit comme
  // un numéro, sans nom ni lien. Le compartiment ne dépend que du détenteur :
  // une résolution par détenteur suffit pour une page de 25 lignes.
  const { cfg, roleOf } = await loadDirectory();
  const grantsCache = new Map<string, Grants>();
  const grantsOfHolder = (assignedToId: string | null): Grants => {
    const key = assignedToId ?? "";
    const hit = grantsCache.get(key);
    if (hit) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const g = grantsFor(cfg, actor.role, bucketFor(user.id, { assignedToId }, holder));
    grantsCache.set(key, g);
    return g;
  };

  // ── Groupement par jour (Toronto) : Aujourd'hui / Hier / date longue ──
  const yesterday = shiftDateStr(today, -1);
  const currentYear = today.slice(0, 4);
  const datePattern = locale === "en" ? "EEEE, MMMM d" : "EEEE d MMMM";
  const datePatternYear = locale === "en" ? "EEEE, MMMM d, yyyy" : "EEEE d MMMM yyyy";

  const groups: CallDayGroup[] = [];
  for (const row of rows) {
    const dayKey = formatInTimeZone(row.startedAt, APP_TZ, "yyyy-MM-dd");
    const remoteNumber =
      row.direction === "outbound"
        ? (row.toNumber ?? row.fromNumber)
        : (row.fromNumber ?? row.toNumber);
    const display = row.disposition ? dispoDisplay.get(row.disposition) : undefined;
    const config = row.disposition
      ? (DISPOSITION_CONFIG as Record<string, { color: string }>)[row.disposition]
      : undefined;
    const notePreview =
      row.note && row.note.length > 160 ? `${row.note.slice(0, 160)}…` : row.note;

    const rowMissed = row.direction === "inbound" && !row.answeredAt;
    const open = row.clientId ? grantsOfHolder(row.holderId) : null;
    const named = open?.visible ?? false;
    // Le numéro distant EST une coordonnée de la fiche : la case « contact »
    // décide, et fermée le numéro ne part pas — ni à l'écran, ni dans la prop
    // du bouton « Rappeler », qui atterrit telle quelle dans le HTML. Un appel
    // sans fiche rattachée n'a, lui, aucune fiche à protéger.
    const contact = open ? open.visible && open.contact : true;
    const shownNumber = contact ? remoteNumber : null;
    // La note d'après-appel raconte la fiche : c'est de l'historique, et elle
    // suit la case « history » — même quand c'est soi qui l'a écrite, car ce
    // qu'elle dit est du contenu de la fiche, pas du journal téléphonique.
    const history = open ? open.visible && open.history : true;
    // Rappeler d'un geste, c'est APPELER cette fiche : le droit `clients.call`
    // plafonne, la case « call » du compartiment tranche fiche par fiche. Sans
    // fiche rattachée, c'est le droit d'appeler tout court. Et sans numéro à
    // composer (coordonnées fermées), la ligne n'offre RIEN — pas un bouton
    // mort qui rendrait le chiffre qu'elle vient de masquer.
    const mayDial = open ? open.call : actor.can("clients.call");
    const data: CallRowData = {
      id: row.id,
      timeLabel: formatInTimeZone(row.startedAt, APP_TZ, "HH:mm"),
      direction: row.direction,
      missed: rowMissed,
      directionLabel: rowMissed
        ? t("callsPage.list.missed")
        : row.direction === "outbound"
          ? t("callsPage.list.outbound")
          : t("callsPage.list.inbound"),
      clientId: named ? row.clientId : null,
      clientName: named ? row.clientName : null,
      numberDisplay: shownNumber
        ? formatPhone(shownNumber)
        : contact
          ? t("callsPage.list.unknownNumber")
          : tAccess("access.masked"),
      // Fiche « Ne pas appeler » : aucun « Rappeler » en un geste — même règle
      // que l'en-tête de la fiche et le pipeline (clients.doNotCall est ABSOLU).
      dialNumber: row.clientDoNotCall || !mayDial ? null : shownNumber,
      durationLabel: mmss(row.durationSec),
      dispositionLabel: row.disposition
        ? (display?.label ??
          (t.has(`disposition.options.${row.disposition}`)
            ? t(`disposition.options.${row.disposition}`)
            : /^cat:\d+$/.test(row.disposition)
              ? t("disposition.deleted")
              : row.disposition))
        : rowMissed
          ? t("callsPage.list.missed")
          : null,
      // Rouge « manqué » quand l'appel n'a encore aucun résultat d'après-appel.
      dispositionColor: row.disposition
        ? (display?.color ?? config?.color ?? "#6b7280")
        : rowMissed
          ? "#dc2626"
          : null,
      note: history ? notePreview : null,
    };

    const last = groups[groups.length - 1];
    if (last && last.key === dayKey) {
      last.rows.push(data);
    } else {
      const label =
        dayKey === today
          ? t("callsPage.days.today")
          : dayKey === yesterday
            ? t("callsPage.days.yesterday")
            : formatInTimeZone(
                row.startedAt,
                APP_TZ,
                dayKey.slice(0, 4) === currentYear ? datePattern : datePatternYear,
                { locale: dateLocale },
              );
      groups.push({ key: dayKey, label, rows: [data] });
    }
  }

  const stats = [
    {
      icon: PhoneCallIcon,
      label: t("callsPage.stats.calls"),
      value: todayStats?.count ?? 0,
      chip: "bg-primary/10 text-primary",
    },
    {
      icon: ClockIcon,
      label: t("callsPage.stats.minutes"),
      value: Math.round((todayStats?.answeredSeconds ?? 0) / 60),
      // chart-3 est un gris neutre en mode sombre — repli sur primary à un autre poids.
      chip: "bg-chart-3/10 text-chart-3 dark:bg-primary/15 dark:text-primary",
    },
    {
      icon: CalendarCheckIcon,
      label: t("callsPage.stats.booked"),
      value: bookedToday,
      chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    },
  ];

  // ── Liens de pagination (les filtres restent) ──
  const pageHref = (target: number) => {
    const params = new URLSearchParams();
    if (period !== "today") params.set("period", period);
    if (direction) params.set("direction", direction);
    if (disposition) params.set("dispo", disposition);
    if (missed) params.set("missed", "1");
    if (target > 1) params.set("page", String(target));
    const qs = params.toString();
    return qs ? `/calls?${qs}` : "/calls";
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 pb-safe md:px-8">
      <PageHeader
        icon={<PhoneCallIcon />}
        title={t("callsPage.title")}
        subtitle={t("callsPage.subtitle")}
      />

      {/* Statistiques du jour — utilisateur courant */}
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        {stats.map((s) => (
          <Card key={s.label} size="sm" className="shadow-xs">
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`flex size-8 shrink-0 items-center justify-center rounded-md ${s.chip}`}
                >
                  <s.icon className="size-4" />
                </span>
                <span className="min-w-0 text-xs font-medium leading-tight text-muted-foreground">
                  {s.label}
                </span>
              </div>
              <span className="text-3xl font-bold tracking-tight tabular-nums">
                {nf.format(s.value)}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>

      <CallsFilters
        period={period}
        direction={direction}
        disposition={disposition}
        missed={missed}
        dispositionOptions={dispositionOptions}
      />

      {total === 0 ? (
        <EmptyState
          icon={<PhoneCallIcon />}
          title={t("callsPage.empty.title")}
          hint={t("callsPage.empty.hint")}
          className="rounded-xl border border-dashed"
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("callsPage.resultsCount", { count: total })}
          </p>

          <CallsDayList groups={groups} />

          {totalPages > 1 ? (
            <nav
              aria-label={t("callsPage.pagination.label")}
              className="flex items-center justify-between gap-2"
            >
              <Button
                variant="outline"
                className="min-h-11 md:min-h-8"
                disabled={page <= 1}
                render={page > 1 ? <Link href={pageHref(page - 1)} /> : undefined}
              >
                <ChevronLeftIcon />
                {t("callsPage.pagination.previous")}
              </Button>
              <span className="text-sm tabular-nums text-muted-foreground">
                {t("callsPage.pagination.page", { page, total: totalPages })}
              </span>
              <Button
                variant="outline"
                className="min-h-11 md:min-h-8"
                disabled={page >= totalPages}
                render={page < totalPages ? <Link href={pageHref(page + 1)} /> : undefined}
              >
                {t("callsPage.pagination.next")}
                <ChevronRightIcon />
              </Button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
