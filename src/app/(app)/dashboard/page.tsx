import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  BarChart3Icon,
  CalendarDaysIcon,
  ChevronRightIcon,
  ArrowUpRightIcon,
  MapPinIcon,
  PhoneOffIcon,
  VideoIcon,
} from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/db";
import { appointments, calls, clients, followups, users } from "@/db/schema";
import { conversations } from "@/db/schema-sms";
import { needsHumanCondition } from "@/lib/conversations/attention";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { loadDirectory, requireActor, scopeFor, withVisibility } from "@/lib/permissions/server";
import { formatPhone, phoneMatchKey } from "@/lib/phone";
import { RedialButton } from "@/components/calls/redial-button";
import { APP_TZ, torontoDayRange, torontoMonthStart } from "@/components/clients/timezone";
import { CALL_DIRECTION_LOOK, CONVERSATION_STATE_LOOK, DASHBOARD_LOOK, LookIcon, lookTint } from "@/components/look";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { type FollowupItemData } from "./followup-item";
import { type FollowupDayGroup } from "./upcoming-followups";
import { FollowupWorkspace } from "./followup-workspace";
import { followupCountFields } from "./followup-counts";
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
 * tronquer en silence. Le tri par échéance garde les suivis les plus proches
 * en premier, même si le lot entier est constitué de retards.
 */
