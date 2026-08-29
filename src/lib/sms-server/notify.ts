import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients, users } from "@/db/schema";
import { conversations } from "@/db/schema-sms";
import { notificationContent } from "@/components/clients/notification-content";
import { createNotifications } from "@/lib/notify";
import { bucketFor, can, grantsFor, roleForUser } from "@/lib/permissions/access";
import { getSetting } from "@/lib/settings";

export type HumanAlertKind = "inbound" | "handoff" | "blocked" | "error" | "stopped" | "closed";

const KEYS: Record<HumanAlertKind, { title: "smsInboundTitle" | "smsHandoffTitle" | "smsBlockedTitle" | "smsErrorTitle" | "smsStoppedTitle" | "smsClosedTitle"; body: "smsInboundBody" | "smsHandoffBody" | "smsBlockedBody" | "smsErrorBody" | "smsStoppedBody" | "smsClosedBody" }> = {
  inbound: { title: "smsInboundTitle", body: "smsInboundBody" },
  handoff: { title: "smsHandoffTitle", body: "smsHandoffBody" },
  blocked: { title: "smsBlockedTitle", body: "smsBlockedBody" },
  error: { title: "smsErrorTitle", body: "smsErrorBody" },
  stopped: { title: "smsStoppedTitle", body: "smsStoppedBody" },
  closed: { title: "smsClosedTitle", body: "smsClosedBody" },
};

type Recipient = { id: string; locale: string };

/**
 * Qui prévenir quand personne ne tient le fil.
 *
 * C'était « tous les comptes `users.role = "admin"` ». Depuis que les rôles se
 * règlent (`src/lib/permissions/`), cette phrase ne dit plus ce qu'elle
 * disait : `users.role` n'est que le PLANCHER — administrateur, ou pas. Un
 * « Superviseur » fabriqué par le courtier est stocké `caller`, donc absent de
 * ce `where` ; la boîte de réception qu'on venait de lui confier se remplissait
 * en silence, et seul le courtier voyait passer les fils sans maître. Une
 * notification qui n'arrive pas ne casse rien : elle ne sonne simplement
 * jamais, et personne ne s'aperçoit qu'elle manque.
 *
 * La question se pose donc là où vit la réponse : qui détient
 * `conversations.view` d'après son rôle EFFECTIF ? Puis, parmi eux, qui voit la
 * FICHE. Un fil PARLE d'une fiche, la notification pointe sur elle : réveiller
 * quelqu'un pour un client dont la fiche lui répondra « introuvable » est pire
 * que de ne pas le réveiller du tout.
 *
 * L'annuaire est lu EN ENTIER, comptes désactivés compris : le détenteur d'une
 * fiche peut avoir été désactivé ce matin, et c'est son rôle à lui qui décide
 * du compartiment des autres. Rien n'est mis en cache par la requête ici —
 * ce chemin tourne sous un webhook Twilio et dans le moteur d'agent, où il n'y
 * a pas de requête à qui accrocher un cache.
 */
async function watchers(client: { assignedToId: string | null }): Promise<Recipient[]> {
  const [cfg, staff] = await Promise.all([
    getSetting("permissions"),
    db
      .select({ id: users.id, role: users.role, locale: users.locale, isActive: users.isActive })
      .from(users),
  ]);

  const roleOf = new Map(staff.map((u) => [u.id, roleForUser(cfg, u)]));
  const holder = client.assignedToId ? (roleOf.get(client.assignedToId) ?? null) : null;

  const chosen = staff.filter((u) => {
    if (!u.isActive) return false;
    const role = roleOf.get(u.id);
    if (!role || !can(role, "conversations.view")) return false;
    return grantsFor(cfg, role, bucketFor(u.id, client, holder)).visible;
  });
  if (chosen.length > 0) return chosen;

  // Le repli d'avant, gardé pour ce qu'il est : un filet. Dans une
  // configuration réparée il ne se déclenche jamais — le rôle administrateur
  // est `superAdmin`, il passe tous les droits et toutes les cases, donc il est
  // déjà au-dessus. Il reste écrit parce qu'on préfère réveiller le courtier
  // pour rien plutôt que laisser un fil attendre qu'on passe par hasard.
  return staff.filter((u) => u.isActive && u.role === "admin");
}

/**
 * Prévient les humains qu'un fil SMS a besoin d'eux.
 *
 * Destinataires : l'assigné de la conversation, sinon celui de la fiche, sinon
 * ceux à qui la maison a confié les conversations (voir `watchers`) — chacun
 * dans SA langue. Une seule fonction pour le webhook entrant ET le moteur
 * d'agent : avant elle, seul « Nouveau texto » existait, et un passage à
 * l'humain, un garde-fou bloquant ou une panne de modèle ne prévenaient
 * personne — le fil attendait dans l'inbox que quelqu'un passe par hasard.
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
  let recipients: Recipient[] = [];
  if (assigneeId) {
    const assignee = await db.query.users.findFirst({
      where: and(eq(users.id, assigneeId), eq(users.isActive, true)),
      columns: { id: true, locale: true },
    });
    if (assignee) recipients = [assignee];
  }
  if (recipients.length === 0) {
    recipients = await watchers(client);
  }
  if (recipients.length === 0) return 0;

  const keys = KEYS[input.kind];
  await createNotifications(
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
