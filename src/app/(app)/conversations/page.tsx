import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { MessageCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ConversationsInbox, type InboxRow } from "@/components/conversations/conversations-inbox";
import { deedOf, CONVERSATION_DEEDS, type ConversationDeed } from "@/components/conversations/state";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { clients, users } from "@/db/schema";
import {
  agentEvents,
  assistants,
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

  // ── Bande d'état ─────────────────────────────────────────────────────────
  const [sendingAllowed, queueCounts, suppressedCount] = await Promise.all([
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
  ]);

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
        currentUserId={user.id}
        isAdmin={user.role === "admin"}
        health={{
          killSwitch: !sendingAllowed,
          mode: resolveSmsMode(process.env),
          sendWindowOpen: isWithinSendWindow(new Date(), DEFAULT_QUIET_HOURS),
          queued: queueCounts[0]?.pending ?? 0,
          failed: queueCounts[0]?.failed ?? 0,
          suppressed: suppressedCount[0]?.n ?? 0,
        }}
      />
    </div>
  );
}

