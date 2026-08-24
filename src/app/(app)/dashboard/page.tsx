import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  BarChart3Icon,
  CalendarCheckIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClockIcon,
  MapPinIcon,
  PhoneCallIcon,
  PhoneMissedIcon,
  PhoneOffIcon,
  VideoIcon,
} from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/db";
import { appointments, calls, clients, followups } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { formatPhone, phoneMatchKey } from "@/lib/phone";
import { RedialButton } from "@/components/calls/redial-button";
import { APP_TZ, torontoDayRange } from "@/components/clients/timezone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FollowupItem, type FollowupItemData } from "./followup-item";
import { QuickSearch } from "./quick-search";

export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;

  const now = new Date();
  const { start, end } = torontoDayRange(now);
  const missedWindowStart = new Date(now.getTime() - 7 * 24 * 3600_000);

  // Prochains rendez-vous (14 jours), en cours inclus. Le courtier (admin)
  // voit TOUTE l'équipe — chaque rencontre prise par un téléphoniste est la
  // sienne ; un téléphoniste ne voit que les siennes.
  const upcomingHorizon = new Date(now.getTime() + 14 * 24 * 3600_000);
  const upcomingWhere = and(
    ...(user.role === "admin" ? [] : [eq(appointments.userId, user.id)]),
    eq(appointments.status, "scheduled"),
    gte(appointments.endsAt, now),
    lt(appointments.startsAt, upcomingHorizon),
  );

  const [pendingFollowups, upcomingAppointments, upcomingCount, [callStats], bookedToday, missedRows] =
    await Promise.all([
    db.query.followups.findMany({
      where: and(
        eq(followups.assignedToId, user.id),
        isNull(followups.doneAt),
        lt(followups.dueAt, end),
      ),
      with: { client: true },
      orderBy: [asc(followups.dueAt)],
      limit: 50,
    }),
    db.query.appointments.findMany({
      where: upcomingWhere,
      with: { client: true, user: { columns: { name: true } } },
      orderBy: [asc(appointments.startsAt)],
      limit: 8,
    }),
    db.$count(appointments, upcomingWhere),
    db
      .select({
        count: sql<number>`count(*)::int`,
        seconds: sql<number>`coalesce(sum(${calls.durationSec}), 0)::int`,
      })
      .from(calls)
      .where(and(eq(calls.userId, user.id), gte(calls.startedAt, start), lt(calls.startedAt, end))),
    db.$count(
      appointments,
      and(
        eq(appointments.userId, user.id),
        gte(appointments.createdAt, start),
        lt(appointments.createdAt, end),
      ),
    ),
    // Appels manqués (7 jours) sur MA ligne — le filtre « jamais retourné »
    // est calculé plus bas, en mémoire, pour épargner à la page d'accueil un
    // anti-join à base d'expressions régulières sur toute la table.
    db
      .select({
        id: calls.id,
        startedAt: calls.startedAt,
        fromNumber: calls.fromNumber,
        clientId: clients.id,
        clientName: clients.fullName,
        clientDoNotCall: clients.doNotCall,
      })
      .from(calls)
      .leftJoin(clients, eq(clients.id, calls.clientId))
      .where(
        and(
          eq(calls.userId, user.id),
          eq(calls.direction, "inbound"),
          isNull(calls.answeredAt),
          isNotNull(calls.fromNumber),
          gte(calls.startedAt, missedWindowStart),
        ),
      )
      .orderBy(desc(calls.startedAt))
      .limit(50),
  ]);

  // « Jamais retourné » : aucun appel POSTÉRIEUR, de qui que ce soit dans
  // l'équipe, vers ou depuis ce numéro (sortant = on a tenté un rappel ;
  // entrant répondu = le client nous a rejoints). Ne coûte rien tant qu'il
  // n'y a aucun manqué — le cas de loin le plus fréquent.
  let unreturnedMissed: typeof missedRows = [];
  if (missedRows.length > 0) {
    const recent = await db
      .select({
        direction: calls.direction,
        fromNumber: calls.fromNumber,
        toNumber: calls.toNumber,
        startedAt: calls.startedAt,
        answeredAt: calls.answeredAt,
      })
      .from(calls)
      .where(gte(calls.startedAt, missedWindowStart));
    // Dernier contact par numéro : sortie (tentative de rappel) ou entrée répondue.
    const lastContact = new Map<string, number>();
    for (const c of recent) {
      const key =
        c.direction === "outbound"
          ? phoneMatchKey(c.toNumber)
          : c.answeredAt
            ? phoneMatchKey(c.fromNumber)
            : null;
      if (!key) continue;
      const t = c.startedAt.getTime();
      if ((lastContact.get(key) ?? 0) < t) lastContact.set(key, t);
    }
    unreturnedMissed = missedRows.filter((row) => {
      const key = phoneMatchKey(row.fromNumber);
      return !key || (lastContact.get(key) ?? 0) <= row.startedAt.getTime();
    });
  }

  const toItem = (f: (typeof pendingFollowups)[number], overdue: boolean): FollowupItemData => ({
    id: f.id,
    clientId: f.clientId,
    clientName: f.client?.fullName ?? "—",
    phone: f.client?.phone ?? "",
    phoneDisplay: formatPhone(f.client?.phone),
    note: f.note,
    dueLabel: formatInTimeZone(f.dueAt, APP_TZ, overdue ? "d MMM HH:mm" : "HH:mm", {
      locale: dfnsLocale,
    }),
    overdue,
    doNotCall: f.client?.doNotCall ?? false,
  });

  const overdueItems = pendingFollowups.filter((f) => f.dueAt < now).map((f) => toItem(f, true));
  const dueTodayItems = pendingFollowups.filter((f) => f.dueAt >= now).map((f) => toItem(f, false));

  // Un numéro = une ligne (le plus récent d'abord, avec le nombre de tentatives).
  const todayKey = formatInTimeZone(now, APP_TZ, "yyyy-MM-dd");
  type MissedGroup = {
    key: string;
    latest: (typeof missedRows)[number];
    timeLabel: string;
    count: number;
  };
  const missedGroups: MissedGroup[] = [];
  const missedByKey = new Map<string, MissedGroup>();
  for (const row of unreturnedMissed) {
    const key = phoneMatchKey(row.fromNumber) ?? row.fromNumber ?? row.id;
    const existing = missedByKey.get(key);
    if (existing) {
      existing.count += 1; // trié du plus récent au plus ancien : le 1er vu reste affiché
      continue;
    }
    const sameDay = formatInTimeZone(row.startedAt, APP_TZ, "yyyy-MM-dd") === todayKey;
    const group: MissedGroup = {
      key,
      latest: row,
      timeLabel: formatInTimeZone(row.startedAt, APP_TZ, sameDay ? "HH:mm" : "d MMM HH:mm", {
        locale: dfnsLocale,
      }),
      count: 1,
    };
    missedByKey.set(key, group);
    missedGroups.push(group);
  }
  const missedDisplay = missedGroups.slice(0, 6);

  // Prochains rendez-vous groupés par jour (Aujourd'hui / Demain / date).
  // « Demain » = prochain minuit de Toronto (`end`), pas maintenant + 24 h —
  // la nuit du passage à l'heure avancée sauterait un jour civil.
  const tomorrowKey = formatInTimeZone(end, APP_TZ, "yyyy-MM-dd");
  type ApptGroup = { key: string; label: string; items: typeof upcomingAppointments };
  const apptGroups: ApptGroup[] = [];
  for (const a of upcomingAppointments) {
    const key = formatInTimeZone(a.startsAt, APP_TZ, "yyyy-MM-dd");
    const last = apptGroups[apptGroups.length - 1];
    if (last && last.key === key) {
      last.items.push(a);
      continue;
    }
    const label =
      key === todayKey
        ? t("appointments.today")
        : key === tomorrowKey
          ? t("appointments.tomorrow")
          : formatInTimeZone(
              a.startsAt,
              APP_TZ,
              locale === "en" ? "EEEE, MMMM d" : "EEEE d MMMM",
              { locale: dfnsLocale },
            );
    apptGroups.push({ key, label, items: [a] });
  }

  const timeFormat = locale === "en" ? "h:mm a" : "HH:mm";
  const firstName = user.name.split(/\s+/)[0] ?? user.name;
  const stats = [
    {
      icon: PhoneCallIcon,
      label: t("stats.calls"),
      value: callStats?.count ?? 0,
      chip: "bg-primary/10 text-primary",
    },
    {
      icon: ClockIcon,
      label: t("stats.minutes"),
      value: Math.round((callStats?.seconds ?? 0) / 60),
      // chart-3 est un gris neutre en mode sombre — repli sur primary à un autre poids.
      chip: "bg-chart-3/15 text-chart-3 dark:bg-primary/15 dark:text-primary",
    },
    {
      icon: CalendarCheckIcon,
      label: t("stats.booked"),
      value: bookedToday,
      chip: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
    },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 md:px-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {formatInTimeZone(now, APP_TZ, locale === "en" ? "EEEE, MMMM d" : "EEEE d MMMM", { locale: dfnsLocale })}
          </p>
          <h1 className="font-heading text-2xl font-semibold tracking-tight md:text-3xl">
            {t("greeting", { name: firstName })}
          </h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {user.role === "admin" ? (
          <Button variant="outline" render={<Link href="/admin/analytics" />}>
            <BarChart3Icon />
            {t("analyticsLink")}
          </Button>
        ) : null}
      </div>

      <QuickSearch />

      {/* Quick stats — current user, today */}
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
              <span className="text-3xl font-bold tracking-tight tabular-nums">{s.value}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Appels manqués à rappeler — visible seulement quand il y en a */}
        {missedGroups.length > 0 ? (
          <Card className="shadow-xs lg:col-span-2">
            <CardHeader className="border-b">
              <CardTitle className="flex items-center gap-2">
                <PhoneMissedIcon aria-hidden className="size-4 text-red-600 dark:text-red-400" />
                {t("missedCalls.title")}
                <Badge variant="destructive" className="tabular-nums">
                  {missedGroups.length}
                </Badge>
              </CardTitle>
              <CardAction>
                <Button
                  variant="ghost"
                  className="min-h-11 text-muted-foreground md:min-h-8"
                  render={<Link href="/calls?missed=1&period=7" />}
                >
                  {t("missedCalls.viewAll")}
                  <ChevronRightIcon />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-2 md:grid-cols-2">
                {missedDisplay.map((g) => (
                  <li
                    key={g.key}
                    className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      {g.latest.clientId && g.latest.clientName ? (
                        <Link
                          href={`/clients/${g.latest.clientId}`}
                          className="block truncate text-sm font-medium hover:underline"
                        >
                          {g.latest.clientName}
                        </Link>
                      ) : (
                        <span className="block truncate text-sm font-medium tabular-nums">
                          {formatPhone(g.latest.fromNumber)}
                        </span>
                      )}
                      <p className="truncate text-xs text-muted-foreground">
                        <span className="tabular-nums">{g.timeLabel}</span>
                        {g.count > 1 ? <> · {t("missedCalls.attempts", { count: g.count })}</> : null}
                      </p>
                    </div>
                    {g.latest.clientDoNotCall ? (
                      // Fiche « Ne pas appeler » : pas de rappel en un geste —
                      // même règle que l'en-tête de la fiche et le pipeline.
                      <Button
                        type="button"
                        variant="outline"
                        className="size-11 shrink-0 rounded-full"
                        aria-label={t("missedCalls.doNotCall")}
                        disabled
                      >
                        <PhoneOffIcon className="size-4.5 text-destructive" />
                      </Button>
                    ) : (
                      <RedialButton
                        number={g.latest.fromNumber ?? ""}
                        clientId={g.latest.clientId ?? undefined}
                        clientName={g.latest.clientName ?? undefined}
                        iconOnly
                        className="shrink-0"
                      />
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        {/* Follow-ups */}
        <Card className="shadow-xs">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              {t("followups.title")}
              <Badge variant="secondary" className="tabular-nums">
                {pendingFollowups.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {overdueItems.length === 0 && dueTodayItems.length === 0 ? (
              <EmptyState
                className="py-8"
                icon={<CheckCircle2Icon className="text-emerald-700! dark:text-emerald-400!" />}
                title={t("followups.empty")}
              />
            ) : (
              <>
                {overdueItems.length > 0 ? (
                  <div className="space-y-2">
                    <p className="flex items-center gap-2 text-xs font-semibold text-destructive uppercase tracking-wide">
                      {t("followups.overdue")}
                      <Badge variant="destructive" className="tabular-nums">
                        {overdueItems.length}
                      </Badge>
                    </p>
                    <ul className="space-y-2">
                      {overdueItems.map((item) => (
                        <FollowupItem key={item.id} item={item} />
                      ))}
                    </ul>
                  </div>
                ) : null}
                {dueTodayItems.length > 0 ? (
                  <div className="space-y-2">
                    <p className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {t("followups.dueToday")}
                      <Badge variant="secondary" className="tabular-nums">
                        {dueTodayItems.length}
                      </Badge>
                    </p>
                    <ul className="space-y-2">
                      {dueTodayItems.map((item) => (
                        <FollowupItem key={item.id} item={item} />
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        {/* Prochains rendez-vous — 14 jours (admin : toute l'équipe) */}
        <Card className="shadow-xs">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              {t("appointments.title")}
              <Badge variant="secondary" className="tabular-nums">
                {upcomingCount}
              </Badge>
            </CardTitle>
            <CardAction>
              <Button
                variant="ghost"
                className="min-h-11 text-muted-foreground md:min-h-8"
                render={<Link href="/appointments?view=calendar" />}
              >
                {t("appointments.calendar")}
                <ChevronRightIcon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            {upcomingAppointments.length === 0 ? (
              <EmptyState
                className="py-8"
                icon={<CalendarDaysIcon />}
                title={t("appointments.empty")}
              />
            ) : (
              <>
                {apptGroups.map((g) => (
                  <div key={g.key} className="space-y-2">
                    <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      {g.key === todayKey ? (
                        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
                      ) : null}
                      {g.label}
                    </p>
                    <ul className="space-y-2">
                      {g.items.map((a) => (
                        <li
                          key={a.id}
                          className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                        >
                          <div className="flex shrink-0 flex-col items-center rounded-md bg-muted px-2 py-1 tabular-nums">
                            <span className="text-sm font-semibold leading-tight">
                              {formatInTimeZone(a.startsAt, APP_TZ, timeFormat, { locale: dfnsLocale })}
                            </span>
                            <span className="text-[11px] leading-tight text-muted-foreground">
                              {formatInTimeZone(a.endsAt, APP_TZ, timeFormat, { locale: dfnsLocale })}
                            </span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/clients/${a.clientId}`}
                              className="block truncate text-sm font-medium hover:underline"
                            >
                              {a.client?.fullName ?? a.title}
                            </Link>
                            <p className="truncate text-xs text-muted-foreground">
                              {user.role === "admin" && a.user?.name
                                ? t("appointments.bookedBy", { name: a.user.name })
                                : a.title}
                            </p>
                          </div>
                          <Badge variant="secondary" className="shrink-0 gap-1">
                            {a.type === "meet" ? (
                              <VideoIcon className="size-3" />
                            ) : (
                              <MapPinIcon className="size-3" />
                            )}
                            <span className="max-sm:sr-only">
                              {a.type === "meet" ? t("appointments.meet") : t("appointments.inperson")}
                            </span>
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {upcomingCount > upcomingAppointments.length ? (
                  <Link
                    href="/appointments"
                    className="flex min-h-11 items-center justify-center text-xs font-medium text-primary underline-offset-4 hover:underline md:min-h-8"
                  >
                    {t("appointments.viewAll")}
                  </Link>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
