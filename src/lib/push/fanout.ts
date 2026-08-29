import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@/db";
import { clients, notifications, users } from "@/db/schema";
import { pushSubscriptions, userReach } from "@/db/schema-push";
import { bucketFor, grantsFor, roleForUser } from "@/lib/permissions/access";
import { getSetting } from "@/lib/settings";
import { loadVapidKeys } from "./keys";
import { buildPushPayload, pushOptionsFor, serializePushPayload } from "./payload";
import { shouldPush, topicOf, type ReachPrefs } from "./policy";
import { sendPush } from "./send";

/**
 * L'envoi vers les téléphones — la moitié invisible de la cloche.
 *
 * Trois choses se décident ici, et aucune ne peut être déléguée au client :
 *
 * 1. **La visibilité, re-vérifiée pour le DESTINATAIRE.** Une notification est
 *    du texte qui SURVIT : « Marie Tremblay (418 555-1234) vous a rappelé »
 *    reste écrit le jour où la fiche change de mains. L'écran /notifications le
 *    sait déjà et tait ces lignes ; un écran verrouillé n'a aucun filtre. Sans
 *    ce nouveau contrôle, la poussée deviendrait la fuite que cet écran a été
 *    écrit pour empêcher (règle 1).
 * 2. **Le compte est arrêté.** Un compte désactivé ou dont la session a été
 *    révoquée garde ses abonnements : le téléphone d'un ex-employé continuerait
 *    d'annoncer des noms de clients.
 * 3. **Les heures de silence de la PERSONNE**, distinctes de celles des envois
 *    SMS aux clients.
 *
 * Le travail est fait APRÈS la réponse (`runAfterResponse` chez l'appelant) :
 * chaque envoi est un aller-retour réseau vers APNs, FCM ou Mozilla, et Twilio
 * abandonne un webhook qu'on fait attendre.
 */

const TZ = "America/Toronto";

/** Minutes écoulées depuis minuit, à Toronto — le fuseau d'affichage (règle 9). */
function minutesOfDayToronto(at: Date): number {
  const [h, m] = formatInTimeZone(at, TZ, "HH:mm").split(":");
  return Number(h) * 60 + Number(m);
}

const CLIENT_LINK = /^\/clients\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

/** Envois simultanés — la même valeur que `sendPushBatch`, pour la même raison. */
const PUSH_LANES = 6;

/**
 * Un pool à voies fixes qui rend les verdicts DANS L'ORDRE D'ENTRÉE : c'est par
 * l'index qu'on recolle chaque verdict à sa ligne d'abonnement, et se fier à
 * l'ordre d'arrivée des réponses supprimerait les abonnements de quelqu'un
 * d'autre.
 */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  lanes: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, items.length)) }, worker));
  return out;
}

export type PushableRow = {
  id?: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
};

export type FanoutReport = {
  considered: number;
  sent: number;
  skipped: Record<string, number>;
  pruned: number;
};

function bump(counter: Record<string, number>, key: string, by = 1): void {
  counter[key] = (counter[key] ?? 0) + by;
}

/**
 * Pousse un lot de notifications déjà écrites en base.
 *
 * Ne lève JAMAIS : la cloche a déjà reçu sa ligne, et une panne du service de
 * push ne doit pas défaire une assignation ni faire échouer un webhook.
 */
