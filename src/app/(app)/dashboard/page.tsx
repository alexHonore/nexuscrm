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
import { appointments, calls, clients, followups, users } from "@/db/schema";
import { conversations } from "@/db/schema-sms";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { loadDirectory, requireActor, scopeFor, withVisibility } from "@/lib/permissions/server";
import { formatPhone, phoneMatchKey } from "@/lib/phone";
import { RedialButton } from "@/components/calls/redial-button";
import { APP_TZ, torontoDayRange, torontoMonthStart } from "@/components/clients/timezone";
import { CONVERSATION_STATE_LOOK, LookIcon } from "@/components/look";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FollowupItem, type FollowupItemData } from "./followup-item";
import { UpcomingFollowups, type FollowupDayGroup } from "./upcoming-followups";
import { AttentionList } from "./attention-list";
import { QuickSearch } from "./quick-search";

/**
 * Horizon de la section « À venir » des suivis : demain → +3 mois civils.
 *
 * Sept jours cachaient tout ce que l'assistant SMS programme au-delà de la
 * semaine — « rappelez-moi en septembre » disparaissait de la carte jusqu'à ce
 * qu'il soit presque trop tard. Les rappels de l'IA vivent dans CETTE liste,
 * mêlés aux rappels humains ; leur horizon doit donc être celui du plus lointain
 * des deux.
 */
const UPCOMING_MONTHS = 3;

/**
 * Plafond de lignes chargées. Trois mois de relances peuvent en faire des
 * centaines ; on en charge un lot et on COMPTE le reste à part, plutôt que de
 * tronquer en silence. Le tri par échéance garantit que ce qui saute est le
 * plus lointain — jamais un retard.
 */
const FOLLOWUP_FETCH_LIMIT = 500;

