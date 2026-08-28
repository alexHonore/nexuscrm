import { formatInTimeZone } from "date-fns-tz";
import { and, asc, desc, eq, gte, lt, or, type SQL } from "drizzle-orm";
import { CalendarDays } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { db } from "@/db";
import { appointments, clients, users } from "@/db/schema";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { loadDirectory, requireActor, visibilityCondition } from "@/lib/permissions/server";
import { type AppointmentItem } from "@/components/booking/appointments-list";
import { AppointmentsView } from "@/components/booking/appointments-view";
import { PageHeader } from "@/components/shell/page-header";

export const dynamic = "force-dynamic";

/**
 * L'agenda de l'équipe — et de personne d'autre.
 *
 * L'écran montrait à TOUT compte connecté chaque rendez-vous du bureau, nom et
 * numéro du client compris, alors que le tableau de bord filtrait déjà les
 * mêmes lignes. Un rendez-vous se lit ici quand l'une des deux choses est
 * vraie : la fiche est ouverte à ce regard, ou le rendez-vous est le SIEN —
 * on ne cache pas à quelqu'un une rencontre qu'il a lui-même prise.
 */
export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const sp = await searchParams;
  const viewParam = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const initialView = viewParam === "calendar" ? "calendar" : "list";
  const t = await getTranslations("booking");
  // « Masqué » est écrit une seule fois, chez les fiches.
  const tAccess = await getTranslations("clients");
  const nowDate = new Date();
  const now = nowDate.getTime();

  // ── Portée ──────────────────────────────────────────────────────────────
  // La visibilité de la FICHE ou la propriété du rendez-vous : un OU, pas un
  // ET — d'où la composition à la main plutôt que `withVisibility`, qui ajoute
  // toujours une condition.
  const [visible, { cfg, roleOf }] = await Promise.all([
    visibilityCondition(actor),
    loadDirectory(),
  ]);
  const mine = eq(appointments.userId, actor.user.id);
  const reach: SQL | undefined = visible ? or(mine, visible) : undefined;
  const scoped = (window: SQL): SQL => (reach ? and(window, reach)! : window);

  // Le compartiment ne dépend que du DÉTENTEUR de la fiche : une résolution par
  // détenteur suffit pour les quelques centaines de lignes de cet écran.
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

  // Colonnes NOMMÉES : la fiche entière n'a rien à faire dans une carte
  // d'agenda, et la jointure sur `clients` est de toute façon nécessaire pour
  // poser la visibilité.
  const columns = {
    id: appointments.id,
    userId: appointments.userId,
    type: appointments.type,
    status: appointments.status,
    startsAt: appointments.startsAt,
    endsAt: appointments.endsAt,
    meetLink: appointments.meetLink,
    location: appointments.location,
    clientId: clients.id,
    clientName: clients.fullName,
    clientPhone: clients.phone,
    holderId: clients.assignedToId,
    bookedByName: users.name,
  } as const;

  // Deux requêtes : les RDV à venir d'abord (asc), puis un historique récent
  // (desc) — sinon, passé 500 lignes, les plus anciens évincent les RDV à venir.
  const UPCOMING_LIMIT = 300;
  const PAST_LIMIT = 100;
  const [upcomingRows, pastRows] = await Promise.all([
    db
      .select(columns)
      .from(appointments)
      .innerJoin(clients, eq(clients.id, appointments.clientId))
      .innerJoin(users, eq(users.id, appointments.userId))
      .where(scoped(gte(appointments.startsAt, nowDate)))
      .orderBy(asc(appointments.startsAt))
      .limit(UPCOMING_LIMIT),
    db
      .select(columns)
      .from(appointments)
      .innerJoin(clients, eq(clients.id, appointments.clientId))
      .innerJoin(users, eq(users.id, appointments.userId))
      .where(scoped(lt(appointments.startsAt, nowDate)))
      .orderBy(desc(appointments.startsAt))
      .limit(PAST_LIMIT),
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

  const items: AppointmentItem[] = rows.map((r) => {
    const open = grantsOfHolder(r.holderId);
    const own = r.userId === actor.user.id;
    // Le rendez-vous PRIS PAR SOI reste au calendrier même quand la fiche s'est
    // fermée depuis (réassignée au patron, par exemple) : c'est son agenda. La
    // fiche, elle, ne se rouvre pas pour autant — ni nom, ni numéro, et surtout
    // aucun lien : il mènerait à un « introuvable » qui annoncerait quand même
    // qu'il y a une fiche derrière ce rendez-vous.
    const masked = !open.visible;
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      meetLink: r.meetLink,
      location: r.location,
      clientId: masked ? null : r.clientId,
      clientName: masked ? tAccess("access.masked") : r.clientName,
      // La carte n'AFFICHE ce numéro que sous le nom ; quand le compartiment
      // ferme les coordonnées, elle affiche le mot qui le dit. Le jour où un
      // bouton d'appel apparaît ici, il lui faudra un vrai drapeau.
      clientPhone: !masked && open.contact ? r.clientPhone : tAccess("access.masked"),
      bookedByName: r.bookedByName,
      // Revérifié dans cancelAppointment : ceci ne fait qu'afficher le bouton.
      // Annuler le rendez-vous de quelqu'un d'autre, c'est disposer de SA
      // fiche — d'où la case « réserver » du compartiment, et non le rôle.
      canCancel: (own || open.book) && r.status === "scheduled",
    };
  });

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
