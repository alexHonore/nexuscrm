import { formatInTimeZone } from "date-fns-tz";
import { asc, desc, gte, lt } from "drizzle-orm";
import { CalendarDays } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { type AppointmentItem } from "@/components/booking/appointments-list";
import { AppointmentsView } from "@/components/booking/appointments-view";
import { PageHeader } from "@/components/shell/page-header";

export const dynamic = "force-dynamic";

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const viewParam = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const initialView = viewParam === "calendar" ? "calendar" : "list";
  const t = await getTranslations("booking");
  const nowDate = new Date();
  const now = nowDate.getTime();

  const withRelations = {
    client: { columns: { id: true, fullName: true, phone: true } },
    user: { columns: { id: true, name: true } },
  } as const;

  // Deux requêtes : les RDV à venir d'abord (asc), puis un historique récent
  // (desc) — sinon, passé 500 lignes, les plus anciens évincent les RDV à venir.
  const UPCOMING_LIMIT = 300;
  const PAST_LIMIT = 100;
  const [upcomingRows, pastRows] = await Promise.all([
    db.query.appointments.findMany({
      with: withRelations,
      where: gte(appointments.startsAt, nowDate),
      orderBy: [asc(appointments.startsAt)],
      limit: UPCOMING_LIMIT,
    }),
    db.query.appointments.findMany({
      with: withRelations,
      where: lt(appointments.startsAt, nowDate),
      orderBy: [desc(appointments.startsAt)],
      limit: PAST_LIMIT,
    }),
  ]);

  // Bornes du calendrier : quand une limite est ATTEINTE, les mois au-delà de
  // la dernière ligne chargée paraîtraient à tort vides — la navigation s'y
  // arrête. Limite non atteinte = tout est chargé, navigation libre.
  const monthKey = (d: Date) => formatInTimeZone(d, "America/Toronto", "yyyy-MM");
  const minMonth =
    pastRows.length === PAST_LIMIT ? monthKey(pastRows[pastRows.length - 1].startsAt) : null;
  const maxMonth =
    upcomingRows.length === UPCOMING_LIMIT
      ? monthKey(upcomingRows[upcomingRows.length - 1].startsAt)
      : null;
  // Tri asc global : le regroupement par jour côté client dépend de l'ordre.
  const rows = [...upcomingRows, ...pastRows].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );

  const items: AppointmentItem[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    meetLink: r.meetLink,
    location: r.location,
    clientId: r.client.id,
    clientName: r.client.fullName,
    clientPhone: r.client.phone,
    bookedByName: r.user.name,
    // Server-checked again in cancelAppointment — this only drives button visibility.
    canCancel: (user.role === "admin" || r.userId === user.id) && r.status === "scheduled",
  }));

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 pb-safe md:px-8">
      <PageHeader
        icon={<CalendarDays />}
        title={t("page.title")}
        subtitle={t("page.subtitle")}
      />
      <AppointmentsView
        items={items}
        now={now}
        initialView={initialView}
        minMonth={minMonth}
        maxMonth={maxMonth}
      />
    </div>
  );
}
