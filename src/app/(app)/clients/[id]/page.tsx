import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { enUS, fr } from "date-fns/locale";
import { EyeOffIcon, HistoryIcon, LockIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/db";
import { appointments, auditLogs, calls, categories, comments, followups, sources, users } from "@/db/schema";
import {
  assistants,
  campaignEnrollments,
  campaigns,
  messages,
  scheduledJobs,
  smsNumbers,
} from "@/db/schema-sms";
import {
  grantsOnClient,
  loadDirectory,
  requireActor,
  verifyAssignment,
} from "@/lib/permissions/server";
import {
  enrollmentInFlight,
  enrollmentPaused,
  enrollmentReopenable,
} from "@/lib/campaigns/enrollment-status";
import { dispositionDisplayMap } from "@/lib/dispositions";
import { formatPhone } from "@/lib/phone";
import { APP_TZ } from "@/components/clients/timezone";
import { ClientHeader } from "@/components/clients/client-header";
import {
  ClientHistory,
  type AppointmentData,
  type CallData,
} from "@/components/clients/client-history";
import { ClientInfoForm } from "@/components/clients/client-info-form";
import { ClientSwitcher } from "@/components/clients/client-switcher";
import { CommentsTimeline, type CommentData } from "@/components/clients/comments-timeline";
import { DeleteClientButton } from "@/components/clients/delete-client-button";
import { FollowupsCard, type FollowupData } from "@/components/clients/followups-card";
import {
  CampaignEnrollmentsCard,
  type ClientEnrollmentData,
} from "@/components/clients/campaign-enrollments-card";
import { SmsThreadCard, type SmsThreadData } from "@/components/clients/sms-thread-card";
import type { FilterOption } from "@/components/clients/clients-filters";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Le numéro MASQUÉ.
 *
 * On garde la forme et les quatre derniers chiffres : assez pour reconnaître
 * un rappel, jamais assez pour composer. Le vrai numéro ne quitte pas le
 * serveur — le cacher en CSS l'aurait laissé lisible dans le HTML, ce qui
 * n'est pas un masque mais un rideau.
 */
function maskPhone(e164: string): string {
  let seen = 0;
  return [...formatPhone(e164)]
    .reverse()
    .map((ch) => (/\d/.test(ch) ? (++seen <= 4 ? ch : "•") : ch))
    .reverse()
    .join("");
}

/** Tout ce qui ne se charge QUE si l'historique de la fiche est ouvert. */
type HistoryBundle = {
  calls: CallData[];
  appointments: AppointmentData[];
  comments: CommentData[];
  followups: FollowupData[];
  enrollments: ClientEnrollmentData[];
  sms: SmsThreadData | null;
  /** Dernière écriture HUMAINE (journal d'audit) — l'auteur du « modifiée par ». */
  lastEdit: { at: Date; userName: string | null } | null;
};

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const t = await getTranslations("clients");
  const locale = await getLocale();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const client = await db.query.clients.findFirst({
    where: (c, { eq: eqOp }) => eqOp(c.id, id),
    with: { createdBy: { columns: { name: true } } },
  });
  if (!client) notFound();

  // Une fiche que ce regard n'a pas le droit de voir se comporte comme une
  // fiche ABSENTE : `notFound()`, jamais « accès refusé ». Un refus
  // confirmerait l'existence que le réglage cache — c'est exactement ce que
  // « invisible » veut dire.
  const grants = await grantsOnClient(actor, client);
  if (!grants.visible) notFound();

  // ── Ce que ce regard peut faire ────────────────────────────────────────────
  // Chaque case de `grants` est déjà plafonnée par le droit du rôle : ce qui
  // suit ne fait que croiser la relation avec ce dont l'écran a besoin. Aucun
  // de ces booléens n'est une protection — le serveur refuse de toute façon.
  const contactOpen = grants.contact;
  // Modifier suppose de VOIR les coordonnées : le formulaire renvoie tous ses
  // champs, et il ne peut pas renvoyer un numéro qu'on lui a masqué sans
  // écrire le masque en base à la place du vrai.
  const canEdit = grants.edit && contactOpen;
  const canAssignToOthers =
    grants.assign && (actor.role.superAdmin || actor.role.assignment.assignToOthers);
  // Appeler et prendre rendez-vous partent du navigateur AVEC le numéro : sans
  // le numéro, il n'y a rien à composer ni à écrire dans l'invitation.
  const canCall = grants.call && contactOpen;
  const canBook = grants.book && contactOpen;
  const canSeeRecordings = grants.history && actor.can("clients.recordings");
  const canSeeThread = grants.history && actor.can("conversations.view");
  const canReply = grants.sms && actor.can("conversations.reply");
  const canControlThread = actor.can("conversations.control");
  // Choisir QUI parle côté robot n'est pas reprendre la main : c'est son
  // propre droit et sa propre case (le superviseur livré lit les assistants
  // sans pouvoir en brancher un). L'ET est écrit en entier même si le plafond
  // de la case porte déjà ce droit — la règle se lit ici, pas dans le
  // catalogue.
  const canAssignAssistant = grants.assistant && actor.can("conversations.assistant");
  const canManageCampaigns = actor.can("admin.campaigns");

  const [allCategories, allSources] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db.query.sources.findMany({ orderBy: [asc(sources.name)] }),
  ]);
  const dispoDisplay = dispositionDisplayMap(allCategories, locale);

  // L'annuaire des comptes est déjà en cache pour cette requête (il a servi à
  // résoudre les droits) : le détenteur, son rôle et la liste des assignables
  // en sortent sans une requête de plus.
  const { rows: directory, roleOf } = await loadDirectory();
  const holder = client.assignedToId
    ? (directory.find((u) => u.id === client.assignedToId) ?? null)
    : null;
  const holderRole = holder ? (roleOf.get(holder.id) ?? null) : null;

  // Les verdicts d'assignation viennent du MOTEUR, pas d'une règle réécrite
  // ici : prendre et rendre s'affichent exactement quand le serveur les
  // accepterait (et il revérifie quand même).
  // Une fiche déjà à soi ne se prend pas : ni bouton, ni motif à donner.
  const claimable = client.assignedToId !== actor.user.id;
  const claimVerdict = claimable
    ? grants.assign
      ? await verifyAssignment(actor, client, actor.user.id)
      : // Sans la case « assigner » sur ce compartiment, le moteur n'est même
        // pas interrogé — mais le silence était pire que le refus : on nomme.
        ({ ok: false, reason: "no_right" } as const)
    : null;
  const releaseVerdict =
    grants.assign && client.assignedToId !== null
      ? await verifyAssignment(actor, client, null)
      : null;

  /**
   * POURQUOI cette fiche ne se prend pas.
   *
   * Le verrou anti-vol du courtier ne vaut que s'il s'EXPLIQUE. Un bouton
   * « Prendre cette fiche » qui disparaît sans un mot se lit comme une panne :
   * le téléphoniste rappelle quand même le lead d'un collègue, et la règle
   * qu'on vient de régler n'a rien appris à personne. Les phrases existent
   * déjà (`access.locked` / `lockedForever` / `capReached` / `noRight`) — il
   * ne manquait que de leur passer le motif rendu par le moteur.
   */
  const claimRefusal =
    claimVerdict && !claimVerdict.ok
      ? claimVerdict.reason === "cap_reached"
        ? t("access.capReached", { max: actor.role.assignment.maxOwned })
        : claimVerdict.reason === "locked"
          ? // Verrou à durée : on donne le délai. Verrou sans délai (0 jour) :
            // seule l'administration redistribue, et c'est ce qu'on dit.
            actor.cfg.assignment.staleDays > 0
            ? t("access.locked", { days: actor.cfg.assignment.staleDays })
            : t("access.lockedForever")
          : t("access.noRight")
      : null;

  // `client` n'est plus nul ici, mais TypeScript perd cette certitude dans une
  // fonction imbriquée : les deux chargeurs ci-dessous lisent cette liaison.
  const fiche = client;

  /**
   * L'historique de la fiche — appels, rendez-vous, commentaires, relances,
   * campagnes, fil SMS et journal de modifications.
   *
   * Tout est ici, et sous condition, pour une seule raison : une donnée qu'on
   * n'envoie pas ne peut fuir ni par le HTML, ni par une prop oubliée. Sans le
   * droit `history`, ces requêtes ne partent pas (même motif que /conversations).
   */
  async function loadHistory(): Promise<HistoryBundle> {
    const [callRows, appointmentRows, commentRows, followupRows, lastEditRows] = await Promise.all([
      db.query.calls.findMany({
        where: eq(calls.clientId, fiche.id),
        with: { user: { columns: { name: true } } },
        orderBy: [desc(calls.startedAt)],
        limit: 100,
      }),
      db.query.appointments.findMany({
        where: eq(appointments.clientId, fiche.id),
        with: { user: { columns: { name: true } } },
        orderBy: [desc(appointments.startsAt)],
        limit: 100,
      }),
      db.query.comments.findMany({
        where: eq(comments.clientId, fiche.id),
        with: { user: { columns: { name: true } } },
        orderBy: [asc(comments.createdAt)],
        limit: 200,
      }),
      db.query.followups.findMany({
        where: eq(followups.clientId, fiche.id),
        orderBy: [asc(followups.dueAt)],
      }),
      // « Modifiée par qui » : le schéma ne stocke pas d'updatedById — la
      // dernière écriture HUMAINE vient du journal d'audit (les mises à jour
      // système, ex. recalcul de relance, n'y figurent pas : c'est voulu).
      db
        .select({ at: auditLogs.createdAt, userName: users.name })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(
          and(
            eq(auditLogs.entity, "client"),
            eq(auditLogs.entityId, fiche.id),
            // `logAudit` écrit « client.* » (voir src/lib/audit.ts et les
            // actions de /clients) : sur « fiche.* » ce filtre ne ramenait
            // JAMAIS rien, et la ligne « modifiée par » perdait son auteur.
            inArray(auditLogs.action, ["client.update", "client.category", "client.assign"]),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1),
    ]);

    // Campagnes du client — chaque inscription avec sa campagne et l'assistant
    // qui tiendra la conversation. La fiche doit dire à quoi cette personne est
    // rattachée, et permettre d'en sortir sans partir dans l'éditeur.
    const enrollmentRows = await db
      .select({
        id: campaignEnrollments.id,
        campaignId: campaignEnrollments.campaignId,
        status: campaignEnrollments.status,
        step: campaignEnrollments.step,
        nextTouchAt: campaignEnrollments.nextTouchAt,
        endedAt: campaignEnrollments.endedAt,
        endReason: campaignEnrollments.endReason,
        enrolledAt: campaignEnrollments.enrolledAt,
        campaignName: campaigns.name,
        ladder: campaigns.ladder,
        assistantName: assistants.name,
      })
      .from(campaignEnrollments)
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      .leftJoin(assistants, eq(assistants.id, campaigns.assistantId))
      .where(eq(campaignEnrollments.clientId, fiche.id))
      .orderBy(desc(campaignEnrollments.enrolledAt));

    const now = new Date();
    return {
      calls: callRows.map((c) => ({
        id: c.id,
        direction: c.direction,
        missed: c.direction === "inbound" && !c.answeredAt,
        dispositionLabel: c.disposition
          ? (dispoDisplay.get(c.disposition)?.label ??
            (/^cat:\d+$/.test(c.disposition) ? t("dispositions.deleted") : null))
          : null,
        dispositionColor: c.disposition
          ? (dispoDisplay.get(c.disposition)?.color ?? null)
          : null,
        startedAt: c.startedAt.toISOString(),
        durationSec: c.durationSec,
        disposition: c.disposition,
        note: c.note,
        // Enregistrements : droit `clients.recordings`, via le proxy audité —
        // jamais l'URL voip.ms brute, et rien du tout sans le droit.
        recordingUrl:
          canSeeRecordings && c.recordingUrl
            ? `/api/admin/recordings?url=${encodeURIComponent(c.recordingUrl)}&callId=${encodeURIComponent(c.id)}`
            : null,
        userName: c.user?.name ?? null,
      })),
      appointments: appointmentRows.map((a) => ({
        id: a.id,
        title: a.title,
        type: a.type,
        status: a.status,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        location: a.location,
        meetLink: a.meetLink,
        userName: a.user?.name ?? null,
      })),
      comments: commentRows.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        author: { id: c.userId, name: c.user?.name ?? "—" },
      })),
      // Suivis : les ouverts d'abord (échéance croissante), puis les terminés
      // du plus récent au plus ancien.
      followups: [
        ...followupRows.filter((f) => !f.doneAt),
        ...followupRows
          .filter((f) => f.doneAt)
          .sort((a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0)),
      ].map((f) => ({
        id: f.id,
        dueAt: f.dueAt.toISOString(),
        note: f.note,
        doneAt: f.doneAt?.toISOString() ?? null,
        overdue: !f.doneAt && f.dueAt < now,
      })),
      enrollments: enrollmentRows.map((row) => {
        const paused = enrollmentPaused(row);
        const ladderLength = Array.isArray(row.ladder) ? row.ladder.length : 0;
        return {
          id: row.id,
          campaignId: row.campaignId,
          campaignName: row.campaignName,
          displayStatus: paused ? "paused" : row.status,
          inFlight: enrollmentInFlight(row.status),
          paused,
          // C'est cette carte qui rend le trou visible : « Terminée · 1/3
          // messages envoyés » se lit déjà ici, parce que le total suit
          // l'échelle ACTUELLE pendant que le compte des envois reste figé.
          reopenable: enrollmentReopenable(row, { ladderLength }).allowed,
          sent: row.step,
          total: ladderLength,
          nextTouchAt: row.nextTouchAt?.toISOString() ?? null,
          enrolledAt: row.enrolledAt.toISOString(),
          endReason: row.endReason,
          assistantName: row.assistantName,
        };
      }),
      sms: canSeeThread ? await loadThread() : null,
      lastEdit: lastEditRows[0] ?? null,
    };
  }

  /**
   * Le fil SMS. Chargé à part de la fiche : `conversations` est liée par
   * (téléphone, numéro) et non par une clé étrangère simple, et le fil doit
   * exister même quand aucune conversation n'a encore été créée.
   */
  async function loadThread(): Promise<SmsThreadData> {
    const thread = fiche.phone
      ? await db.query.conversations.findFirst({
          where: (c, { eq: eqOp }) => eqOp(c.clientId, fiche.id),
          with: { pausedBy: { columns: { name: true } } },
        })
      : undefined;

    const [threadMessages, suppressedRow, activeNumber] = await Promise.all([
      thread
        ? db
            .select({
              id: messages.id,
              direction: messages.direction,
              body: messages.body,
              createdAt: messages.createdAt,
              status: messages.status,
              errorCode: messages.errorCode,
              skipReason: messages.skipReason,
              source: messages.source,
              aiGenerated: messages.aiGenerated,
              sentByName: users.name,
            })
            .from(messages)
            .leftJoin(users, eq(users.id, messages.sentById))
            .where(eq(messages.conversationId, thread.id))
            // Les 200 plus RÉCENTS, remis dans l'ordre : un long fil perdait
            // ses derniers messages.
            .orderBy(desc(messages.createdAt))
            .limit(200)
            .then((rows) => rows.reverse())
        : Promise.resolve([]),
      fiche.phone
        ? db.query.suppressions.findFirst({
            where: (sup, { eq: eqOp }) => eqOp(sup.phoneE164, fiche.phone),
          })
        : Promise.resolve(undefined),
      db.query.smsNumbers.findFirst({ where: eq(smsNumbers.active, true) }),
    ]);

    // Envois encore EN FILE (pas encore de rangée messages) : visibles et
    // annulables. Et les assistants actifs, pour confier le fil.
    const [queuedJobs, activeAssistants, currentAssistant] = await Promise.all([
      thread
        ? db
            .select({
              id: scheduledJobs.id,
              payload: scheduledJobs.payload,
              runAt: scheduledJobs.runAt,
            })
            .from(scheduledJobs)
            .where(
              and(
                eq(scheduledJobs.type, "send_sms"),
                eq(scheduledJobs.status, "pending"),
                sql`${scheduledJobs.payload}->>'conversationId' = ${thread.id}`,
              ),
            )
            .orderBy(asc(scheduledJobs.runAt))
        : Promise.resolve([]),
      db
        .select({ id: assistants.id, name: assistants.name })
        .from(assistants)
        .where(eq(assistants.status, "active"))
        .orderBy(asc(assistants.name)),
      thread?.activeAssistantId
        ? db.query.assistants.findFirst({
            where: eq(assistants.id, thread.activeAssistantId),
            columns: { id: true, name: true },
          })
        : Promise.resolve(undefined),
    ]);

    return {
      conversationId: thread?.id ?? null,
      clientName: fiche.fullName,
      // Le numéro part masqué quand il l'est partout ailleurs : cette carte
      // l'affiche en en-tête et au-dessus du champ de saisie.
      clientPhone: contactOpen ? fiche.phone : maskPhone(fiche.phone),
      clientPhoneMasked: !contactOpen,
      aiEnabled: thread?.aiEnabled ?? true,
      pausedByName: thread?.pausedBy?.name ?? null,
      pausedAt: thread?.pausedAt?.toISOString() ?? null,
      pauseReason: thread?.pauseReason ?? null,
      needsAttention: thread?.needsAttention ?? false,
      attentionReason: thread?.attentionReason ?? null,
      suppressed: suppressedRow !== undefined,
      hasActiveNumber: activeNumber !== undefined,
      assistant: {
        currentId: thread?.activeAssistantId ?? null,
        currentName: currentAssistant?.name ?? null,
        options: activeAssistants,
      },
      queued: queuedJobs.map((j) => {
        const payload = j.payload as { body?: string; source?: string; automated?: boolean };
        return {
          jobId: j.id,
          body: payload.body ?? "",
          source: payload.source ?? "human",
          automated: payload.automated !== false,
          runAt: j.runAt.toISOString(),
        };
      }),
      messages: threadMessages.map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        status: m.status,
        errorCode: m.errorCode,
        skipReason: m.skipReason,
        source: m.source,
        aiGenerated: m.aiGenerated,
        sentByName: m.sentByName,
      })),
    };
  }

  const history = grants.history ? await loadHistory() : null;

  const sourceOptions: FilterOption[] = allSources.map((s) => ({
    value: String(s.id),
    label: s.name,
  }));
  // La liste des collègues n'est envoyée qu'à qui peut réellement donner une
  // fiche : ailleurs, elle n'est qu'un annuaire de plus dans le HTML.
  const userOptions: FilterOption[] = canAssignToOthers
    ? directory
        .filter((u) => u.isActive)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((u) => ({ value: u.id, label: u.name }))
    : [];

  // ── « Créée le … par … / Modifiée le … par … » ────────────────────────────
  const dfnsLocale = locale === "en" ? enUS : fr;
  const metaDate = (d: Date) =>
    formatInTimeZone(d, APP_TZ, "d MMM yyyy, HH:mm", { locale: dfnsLocale });

  const createdLine = client.createdBy?.name
    ? t("meta.createdBy", { date: metaDate(client.createdAt), name: client.createdBy.name })
    : t("meta.created", { date: metaDate(client.createdAt) });

  // Priorité au journal d'audit (il porte l'auteur, et n'est lu qu'avec le
  // droit d'historique) ; sinon updatedAt seul, et rien du tout si la fiche
  // n'a jamais bougé depuis sa création (± 1 min).
  const lastEdit = history?.lastEdit ?? null;
  const updatedLine = lastEdit
    ? lastEdit.userName
      ? t("meta.updatedBy", { date: metaDate(lastEdit.at), name: lastEdit.userName })
      : t("meta.updated", { date: metaDate(lastEdit.at) })
    : client.updatedAt.getTime() - client.createdAt.getTime() > 60_000
      ? t("meta.updated", { date: metaDate(client.updatedAt) })
      : null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-3 md:px-6 md:py-4">
      {/* Quick switching in the panel's filtered order + back button on mobile */}
      <div className="flex items-center gap-2">
        <ClientSwitcher clientId={client.id} />
        {grants.delete ? (
          <DeleteClientButton clientId={client.id} clientName={client.fullName} />
        ) : null}
      </div>

      <ClientHeader
        client={{
          id: client.id,
          fullName: client.fullName,
          // Déjà masqué ici quand la case `contact` est fermée : le vrai
          // numéro n'entre pas dans le composant client.
          phone: contactOpen ? client.phone : maskPhone(client.phone),
          email: contactOpen ? client.email : null,
          city: client.city,
          doNotCall: client.doNotCall,
          categoryId: client.categoryId,
        }}
        contactMasked={!contactOpen}
        canCall={canCall}
        canBook={canBook}
        canChangeCategory={grants.category}
        ownership={{
          viewerId: actor.user.id,
          holderName: holder?.name ?? null,
          holderLook: holderRole?.look ?? null,
          canClaim: claimVerdict?.ok === true,
          canRelease: releaseVerdict?.ok === true,
          staleDays: actor.cfg.assignment.staleDays,
          maxOwned: actor.role.assignment.maxOwned,
        }}
        categories={allCategories.map((c) => ({
          id: c.id,
          nameFr: c.nameFr,
          nameEn: c.nameEn,
          color: c.color,
        }))}
      />

      {claimRefusal ? (
        // Sous la barre « à qui est cette fiche » : on lit d'abord le
        // détenteur, ensuite pourquoi on ne peut pas le devenir. Même
        // habillage discret que « historique masqué » plus bas.
        <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <LockIcon aria-hidden className="size-3.5 shrink-0" />
          {claimRefusal}
        </p>
      ) : null}

      {/* Container queries: the working area is squeezed by the list panel, so
          columns depend on the available width, not the viewport. */}
      <div className="@container">
        <div className="grid items-start gap-4 @3xl:grid-cols-3 md:gap-5">
          {/* Follow-ups + comments first when stacked — the caller's workspace */}
          <div className="order-1 space-y-4 @3xl:order-2 @3xl:col-span-1 md:space-y-5">
            {history ? (
              <>
                <FollowupsCard
                  clientId={client.id}
                  canManage={grants.followup}
                  followups={history.followups}
                />
                <CommentsTimeline
                  clientId={client.id}
                  canComment={grants.comment}
                  comments={history.comments}
                />
                {/* À quoi cette personne est rattachée — visible AVANT le fil :
                    comprendre pourquoi des SMS partent précède leur lecture. */}
                {history.enrollments.length > 0 ? (
                  <CampaignEnrollmentsCard
                    clientName={client.fullName}
                    canManage={canManageCampaigns}
                    enrollments={history.enrollments}
                  />
                ) : null}
                {/* Sous les commentaires : le fil SMS fait partie de l'espace de
                    travail du téléphoniste, au même titre que ses relances. */}
                {history.sms ? (
                  <SmsThreadCard
                    clientId={client.id}
                    thread={history.sms}
                    canReply={canReply}
                    canControl={canControlThread}
                    canAssignAssistant={canAssignAssistant}
                  />
                ) : null}
              </>
            ) : null}
          </div>

          <div className="order-2 space-y-4 @3xl:order-1 @3xl:col-span-2 md:space-y-5">
            <ClientInfoForm
              client={{
                id: client.id,
                fullName: client.fullName,
                phone: contactOpen ? client.phone : maskPhone(client.phone),
                phoneAlt: contactOpen ? client.phoneAlt : null,
                email: contactOpen ? client.email : null,
                language: client.language,
                city: client.city,
                address: client.address,
                projectType: client.projectType,
                timing: client.timing,
                budget: client.budget,
                sourceId: client.sourceId,
                assignedToId: client.assignedToId,
                notes: client.notes,
              }}
              sources={sourceOptions}
              users={userOptions}
              canEdit={canEdit}
              canAssign={canAssignToOthers}
              contactMasked={!contactOpen}
            />
            {history ? (
              <ClientHistory calls={history.calls} appointments={history.appointments} />
            ) : (
              /* Rien n'a été chargé : on le DIT, plutôt que d'afficher un
                 historique vide qu'on lirait comme « il ne s'est rien passé ». */
              <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                <EyeOffIcon aria-hidden className="size-4 shrink-0" />
                {t("access.historyHidden")}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Provenance de la fiche : création et dernière modification humaine. */}
      <p className="flex items-center gap-1.5 border-t pt-3 pb-2 text-xs text-muted-foreground">
        <HistoryIcon aria-hidden className="size-3.5 shrink-0" />
        <span>
          {createdLine}
          {updatedLine ? <span> · {updatedLine}</span> : null}
        </span>
      </p>
    </div>
  );
}
