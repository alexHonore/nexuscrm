import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { MessageCircle } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import {
  ConversationsInbox,
  type InboxRow,
  type QueueItem,
} from "@/components/conversations/conversations-inbox";
import { deedOf, CONVERSATION_DEEDS, type ConversationDeed } from "@/components/conversations/state";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { categories, clients, users } from "@/db/schema";
import {
  agentEvents,
  assistants,
  campaignEnrollments,
  campaigns,
  conversations,
  messages,
  scheduledJobs,
  suppressions,
} from "@/db/schema-sms";
import { requireUser } from "@/lib/auth/guards";
import { settingsSendGate } from "@/lib/sms-server";
import { resolveSmsMode } from "@/lib/sms/provider";
import { DEFAULT_QUIET_HOURS, isWithinSendWindow } from "@/lib/sms/quiet-hours";

/**
 * Boîte de réception des conversations — accessible aux TÉLÉPHONISTES.
 *
 * L'écran répond à une seule question : à quoi dois-je répondre maintenant?
 * D'où le tri par « à traiter » d'abord, et la bande d'état en haut : savoir
 * que les envois sont suspendus AVANT de taper une réponse évite de croire
 * qu'on a répondu.
 */
export default async function ConversationsPage() {
  const user = await requireUser();
  const t = await getTranslations("conversations");

  const lastMessage = db
    .select({
      conversationId: messages.conversationId,
      body: sql<string>`(array_agg(${messages.body} order by ${messages.createdAt} desc))[1]`.as(
        "last_body",
      ),
      // QUI a parlé en dernier : sans ça, « Parfait, je vous confirme jeudi »
      // se lit comme une phrase du client alors que c'est l'assistant — et on
      // ne peut pas trier ce qui attend une réponse de ce qui en a déjà une.
      direction: sql<string>`(array_agg(${messages.direction} order by ${messages.createdAt} desc))[1]`.as(
        "last_direction",
      ),
      source: sql<string>`(array_agg(${messages.source} order by ${messages.createdAt} desc))[1]`.as(
        "last_source",
      ),
      at: sql<Date>`max(${messages.createdAt})`.as("last_at"),
    })
    .from(messages)
    .groupBy(messages.conversationId)
    .as("last_message");

  const rows = await db
    .select({
      id: conversations.id,
      clientId: conversations.clientId,
      clientName: clients.fullName,
      clientPhone: conversations.clientPhone,
      needsAttention: conversations.needsAttention,
      attentionReason: conversations.attentionReason,
      aiEnabled: conversations.aiEnabled,
      assignedToId: conversations.assignedToId,
      assignedToName: users.name,
      assistantName: assistants.name,
      lastInboundAt: conversations.lastInboundAt,
      lastBody: lastMessage.body,
      lastDirection: lastMessage.direction,
      lastSource: lastMessage.source,
      lastAt: lastMessage.at,
    })
    .from(conversations)
    .leftJoin(clients, eq(clients.id, conversations.clientId))
    .leftJoin(users, eq(users.id, conversations.assignedToId))
    .leftJoin(assistants, eq(assistants.id, conversations.activeAssistantId))
    .leftJoin(lastMessage, eq(lastMessage.conversationId, conversations.id))
    // Les fils sans aucun message n'ont rien à traiter : ils encombreraient la
    // liste sans jamais rien demander.
    .where(or(eq(conversations.needsAttention, true), isNotNull(lastMessage.at)))
    .orderBy(desc(conversations.needsAttention), desc(lastMessage.at))
    .limit(200);

  // ── Ce que l'assistant a FAIT sur chaque fil ─────────────────────────────
  // La conclusion de son travail, pas son journal : seuls les outils REUSSIS
  // qui laissent une trace pour le client (rendez-vous, classement,
  // qualification, rappel, note, transfert) — jamais les lectures.
  const deedsByConversation = new Map<string, ConversationDeed[]>();
  if (rows.length > 0) {
    const eventRows = await db
      .selectDistinct({
        conversationId: agentEvents.conversationId,
        item: sql<string>`coalesce(${agentEvents.payload}->>'name', ${agentEvents.type})`,
      })
      .from(agentEvents)
      .where(
        and(
          inArray(
            agentEvents.conversationId,
            rows.map((r) => r.id),
          ),
          or(
            and(eq(agentEvents.type, "tool_call"), sql`${agentEvents.payload}->>'ok' = 'true'`),
            inArray(agentEvents.type, ["auto_categorized", "followup_created", "transfer"]),
          ),
        ),
      );
    for (const event of eventRows) {
      const deed = deedOf(event.item);
      if (!deed) continue;
      const list = deedsByConversation.get(event.conversationId) ?? [];
      if (!list.includes(deed)) deedsByConversation.set(event.conversationId, [...list, deed]);
    }
  }
  // L'ordre d'affichage est celui du modèle (le rendez-vous d'abord), pas
  // l'ordre d'arrivée des événements.
  const deedRank = new Map(CONVERSATION_DEEDS.map((d, i) => [d, i]));
  for (const [id, list] of deedsByConversation) {
    deedsByConversation.set(
      id,
      [...list].sort((a, b) => (deedRank.get(a) ?? 0) - (deedRank.get(b) ?? 0)),
    );
  }

  // ── File d'envoi : qui va recevoir un texto, et quand ────────────────────
  // Trois sources, une seule ligne du temps : les envois déjà écrits qui
  // attendent leur heure (annulables), les réponses que l'assistant est en
  // train de composer, et les barreaux de campagne planifiés — parfois à des
  // jours d'ici (campaign_enrollments.next_touch_at, la vraie source des
  // relances futures : le job n'existe qu'au moment dû).
  // Réservé à l'ADMIN, et pas seulement à l'écran : la file d'envoi et la
  // bande d'état exposent la santé du moteur — ce qui attend, ce qui a échoué,
  // combien de numéros se sont désabonnés. C'est la conduite de l'entreprise,
  // pas le travail d'un téléphoniste. On ne les CALCULE donc pas pour lui : une
  // donnée qu'on n'envoie pas ne peut pas fuir par le HTML.
  const isAdmin = user.role === "admin";
  const [sendJobs, turnJobs, upcomingTouches] = isAdmin
    ? await Promise.all([
    db
      .select({ id: scheduledJobs.id, runAt: scheduledJobs.runAt, payload: scheduledJobs.payload })
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.type, "send_sms"), eq(scheduledJobs.status, "pending")))
      .orderBy(asc(scheduledJobs.runAt))
      .limit(100),
    db
      .select({ id: scheduledJobs.id, runAt: scheduledJobs.runAt, payload: scheduledJobs.payload })
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.type, "agent_turn"), eq(scheduledJobs.status, "pending")))
      .orderBy(asc(scheduledJobs.runAt))
      .limit(100),
    db
      .select({
        id: campaignEnrollments.id,
        nextTouchAt: campaignEnrollments.nextTouchAt,
        step: campaignEnrollments.step,
        campaignName: campaigns.name,
        clientId: clients.id,
        clientName: clients.fullName,
      })
      .from(campaignEnrollments)
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      .innerJoin(clients, eq(clients.id, campaignEnrollments.clientId))
      .where(
        and(
          inArray(campaignEnrollments.status, ["pending", "active"]),
          isNotNull(campaignEnrollments.nextTouchAt),
        ),
      )
      .orderBy(asc(campaignEnrollments.nextTouchAt))
      .limit(100),
      ])
    : [[], [], []];

  // Les jobs ne portent qu'un conversationId : résoudre le client une fois.
  const jobConversationIds = [
    ...new Set(
      [...sendJobs, ...turnJobs]
        .map((j) => (j.payload as { conversationId?: string }).conversationId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const jobThreads = jobConversationIds.length
    ? await db
        .select({
          id: conversations.id,
          clientId: conversations.clientId,
          clientName: clients.fullName,
          clientPhone: conversations.clientPhone,
        })
        .from(conversations)
        .leftJoin(clients, eq(clients.id, conversations.clientId))
        .where(inArray(conversations.id, jobConversationIds))
    : [];
  const threadById = new Map(jobThreads.map((c) => [c.id, c]));

  const queue: QueueItem[] = [
    ...sendJobs.map((job): QueueItem => {
      const payload = job.payload as { conversationId?: string; body?: string; source?: string };
      const thread = payload.conversationId ? threadById.get(payload.conversationId) : undefined;
      return {
        id: job.id,
        kind: "send",
        clientId: thread?.clientId ?? null,
        clientName: thread?.clientName ?? thread?.clientPhone ?? "—",
        when: job.runAt.toISOString(),
        body: payload.body ?? null,
        source: payload.source ?? null,
        campaignName: null,
        step: null,
        jobId: job.id,
      };
    }),
    ...turnJobs.map((job): QueueItem => {
      const payload = job.payload as { conversationId?: string };
      const thread = payload.conversationId ? threadById.get(payload.conversationId) : undefined;
      return {
        id: job.id,
        kind: "turn",
        clientId: thread?.clientId ?? null,
        clientName: thread?.clientName ?? thread?.clientPhone ?? "—",
        when: job.runAt.toISOString(),
        body: null,
        source: null,
        campaignName: null,
        step: null,
        jobId: null,
      };
    }),
    ...upcomingTouches.map(
      (touch): QueueItem => ({
        id: touch.id,
        kind: "touch",
        clientId: touch.clientId,
        clientName: touch.clientName,
        when: (touch.nextTouchAt as Date).toISOString(),
        body: null,
        source: null,
        campaignName: touch.campaignName,
        // `step` est l'index du PROCHAIN barreau — l'humain compte à partir de 1.
        step: touch.step + 1,
        jobId: null,
      }),
    ),
  ].sort((a, b) => Date.parse(a.when) - Date.parse(b.when));

  // ── Bande d'état ─────────────────────────────────────────────────────────
  const [sendingAllowed, queueCounts, suppressedCount] = isAdmin
    ? await Promise.all([
    // On réutilise la PORTE d'envoi plutôt que de relire la rangée ici : elle
    // échoue fermé sur un réglage illisible, et réécrire cette règle à côté la
    // condamnerait à diverger — l'écran dirait « actif » pendant que le moteur
    // refuse d'envoyer.
    settingsSendGate.isSendingAllowed(),
    db
      .select({
        pending: sql<number>`(count(*) filter (where ${scheduledJobs.status} = 'pending'))::int`,
        failed: sql<number>`(count(*) filter (where ${scheduledJobs.status} = 'failed'))::int`,
      })
      .from(scheduledJobs),
    db.select({ n: sql<number>`count(*)::int` }).from(suppressions),
      ])
    : [false, [], []];

  const locale = await getLocale();
  // Les catégories du pipeline — pour classer une fiche sans quitter la boîte.
  // Chargées pour tout le monde : ranger une fiche n'est pas un geste d'admin,
  // c'est le travail d'après-conversation.
  const pipeline = await db.query.categories.findMany({
    orderBy: [asc(categories.sortOrder), asc(categories.id)],
  });
  const categoryOptions = pipeline.map((c) => ({
    id: c.id,
    label: locale === "en" ? c.nameEn : c.nameFr,
  }));

  const items: InboxRow[] = rows.map((r) => ({
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName ?? r.clientPhone,
    clientPhone: r.clientPhone,
    needsAttention: r.needsAttention,
    attentionReason: r.attentionReason,
    aiEnabled: r.aiEnabled,
    assignedToId: r.assignedToId,
    assignedToName: r.assignedToName,
    assistantName: r.assistantName,
    did: deedsByConversation.get(r.id) ?? [],
    lastBody: r.lastBody ?? null,
    lastDirection: r.lastDirection === "in" || r.lastDirection === "out" ? r.lastDirection : null,
    lastSource: r.lastSource ?? null,
    lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
  }));

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 pb-safe md:p-6">
      <PageHeader
        icon={<MessageCircle />}
        title={t("inbox.title")}
        subtitle={t("inbox.subtitle")}
      />
      <ConversationsInbox
        rows={items}
        queue={queue}
        currentUserId={user.id}
        isAdmin={isAdmin}
        categories={categoryOptions}
        health={
          isAdmin
            ? {
                killSwitch: !sendingAllowed,
                mode: resolveSmsMode(process.env),
                sendWindowOpen: isWithinSendWindow(new Date(), DEFAULT_QUIET_HOURS),
                queued: queueCounts[0]?.pending ?? 0,
                failed: queueCounts[0]?.failed ?? 0,
                suppressed: suppressedCount[0]?.n ?? 0,
              }
            : null
        }
      />
    </div>
  );
}

