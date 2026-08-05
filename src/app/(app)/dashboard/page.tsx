import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  BarChart3Icon,
  CalendarCheckIcon,
  CalendarDaysIcon,
  ClockIcon,
  MapPinIcon,
  PhoneCallIcon,
  VideoIcon,
} from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/db";
import { appointments, calls, followups } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { formatPhone } from "@/lib/phone";
import { APP_TZ, torontoDayRange } from "@/components/clients/timezone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FollowupItem, type FollowupItemData } from "./followup-item";
import { QuickSearch } from "./quick-search";

export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;

  const now = new Date();
  const { start, end } = torontoDayRange(now);

  const [pendingFollowups, todayAppointments, [callStats], bookedToday] = await Promise.all([
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
      where: and(
        eq(appointments.userId, user.id),
        eq(appointments.status, "scheduled"),
        gte(appointments.startsAt, start),
        lt(appointments.startsAt, end),
      ),
      with: { client: true },
      orderBy: [asc(appointments.startsAt)],
    }),
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
  ]);

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
  });

  const overdueItems = pendingFollowups.filter((f) => f.dueAt < now).map((f) => toItem(f, true));
  const dueTodayItems = pendingFollowups.filter((f) => f.dueAt >= now).map((f) => toItem(f, false));

  const firstName = user.name.split(/\s+/)[0] ?? user.name;
  const stats = [
    { icon: PhoneCallIcon, label: t("stats.calls"), value: callStats?.count ?? 0 },
    {
      icon: ClockIcon,
      label: t("stats.minutes"),
      value: Math.round((callStats?.seconds ?? 0) / 60),
    },
    { icon: CalendarCheckIcon, label: t("stats.booked"), value: bookedToday },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 md:px-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
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
      <div className="grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <Card key={s.label} size="sm">
            <CardContent className="flex flex-col gap-1">
              <s.icon className="size-4 text-muted-foreground" />
              <span className="text-2xl font-semibold tabular-nums">{s.value}</span>
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Follow-ups */}
        <Card>
          <CardHeader>
            <CardTitle>{t("followups.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {overdueItems.length === 0 && dueTodayItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("followups.empty")}</p>
            ) : (
              <>
                {overdueItems.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-destructive uppercase tracking-wide">
                      {t("followups.overdue")} ({overdueItems.length})
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
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {t("followups.dueToday")} ({dueTodayItems.length})
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

        {/* Today's appointments */}
        <Card>
          <CardHeader>
            <CardTitle>{t("appointments.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {todayAppointments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("appointments.empty")}</p>
            ) : (
              <ul className="space-y-2">
                {todayAppointments.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 rounded-lg border p-3">
                    <CalendarDaysIcon className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/clients/${a.clientId}`}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {a.client?.fullName ?? a.title}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        <span className="font-medium tabular-nums">
                          {formatInTimeZone(a.startsAt, APP_TZ, "HH:mm", { locale: dfnsLocale })}
                          {" – "}
                          {formatInTimeZone(a.endsAt, APP_TZ, "HH:mm", { locale: dfnsLocale })}
                        </span>
                        {" · "}
                        {a.title}
                      </p>
                    </div>
                    <Badge variant="secondary" className="shrink-0 gap-1">
                      {a.type === "meet" ? (
                        <VideoIcon className="size-3" />
                      ) : (
                        <MapPinIcon className="size-3" />
                      )}
                      {a.type === "meet" ? t("appointments.meet") : t("appointments.inperson")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
