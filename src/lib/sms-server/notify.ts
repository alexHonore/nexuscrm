import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, notifications, users } from "@/db/schema";
import { conversations } from "@/db/schema-sms";
import { notificationContent } from "@/components/clients/notification-content";

export type HumanAlertKind = "inbound" | "handoff" | "blocked" | "error" | "stopped" | "closed";

const KEYS: Record<HumanAlertKind, { title: "smsInboundTitle" | "smsHandoffTitle" | "smsBlockedTitle" | "smsErrorTitle" | "smsStoppedTitle" | "smsClosedTitle"; body: "smsInboundBody" | "smsHandoffBody" | "smsBlockedBody" | "smsErrorBody" | "smsStoppedBody" | "smsClosedBody" }> = {
  inbound: { title: "smsInboundTitle", body: "smsInboundBody" },
  handoff: { title: "smsHandoffTitle", body: "smsHandoffBody" },
  blocked: { title: "smsBlockedTitle", body: "smsBlockedBody" },
  error: { title: "smsErrorTitle", body: "smsErrorBody" },
  stopped: { title: "smsStoppedTitle", body: "smsStoppedBody" },
  closed: { title: "smsClosedTitle", body: "smsClosedBody" },
};

/**
 * Prévient les humains qu'un fil SMS a besoin d'eux.
 *
 * Destinataires : l'assigné de la conversation, sinon celui de la fiche, sinon
 * tous les administrateurs actifs — chacun dans SA langue. Une seule fonction
 * pour le webhook entrant ET le moteur d'agent : avant elle, seul « Nouveau
 * texto » existait, et un passage à l'humain, un garde-fou bloquant ou une
 * panne de modèle ne prévenaient personne — le fil attendait dans l'inbox que
 * quelqu'un passe par hasard.
 */
export async function notifyHumans(input: {
  conversationId: string | null;
  clientId: string;
  kind: HumanAlertKind;
  /** Raison courte, insérée dans le corps (déjà lisible : pas un code). */
  reason?: string;
}): Promise<number> {
  const [conversation, client] = await Promise.all([
    input.conversationId
      ? db.query.conversations.findFirst({
          where: eq(conversations.id, input.conversationId),
          columns: { assignedToId: true },
        })
      : Promise.resolve(undefined),
    db.query.clients.findFirst({
      where: eq(clients.id, input.clientId),
      columns: { id: true, fullName: true, assignedToId: true },
    }),
  ]);
  if (!client) return 0;

  const assigneeId = conversation?.assignedToId ?? client.assignedToId;
  let recipients: { id: string; locale: string }[] = [];
  if (assigneeId) {
    const assignee = await db.query.users.findFirst({
      where: and(eq(users.id, assigneeId), eq(users.isActive, true)),
      columns: { id: true, locale: true },
    });
    if (assignee) recipients = [assignee];
  }
  if (recipients.length === 0) {
    recipients = await db.query.users.findMany({
      where: and(eq(users.role, "admin"), eq(users.isActive, true)),
      columns: { id: true, locale: true },
    });
  }
  if (recipients.length === 0) return 0;

  const keys = KEYS[input.kind];
  await db.insert(notifications).values(
    recipients.map((recipient) => {
      const locale = recipient.locale === "en" ? ("en" as const) : ("fr" as const);
      return {
        userId: recipient.id,
        type: `sms_${input.kind}`,
        title: notificationContent(locale, keys.title),
        body: notificationContent(locale, keys.body, {
          name: client.fullName,
          reason: input.reason ?? "",
        }),
        link: `/clients/${client.id}`,
      };
    }),
  );
  return recipients.length;
}