export async function fanoutPush(rows: PushableRow[], at: Date = new Date()): Promise<FanoutReport> {
  const report: FanoutReport = { considered: rows.length, sent: 0, skipped: {}, pruned: 0 };
  if (rows.length === 0) return report;

  const keys = loadVapidKeys();
  if (!keys) {
    // Pas de clés VAPID : l'application marche, elle ne pousse pas. On le dit
    // une fois, sans bruit, plutôt que de laisser croire à un envoi.
    bump(report.skipped, "not_configured", rows.length);
    return report;
  }

  const userIds = [...new Set(rows.map((r) => r.userId))];

  const [recipients, subs, reaches, cfg] = await Promise.all([
    db
      .select({ id: users.id, role: users.role, isActive: users.isActive })
      .from(users)
      .where(inArray(users.id, userIds)),
    db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds)),
    db.select().from(userReach).where(inArray(userReach.userId, userIds)),
    getSetting("permissions"),
  ]);

  const subsByUser = new Map<string, typeof subs>();
  for (const sub of subs) {
    const list = subsByUser.get(sub.userId) ?? [];
    list.push(sub);
    subsByUser.set(sub.userId, list);
  }
  const reachByUser = new Map(reaches.map((r) => [r.userId, r]));
  const userById = new Map(recipients.map((u) => [u.id, u]));

  // Le rôle EFFECTIF de chaque personne, et la répartition par rôle : ce sont
  // les deux entrées de `bucketFor`. On les calcule une fois pour le lot —
  // `loadDirectory()` est mis en cache par REQUÊTE, et il n'y a pas de requête
  // ici (cron, webhook, travail d'après-réponse).
  const allUsers = await db.select({ id: users.id, role: users.role }).from(users);
  const roleOf = new Map(allUsers.map((u) => [u.id, roleForUser(cfg, u)]));

  // Les fiches désignées par les liens, réduites aux colonnes qui décident.
  const clientIds = [
    ...new Set(rows.map((r) => r.link?.match(CLIENT_LINK)?.[1]).filter((v): v is string => !!v)),
  ];
  const clientRefs = clientIds.length
    ? await db
        .select({
          id: clients.id,
          assignedToId: clients.assignedToId,
          lastContactedAt: clients.lastContactedAt,
          updatedAt: clients.updatedAt,
        })
        .from(clients)
        .where(inArray(clients.id, clientIds))
    : [];
  const clientById = new Map(clientRefs.map((c) => [c.id, c]));

  const minutes = minutesOfDayToronto(at);
  const gone = new Set<string>();
  const jobs: { sub: (typeof subs)[number]; body: string; type: string; tag: string }[] = [];

  for (const row of rows) {
    const user = userById.get(row.userId);
    if (!user || !user.isActive) {
      bump(report.skipped, "inactive_user");
      continue;
    }

    const reach = reachByUser.get(row.userId);
    const prefs: ReachPrefs | null = reach
      ? {
          pushPrefs: (reach.pushPrefs as Record<string, boolean> | null) ?? null,
          quietFrom: reach.quietFrom,
          quietTo: reach.quietTo,
          quietBypassUrgent: reach.quietBypassUrgent,
        }
      : null;

    const verdict = shouldPush(row.type, prefs, minutes);
    if (!verdict.push) {
      bump(report.skipped, verdict.reason);
      continue;
    }

    // La fiche liée est-elle ENCORE à portée de ce destinataire ?
    const clientId = row.link?.match(CLIENT_LINK)?.[1];
    if (clientId) {
      const ref = clientById.get(clientId);
      // Une fiche supprimée fait disparaître sa poussée : mieux vaut ne rien
      // envoyer qu'envoyer vers un lien mort.
      if (!ref) {
        bump(report.skipped, "client_gone");
        continue;
      }
      const role = roleOf.get(row.userId);
      if (!role) {
        bump(report.skipped, "no_role");
        continue;
      }
      const bucket = bucketFor(row.userId, ref, ref.assignedToId ? (roleOf.get(ref.assignedToId) ?? null) : null);
      if (!grantsFor(cfg, role, bucket).visible) {
        bump(report.skipped, "not_visible");
        continue;
      }
    }

    const devices = subsByUser.get(row.userId) ?? [];
    if (devices.length === 0) {
      bump(report.skipped, "no_device");
      continue;
    }

    const payload = buildPushPayload(row);
    const body = serializePushPayload(payload);
    for (const sub of devices) {
      jobs.push({ sub, body, type: row.type, tag: payload.tag });
    }
  }

  if (jobs.length === 0) return report;

  // `sendPushBatch` diffuse UN message à plusieurs appareils ; ici chaque
  // travail porte le sien (des notifications différentes, parfois pour des
  // personnes différentes). On garde donc la même discipline — six voies, un
  // verdict par travail, dans l'ordre — mais autour de `sendPush`.
  const results = await runWithConcurrency(jobs, PUSH_LANES, async (job) => {
    const { ttl, urgency } = pushOptionsFor(job.type);
    return sendPush({
      subscription: { endpoint: job.sub.endpoint, keys: { p256dh: job.sub.p256dh, auth: job.sub.auth } },
      payload: job.body,
      ttl,
      urgency,
      topic: topicOf(job.tag),
      keys,
    });
  });

  const succeeded: string[] = [];
  for (const [index, result] of results.entries()) {
    const sub = jobs[index].sub;
    if (result.ok) {
      report.sent += 1;
      succeeded.push(sub.id);
      continue;
    }
    if ("gone" in result && result.gone) {
      // 404/410 : le service de push dit que cet appareil n'existe plus. La
      // ligne part immédiatement — la garder ferait re-tenter à chaque
      // notification, pour toujours, sur un téléphone effacé.
      gone.add(sub.id);
      continue;
    }
    bump(report.skipped, "send_failed");
    await db
      .update(pushSubscriptions)
      .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1`, lastFailureAt: at })
      .where(eq(pushSubscriptions.id, sub.id))
      .catch(() => undefined);
  }

  if (gone.size > 0) {
    await db
      .delete(pushSubscriptions)
      .where(inArray(pushSubscriptions.id, [...gone]))
      .catch(() => undefined);
    report.pruned = gone.size;
  }
  if (succeeded.length > 0) {
    await db
      .update(pushSubscriptions)
      .set({ lastSuccessAt: at, failureCount: 0, lastSeenAt: at })
      .where(inArray(pushSubscriptions.id, [...new Set(succeeded)]))
      .catch(() => undefined);
  }

  return report;
}

/** Le nombre non lu d'une personne — ce que l'icône de l'application affiche. */
export async function unreadCountFor(userId: string): Promise<number> {
  return db.$count(
    notifications,
    and(eq(notifications.userId, userId), isNull(notifications.readAt)),
  );
}
