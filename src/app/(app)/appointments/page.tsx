import { asc, desc, gte, lt } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { appointments } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import {
  AppointmentsList,
  type AppointmentItem,
} from "@/components/booking/appointments-list";

export const dynamic = "force-dynamic";

export default async function AppointmentsPage() {
  const user = await requireUser();
  const t = await getTranslations("booking");
  const nowDate = new Date();
  const now = nowDate.getTime();

  const withRelations = {
    client: { columns: { id: true, fullName: true, phone: true } },
    user: { columns: { id: true, name: true } },
  } as const;

  // Deux requêtes : les RDV à venir d'abord (asc), puis un historique récent
  // (desc) — sinon, passé 500 lignes, les plus anciens évincent les RDV à venir.
  const [upcomingRows, pastRows] = await Promise.all([
    db.query.appointments.findMany({
      with: withRelations,
      where: gte(appointments.startsAt, nowDate),
      orderBy: [asc(appointments.startsAt)],
      limit: 300,
    }),
    db.query.appointments.findMany({
      with: withRelations,
      where: lt(appointments.startsAt, nowDate),
      orderBy: [desc(appointments.startsAt)],
      limit: 100,
    }),
  ]);
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
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 pb-safe">
      <div>
        <h1 className="font-heading text-xl font-semibold">{t("page.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("page.subtitle")}</p>
      </div>
      <AppointmentsList items={items} now={now} />
    </div>
  );
}