export default async function DashboardPage() {
  const actor = await requireActor();
  const user = actor.user;
  const t = await getTranslations("dashboard");
  // Le vocabulaire de l'ACCÈS vit chez les fiches : « Masqué » y est déjà
  // écrit, et cet écran ne fait que le reprendre.
  const tAccess = await getTranslations("clients");
  const locale = await getLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;

  const now = new Date();
  const { start, end } = torontoDayRange(now);
  // Fin de l'horizon des suivis : minuit de Toronto trois mois CIVILS plus
  // loin — « + 90 × 24 h » déraperait d'une heure au changement d'heure et
  // couperait un jour en deux.
  const upcomingEnd = torontoMonthStart(now, UPCOMING_MONTHS);
  const missedWindowStart = new Date(now.getTime() - 7 * 24 * 3600_000);

  // ── Ce que CE regard atteint ────────────────────────────────────────────
  // Le compartiment d'une fiche ne dépend que de son DÉTENTEUR : on résout les
  // cases une fois par détenteur et non une fois par ligne — l'annuaire et la
  // matrice sont en cache de requête, la question ne coûte donc rien.
  const [{ cfg, roleOf }, scope] = await Promise.all([loadDirectory(), scopeFor(actor)]);
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

  /**
   * L'agenda et la boîte de TOUTE l'équipe, ou seulement les siens ?
   *
   * La question n'est plus « est-il administrateur » mais « toutes les fiches
   * lui sont-elles ouvertes » : qui voit tout le monde mène tout le monde
   * (courtier, superviseur). Un téléphoniste garde son propre agenda.
   */
  const seesEveryone = scope.kind === "all";

  // Prochains rendez-vous (14 jours), en cours inclus. Un rendez-vous NOMME une
  // fiche : il se cache donc avec elle, même quand c'est le rendez-vous de
  // celui qui regarde — d'où la visibilité EN PLUS du filtre par propriétaire.
  const upcomingHorizon = new Date(now.getTime() + 14 * 24 * 3600_000);
  const upcomingWhere = await withVisibility(
    actor,
    and(
      ...(seesEveryone ? [] : [eq(appointments.userId, user.id)]),
      eq(appointments.status, "scheduled"),
      gte(appointments.endsAt, now),
      lt(appointments.startsAt, upcomingHorizon),
    ),
  );

  // Les fils que l'assistant SMS a rendus à un humain — un fil PARLE d'une
  // fiche, il disparaît avec elle. Qui voit toute l'équipe voit tous les fils ;
  // les autres n'ont que ceux qui leur sont assignés, comme leurs suivis.
  const attentionWhere = await withVisibility(
    actor,
    and(
      eq(conversations.needsAttention, true),
      ...(seesEveryone ? [] : [eq(conversations.assignedToId, user.id)]),
    ),
  );

  // Un suivi m'est assigné, la fiche derrière peut avoir changé de main depuis :
  // la MÊME condition sert à la liste et à son compte, sinon le compte annonce
  // ce que la liste cache.
  const followupWhere = await withVisibility(
    actor,
    and(
      eq(followups.assignedToId, user.id),
      isNull(followups.doneAt),
      lt(followups.dueAt, upcomingEnd),
    ),
  );

  const [
    pendingFollowups,
    upcomingAppointments,
    [upcomingCountRow],
    [callStats],
    bookedToday,
    missedRows,
    attentionRows,
    [attentionCountRow],
    [followupTotalRow],
  ] = await Promise.all([
    // En retard + aujourd'hui + les 7 jours qui viennent, en UNE requête —
    // l'index (assigned_to_id, due_at) couvre la borne haute.
    //
    // Jointure explicite et colonnes NOMMÉES là où un `with: { client: true }`
    // chargeait la fiche entière : la visibilité se pose sur `clients` (donc
    // il faut la table), et une colonne qu'on ne lit pas ne peut pas fuir.
    db
      .select({
        id: followups.id,
        clientId: followups.clientId,
        dueAt: followups.dueAt,
        note: followups.note,
        createdById: followups.createdById,
        clientName: clients.fullName,
        clientPhone: clients.phone,
        clientDoNotCall: clients.doNotCall,
        holderId: clients.assignedToId,
      })
      .from(followups)
      .innerJoin(clients, eq(clients.id, followups.clientId))
      .where(followupWhere)
      .orderBy(asc(followups.dueAt))
      .limit(FOLLOWUP_FETCH_LIMIT),
    db
      .select({
        id: appointments.id,
        clientId: appointments.clientId,
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
        type: appointments.type,
        title: appointments.title,
        clientName: clients.fullName,
        bookedByName: users.name,
      })
      .from(appointments)
      .innerJoin(clients, eq(clients.id, appointments.clientId))
      .innerJoin(users, eq(users.id, appointments.userId))
      .where(upcomingWhere)
      .orderBy(asc(appointments.startsAt))
      .limit(8),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(appointments)
      .innerJoin(clients, eq(clients.id, appointments.clientId))
      .where(upcomingWhere),
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
        holderId: clients.assignedToId,
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
    // Les fils rendus à un humain — les plus récents d'abord. Le fil est
    // toujours rattaché à une fiche : c'est elle qu'on ouvre pour répondre.
    db
      .select({
        id: conversations.id,
        clientId: conversations.clientId,
        clientName: clients.fullName,
        clientPhone: conversations.clientPhone,
        attentionReason: conversations.attentionReason,
        lastInboundAt: conversations.lastInboundAt,
        lastOutboundAt: conversations.lastOutboundAt,
        holderId: clients.assignedToId,
      })
      .from(conversations)
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .where(attentionWhere)
      .orderBy(desc(conversations.lastInboundAt))
      .limit(6),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .innerJoin(clients, eq(clients.id, conversations.clientId))
      .where(attentionWhere),
    // Le VRAI nombre, pour que le plafond de chargement ne mente jamais.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(followups)
      .innerJoin(clients, eq(clients.id, followups.clientId))
      .where(followupWhere),
  ]);

  const upcomingCount = upcomingCountRow?.n ?? 0;
  const attentionCount = attentionCountRow?.n ?? 0;
  const pendingFollowupTotal = followupTotalRow?.n ?? 0;

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

  // Un manqué reste MON appel : il figure dans la liste même quand la fiche
  // derrière le numéro échappe à ce regard — mais elle n'y est plus nommée, et
  // la ligne se lit alors comme un numéro inconnu. Taire l'appel serait pire :
  // le téléphone a bel et bien sonné.
  const missedShown = unreturnedMissed.map((row) =>
    row.clientId && grantsOfHolder(row.holderId).visible
      ? row
      : { ...row, clientId: null, clientName: null },
  );

  // 16:09 en français, 4:09 PM en anglais — la carte des rendez-vous juste à
  // côté le fait déjà ; les suivis affichaient l'heure sur 24 h dans les deux
  // langues, ce qui donnait deux conventions dans la même colonne.
  const timeFormat = locale === "en" ? "h:mm a" : "HH:mm";

  const toItem = (f: (typeof pendingFollowups)[number], overdue: boolean): FollowupItemData => {
    // Le suivi reste DÛ même quand le compartiment de la fiche ferme les
    // coordonnées (une fiche prise par un collègue) : la tâche s'affiche, le
    // numéro non — et le bouton d'appel disparaît avec lui. La chaîne vide
    // d'avant gardait un composeur vivant qui composait « rien ».
    const open = grantsOfHolder(f.holderId);
    return {
      id: f.id,
      clientId: f.clientId,
      clientName: f.clientName,
      phone: open.contact ? f.clientPhone : null,
      contactHidden: !open.contact,
      // Appeler demande la case « appeler » ET le numéro : la première sans le
      // second n'a rien à composer, le second sans la première n'en a pas le
      // droit.
      canCall: open.call && open.contact,
      phoneDisplay: open.contact ? formatPhone(f.clientPhone) : tAccess("access.masked"),
      note: f.note,
      dueLabel: formatInTimeZone(f.dueAt, APP_TZ, overdue ? `d MMM ${timeFormat}` : timeFormat, {
        locale: dfnsLocale,
      }),
      overdue,
      doNotCall: f.clientDoNotCall,
      // Programmé par l'assistant SMS : lui seul écrit un suivi sans auteur
      // (`createdById` null). Les trois autres chemins portent l'utilisateur qui
      // l'a créé. Les deux familles vivent dans la MÊME liste — la marque est ce
      // qui permet de les y distinguer.
      aiScheduled: f.createdById === null,
    };
  };

  const todayKey = formatInTimeZone(now, APP_TZ, "yyyy-MM-dd");
  // « Demain » = prochain minuit de Toronto (`end`), pas maintenant + 24 h —
  // la nuit du passage à l'heure avancée sauterait un jour civil.
  const tomorrowKey = formatInTimeZone(end, APP_TZ, "yyyy-MM-dd");
  const dayLabelFormat = locale === "en" ? "EEEE, MMMM d" : "EEEE d MMMM";

  const overdueItems = pendingFollowups.filter((f) => f.dueAt < now).map((f) => toItem(f, true));
  const dueTodayItems = pendingFollowups
    .filter((f) => f.dueAt >= now && f.dueAt < end)
    .map((f) => toItem(f, false));

  // Les suivis des jours qui viennent, groupés par journée de Toronto. La date
  // vit dans l'en-tête du groupe : chaque ligne ne porte que son heure.
  const upcomingGroups: FollowupDayGroup[] = [];
  for (const f of pendingFollowups) {
    if (f.dueAt < end) continue;
    const key = formatInTimeZone(f.dueAt, APP_TZ, "yyyy-MM-dd");
    const last = upcomingGroups[upcomingGroups.length - 1];
    if (last?.key === key) {
      last.items.push(toItem(f, false));
      continue;
    }
    upcomingGroups.push({
      key,
      label:
        key === tomorrowKey
          ? t("followups.tomorrow")
          : formatInTimeZone(f.dueAt, APP_TZ, dayLabelFormat, { locale: dfnsLocale }),
      items: [toItem(f, false)],
    });
  }
  const upcomingFollowupCount = upcomingGroups.reduce((n, g) => n + g.items.length, 0);
  // Ce que le plafond de chargement a laissé de côté. Le tri par échéance le
  // rend inoffensif — c'est le plus lointain qui saute — mais le taire ferait
  // croire à une liste complète.
  const upcomingTruncated = Math.max(0, pendingFollowupTotal - pendingFollowups.length);

  // Un numéro = une ligne (le plus récent d'abord, avec le nombre de tentatives).
  type MissedGroup = {
    key: string;
    latest: (typeof missedRows)[number];
    timeLabel: string;
    count: number;
  };
  const missedGroups: MissedGroup[] = [];
  const missedByKey = new Map<string, MissedGroup>();
  for (const row of missedShown) {
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
          : formatInTimeZone(a.startsAt, APP_TZ, dayLabelFormat, { locale: dfnsLocale });
    apptGroups.push({ key, label, items: [a] });
  }

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
        {actor.can("admin.analytics") ? (
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
            {pendingFollowups.length === 0 ? (
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
                {upcomingGroups.length > 0 ? (
                  <div className="space-y-2 border-t pt-4">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("followups.upcoming")}
                      <Badge variant="secondary" className="tabular-nums">
                        {upcomingFollowupCount}
                      </Badge>
                      <span className="font-normal normal-case">
                        {t("followups.upcomingRange", { months: UPCOMING_MONTHS })}
                      </span>
                    </p>
                    <UpcomingFollowups groups={upcomingGroups} />
                    {upcomingTruncated > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("followups.truncated", { count: upcomingTruncated })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        {/* Ce que l'assistant SMS a rendu à un humain. Placé À CÔTÉ des suivis :
            c'est du travail humain dû MAINTENANT, au même titre qu'une relance
            en retard — pas une statistique du moteur. La bande de santé du
            moteur, elle, reste dans les conversations et reste au courtier. */}
        <Card className="shadow-xs">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <LookIcon look={CONVERSATION_STATE_LOOK.attention} />
              {t("attention.title")}
              <Badge variant="secondary" className="tabular-nums">
                {attentionCount}
              </Badge>
            </CardTitle>
            <CardAction>
              <Button
                variant="ghost"
                className="min-h-11 text-muted-foreground md:min-h-8"
                render={<Link href="/conversations" />}
              >
                {t("attention.openInbox")}
                <ChevronRightIcon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {attentionRows.length === 0 ? (
              <EmptyState
                className="py-8"
                icon={<CheckCircle2Icon className="text-emerald-700! dark:text-emerald-400!" />}
                title={t("attention.empty")}
              />
            ) : (
              <AttentionList
                rows={attentionRows.map((row) => ({
                  id: row.id,
                  clientId: row.clientId,
                  clientName: row.clientName,
                  // Le fil PORTE le numéro du client : il se masque comme celui
                  // de la fiche, sinon la boîte de réception rend en clair ce
                  // que la fiche cache. Et la ligne DIT qu'elle masque, au lieu
                  // de laisser croire à un fil sans numéro.
                  clientPhone: grantsOfHolder(row.holderId).contact ? row.clientPhone : null,
                  contactHidden: !grantsOfHolder(row.holderId).contact,
                  attentionReason: row.attentionReason,
                  // Mise en forme ICI : une locale `date-fns` est un objet de
                  // fonctions, et rien de tel ne traverse la frontière
                  // serveur → client. Même règle que `dueLabel` des suivis.
                  lastAtLabel: (() => {
                    const at = row.lastInboundAt ?? row.lastOutboundAt;
                    return at
                      ? formatInTimeZone(at, APP_TZ, "d MMM HH:mm", { locale: dfnsLocale })
                      : null;
                  })(),
                }))}
                hidden={attentionCount - attentionRows.length}
              />
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
                              {a.clientName}
                            </Link>
                            <p className="truncate text-xs text-muted-foreground">
                              {seesEveryone
                                ? t("appointments.bookedBy", { name: a.bookedByName })
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