const FOLLOWUP_FETCH_LIMIT = 500;
const MISSED_CALL_FETCH_LIMIT = 50;

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
  //
  // Un VERDICT n'est pas du travail : `needsHumanCondition()` écarte les fils
  // clos, refusés et désabonnés, que le moteur laisse pourtant « signalés »
  // pour dater leur verdict. Sans elle, le tableau de bord annonçait cinq fils
  // là où la boîte de réception en montrait trois — et proposait de
  // « reprendre » un désabonnement.
  const attentionWhere = await withVisibility(
    actor,
    and(
      ...(actor.can("conversations.view") ? [] : [sql`false`]),
      needsHumanCondition(),
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
  const bookedTodayWhere = await withVisibility(
    actor,
    and(
      eq(appointments.userId, user.id),
      gte(appointments.createdAt, start),
      lt(appointments.createdAt, end),
    ),
  );

  const [
    pendingFollowups,
    upcomingAppointments,
    [upcomingCountRow],
    [callStats],
    [bookedTodayRow],
    missedRows,
    attentionRows,
    [attentionCountRow],
    [followupTotalRow],
  ] = await Promise.all([
    // En retard + aujourd'hui + les trois mois qui viennent, en UNE requête —
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
        // Qui me l'a confié. `leftJoin` : l'assistant SMS pose des suivis sans
        // auteur, et un compte supprimé laisse la colonne à null.
        createdByName: users.name,
      })
      .from(followups)
      .innerJoin(clients, eq(clients.id, followups.clientId))
      .leftJoin(users, eq(users.id, followups.createdById))
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
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(appointments)
      .innerJoin(clients, eq(clients.id, appointments.clientId))
      .where(bookedTodayWhere),
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
      .limit(MISSED_CALL_FETCH_LIMIT),
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
      .select(followupCountFields(now, end))
      .from(followups)
      .innerJoin(clients, eq(clients.id, followups.clientId))
      .where(followupWhere),
  ]);

  const upcomingCount = upcomingCountRow?.n ?? 0;
  const attentionCount = attentionCountRow?.n ?? 0;
  const pendingFollowupTotal = followupTotalRow?.n ?? 0;
  const overdueCount = followupTotalRow?.overdue ?? 0;
  const dueTodayCount = followupTotalRow?.today ?? 0;

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
      // Un suivi qu'on m'a CONFIÉ ne se lit pas comme un que je me suis noté :
      // l'un se discute avec celui qui l'a posé, l'autre pas. Rien à afficher
      // quand je suis l'auteur — ce serait me raconter ma propre journée.
      assignedByName:
        f.createdById && f.createdById !== user.id ? (f.createdByName ?? null) : null,
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
  // Ce que le plafond de chargement a laissé de côté. Le tri par échéance le
  // rend inoffensif — c'est le plus lointain qui saute — mais le taire ferait
  // croire à une liste complète.
  const followupsTruncated = Math.max(0, pendingFollowupTotal - pendingFollowups.length);

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
      timeLabel: formatInTimeZone(row.startedAt, APP_TZ, sameDay ? timeFormat : `d MMM ${timeFormat}`, {
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
  const focusCount = overdueCount + dueTodayCount;
  const hasUrgentWork = overdueCount > 0 || attentionCount > 0 || missedGroups.length > 0;
  const nextFollowup = overdueItems[0] ?? dueTodayItems[0];
  const nextAttention = attentionRows[0];
  const nextHref = overdueItems[0]
    ? `/clients/${overdueItems[0].clientId}`
    : nextAttention
      ? `/clients/${nextAttention.clientId}`
      : missedGroups.length > 0
        ? "#missed-calls"
        : nextFollowup
          ? `/clients/${nextFollowup.clientId}`
          : "/clients?focus=never";
  const nextLabel = overdueItems[0]
    ? t("briefing.nextFollowup", { name: overdueItems[0].clientName })
    : nextAttention
      ? t("briefing.nextConversation", { name: nextAttention.clientName })
      : missedGroups.length > 0
        ? t("briefing.nextMissed")
        : nextFollowup
          ? t("briefing.nextFollowup", { name: nextFollowup.clientName })
          : t("briefing.explore");
  const stats = [
    { look: DASHBOARD_LOOK.calls, label: t("stats.calls"), value: callStats?.count ?? 0 },
    { look: DASHBOARD_LOOK.minutes, label: t("stats.minutes"), value: Math.round((callStats?.seconds ?? 0) / 60) },
    { look: DASHBOARD_LOOK.booked, label: t("stats.booked"), value: bookedTodayRow?.n ?? 0 },
  ];
  const priorities = [
    {
      look: DASHBOARD_LOOK.overdue,
      label: t("briefing.overdue"),
      description: t("briefing.overdueHint"),
      value: overdueCount,
      href: "#followups",
    },
    ...(actor.can("conversations.view") ? [{
      look: CONVERSATION_STATE_LOOK.attention,
      label: t("briefing.attention"),
      description: t("briefing.attentionHint"),
      value: attentionCount,
      href: "#attention",
    }] : []),
    {
      look: CALL_DIRECTION_LOOK.missed,
      label: t("briefing.missed"),
      description: missedRows.length === MISSED_CALL_FETCH_LIMIT
        ? t("briefing.missedHintLimited", { count: MISSED_CALL_FETCH_LIMIT })
        : t("briefing.missedHint"),
      value: missedGroups.length,
      href: missedGroups.length > 0 ? "#missed-calls" : "/calls?missed=1&period=7",
    },
  ];

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-7 px-4 py-6 md:px-8 md:py-8 lg:space-y-8 lg:px-10">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-muted-foreground">
            <span className="uppercase tracking-[0.16em]">{t("workspace")}</span>
            <span aria-hidden className="h-3 w-px bg-border" />
            <span className="first-letter:uppercase">
              {formatInTimeZone(now, APP_TZ, dayLabelFormat, { locale: dfnsLocale })}
            </span>
          </p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight md:text-4xl">
            {t("greeting", { name: firstName })}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="w-full lg:max-w-sm"><QuickSearch /></div>
      </header>

      <section className="overflow-hidden rounded-2xl border bg-card shadow-xs" aria-labelledby="briefing-title">
        <div className="grid lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-5 p-5 md:p-7 lg:p-8">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg" style={lookTint(DASHBOARD_LOOK.focus)}>
                <LookIcon look={DASHBOARD_LOOK.focus} className="size-4" />
              </span>
              <p className="text-xs font-semibold uppercase tracking-[0.14em]">{t("briefing.eyebrow")}</p>
              <span className="ml-auto rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                {t("briefing.updated", { time: formatInTimeZone(now, APP_TZ, timeFormat, { locale: dfnsLocale }) })}
              </span>
            </div>
            <div className="space-y-2">
              <h2 id="briefing-title" className="max-w-lg font-heading text-2xl font-semibold leading-tight tracking-tight md:text-3xl">
                {hasUrgentWork ? t("briefing.titleBusy") : focusCount > 0 ? t("briefing.titleToday") : t("briefing.titleClear")}
              </h2>
              <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">
                {focusCount > 0 ? t("briefing.summary", { count: focusCount }) : t("briefing.summaryClear")}
              </p>
            </div>
            <Button nativeButton={false} className="min-h-11 max-w-full rounded-lg px-4" render={<Link href={nextHref} />}>
              <span className="truncate">{nextLabel}</span>
              <ArrowUpRightIcon aria-hidden className="shrink-0" />
            </Button>
          </div>
          <div className="grid grid-cols-3 border-t bg-muted/25 p-5 lg:border-t-0 lg:border-l lg:p-7">
            {stats.map((stat) => (
              <div key={stat.label} className="flex min-w-0 flex-col justify-center gap-3 px-2 first:pl-0 last:pr-0 sm:px-4 lg:gap-4">
                <LookIcon look={stat.look} className="size-5" />
                <div className="space-y-1.5">
                  <p className="text-3xl font-semibold tracking-tight tabular-nums md:text-4xl">{stat.value}</p>
                  <p className="max-w-28 text-xs leading-relaxed text-muted-foreground">{stat.label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="priorities-title">
        <div className="flex items-center justify-between gap-3">
          <h2 id="priorities-title" className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {t("briefing.priorities")}
          </h2>
          {actor.can("admin.analytics") ? (
            <Link href="/admin/analytics" className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
              <BarChart3Icon aria-hidden className="size-3.5" />
              {t("analyticsLink")}
              <ChevronRightIcon aria-hidden className="size-3.5" />
            </Link>
          ) : null}
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          {priorities.map((priority) => (
            <Link key={priority.label} href={priority.href} className="group flex min-h-24 items-center gap-3 rounded-xl border bg-card p-4 transition-all hover:border-foreground/20 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring xl:p-5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={lookTint(priority.look)}>
                <LookIcon look={priority.look} className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{priority.label}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{priority.description}</p>
              </div>
              <span className="text-2xl font-semibold tracking-tight tabular-nums">{priority.value}</span>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid items-start gap-6 min-[1180px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <section id="followups" className="scroll-mt-24">
            <FollowupWorkspace
              overdue={overdueItems}
              today={dueTodayItems}
              upcoming={upcomingGroups}
              overdueCount={overdueCount}
              todayCount={dueTodayCount}
              upcomingCount={pendingFollowupTotal - focusCount}
              truncated={followupsTruncated}
              months={UPCOMING_MONTHS}
            />
          </section>

          {missedGroups.length > 0 ? (
            <Card id="missed-calls" className="scroll-mt-24 rounded-2xl shadow-xs [--card-spacing:--spacing(5)]">
              <CardHeader className="border-b">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <LookIcon look={CALL_DIRECTION_LOOK.missed} />
                  {t("missedCalls.title")}
                  <Badge variant="secondary" className="tabular-nums">{missedGroups.length}</Badge>
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">{t("missedCalls.window")}</p>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {missedDisplay.map((group) => (
                    <li key={group.key} className="flex flex-wrap items-center gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/40">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground" aria-hidden>
                        {group.latest.clientName ? group.latest.clientName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("") : <LookIcon look={CALL_DIRECTION_LOOK.missed} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        {group.latest.clientId && group.latest.clientName ? (
                          <Link href={`/clients/${group.latest.clientId}`} className="block truncate text-sm font-medium hover:underline">
                            {group.latest.clientName}
                          </Link>
                        ) : (
                          <span className="block truncate text-sm font-medium tabular-nums">{formatPhone(group.latest.fromNumber)}</span>
                        )}
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          <span className="tabular-nums">{group.timeLabel}</span>
                          {group.count > 1 ? <> · {t("missedCalls.attempts", { count: group.count })}</> : null}
                        </p>
                      </div>
                      {group.latest.clientDoNotCall ? (
                        <Button type="button" variant="outline" className="min-h-11 shrink-0" disabled>
                          <PhoneOffIcon aria-hidden className="size-4" />
                          {t("missedCalls.doNotCall")}
                        </Button>
                      ) : (
                        <RedialButton number={group.latest.fromNumber ?? ""} clientId={group.latest.clientId ?? undefined} clientName={group.latest.clientName ?? undefined} className="shrink-0" />
                      )}
                    </li>
                  ))}
                </ul>
                <Button nativeButton={false} variant="ghost" className="mt-3 min-h-11 w-full text-xs text-muted-foreground" render={<Link href="/calls?missed=1&period=7" />}>
                  {t("missedCalls.viewAll")}
                  <ChevronRightIcon aria-hidden />
                </Button>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="min-w-0 space-y-6">
          <Card className="rounded-2xl shadow-xs [--card-spacing:--spacing(5)]">
            <CardHeader className="border-b">
              <CardTitle className="flex flex-wrap items-center gap-2">
                <LookIcon look={DASHBOARD_LOOK.agenda} />
                {t("appointments.title")}
                <Badge variant="secondary" className="tabular-nums">{upcomingCount}</Badge>
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">{t(seesEveryone ? "appointments.horizonTeam" : "appointments.horizon")}</p>
              <CardAction>
                <Button nativeButton={false} variant="ghost" className="min-h-11 px-2 text-xs text-muted-foreground" render={<Link href="/appointments?view=calendar" />}>
                  {t("appointments.calendar")}
                  <ChevronRightIcon aria-hidden />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-5">
              {upcomingAppointments.length === 0 ? (
                <EmptyState className="py-7" icon={<CalendarDaysIcon aria-hidden />} title={t("appointments.empty")} />
              ) : (
                apptGroups.map((group) => (
                  <div key={group.key} className="space-y-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p>
                    <ul className="space-y-2">
                      {group.items.map((appointment) => (
                        <li key={appointment.id} className="relative flex items-start gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/40">
                          <div className="flex w-16 shrink-0 flex-col gap-1 border-r pr-3 tabular-nums">
                            <span className="text-sm font-semibold">{formatInTimeZone(appointment.startsAt, APP_TZ, timeFormat, { locale: dfnsLocale })}</span>
                            <span className="text-[11px] text-muted-foreground">{formatInTimeZone(appointment.endsAt, APP_TZ, timeFormat, { locale: dfnsLocale })}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <Link href={`/clients/${appointment.clientId}`} className="block truncate text-sm font-medium after:absolute after:inset-0 after:rounded-xl hover:underline">
                              {appointment.clientName}
                            </Link>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">{seesEveryone ? t("appointments.bookedBy", { name: appointment.bookedByName }) : appointment.title}</p>
                            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              {appointment.type === "meet" ? <VideoIcon aria-hidden className="size-3.5" /> : <MapPinIcon aria-hidden className="size-3.5" />}
                              {appointment.type === "meet" ? t("appointments.meet") : t("appointments.inperson")}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
              {upcomingCount > upcomingAppointments.length ? (
                <Link href="/appointments" className="flex min-h-11 items-center justify-center text-xs font-medium text-primary hover:underline">
                  {t("appointments.more", { count: upcomingCount - upcomingAppointments.length })}
                </Link>
              ) : null}
            </CardContent>
          </Card>

          {actor.can("conversations.view") ? (
            <Card id="attention" className="scroll-mt-24 rounded-2xl shadow-xs [--card-spacing:--spacing(5)]">
              <CardHeader className="border-b">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <LookIcon look={CONVERSATION_STATE_LOOK.attention} />
                  {t("attention.title")}
                  <Badge variant="secondary" className="tabular-nums">{attentionCount}</Badge>
                </CardTitle>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("attention.subtitle")}</p>
              </CardHeader>
              <CardContent>
                {attentionRows.length === 0 ? (
                  <EmptyState className="py-7" icon={<LookIcon look={DASHBOARD_LOOK.clear} />} title={t("attention.empty")} />
                ) : (
                  <AttentionList
                    rows={attentionRows.map((row) => ({
                      id: row.id,
                      clientId: row.clientId,
                      clientName: row.clientName,
                      clientPhone: grantsOfHolder(row.holderId).contact ? row.clientPhone : null,
                      contactHidden: !grantsOfHolder(row.holderId).contact,
                      attentionReason: row.attentionReason,
                      lastAtLabel: (() => {
                        const at = row.lastInboundAt ?? row.lastOutboundAt;
                        return at ? formatInTimeZone(at, APP_TZ, `d MMM ${timeFormat}`, { locale: dfnsLocale }) : null;
                      })(),
                    }))}
                    hidden={attentionCount - attentionRows.length}
                  />
                )}
                <Button nativeButton={false} variant="ghost" className="mt-3 min-h-11 w-full text-xs text-muted-foreground" render={<Link href="/conversations" />}>
                  {t("attention.openInbox")}
                  <ChevronRightIcon aria-hidden />
                </Button>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
