import { desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { MessageCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ConversationsInbox, type InboxRow } from "@/components/conversations/conversations-inbox";
import { PageHeader } from "@/components/shell/page-header";
import { db } from "@/db";
import { clients, settings, users } from "@/db/schema";
import { conversations, messages, scheduledJobs, suppressions } from "@/db/schema-sms";
import { requireUser } from "@/lib/auth/guards";
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
      lastInboundAt: conversations.lastInboundAt,
      lastBody: lastMessage.body,
      lastAt: lastMessage.at,
    })
    .from(conversations)
    .leftJoin(clients, eq(clients.id, conversations.clientId))
    .leftJoin(users, eq(users.id, conversations.assignedToId))
    .leftJoin(lastMessage, eq(lastMessage.conversationId, conversations.id))
    // Les fils sans aucun message n'ont rien à traiter : ils encombreraient la
    // liste sans jamais rien demander.
    .where(or(eq(conversations.needsAttention, true), isNotNull(lastMessage.at)))
    .orderBy(desc(conversations.needsAttention), desc(lastMessage.at))
    .limit(200);

  // ── Bande d'état ─────────────────────────────────────────────────────────
  const [smsSettings, queueCounts, suppressedCount] = await Promise.all([
    db.query.settings.findFirst({ where: eq(settings.key, "sms") }),
    db
      .select({
        pending: sql<number>`(count(*) filter (where ${scheduledJobs.status} = 'pending'))::int`,
        failed: sql<number>`(count(*) filter (where ${scheduledJobs.status} = 'failed'))::int`,
      })
      .from(scheduledJobs),
    db.select({ n: sql<number>`count(*)::int` }).from(suppressions),
  ]);

  // Même lecture « fermée » que la porte d'envoi : une rangée illisible veut
  // dire suspendu, pas « tout va bien ».
  const killSwitch = (() => {
    if (!smsSettings) return false;
    const value = smsSettings.value as { killSwitch?: unknown } | null;
    if (value === null || typeof value !== "object") return true;
    return value.killSwitch === true;
  })();

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
    lastBody: r.lastBody ?? null,
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
        health={{
          killSwitch,
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

