import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema-sms";

/**
 * Le plafond du jour d'un numéro expéditeur — UNE seule lecture.
 *
 * Deux endroits ont besoin de savoir « combien ce numéro a-t-il déjà envoyé
 * aujourd'hui » : l'envoi, qui reporte au lendemain quand le compte est plein
 * (`handleSendSms`), et la relance, qui étale ses départs pour ne jamais
 * l'atteindre (`campaigns-server/reopen.ts`). Deux copies de cette requête
 * finiraient par diverger — sur les statuts comptés, ou sur la définition de
 * « aujourd'hui » — et l'étalement serait alors calculé contre un plafond que
 * l'envoi ne reconnaîtrait plus.
 *
 * « Aujourd'hui » se compte sur la journée LOCALE : un plafond par jour veut
 * dire par jour de Québec. Compter par tranche UTC ferait basculer le compteur
 * à 20 h le soir — au milieu de la plage d'envoi, pas entre deux journées.
 */

const TORONTO = "America/Toronto";

/** Minuit à Toronto, exprimé en UTC. */
export function startOfTorontoDay(now: Date): Date {
  return fromZonedTime(`${formatInTimeZone(now, TORONTO, "yyyy-MM-dd")}T00:00:00`, TORONTO);
}

/** Minuit du LENDEMAIN à Toronto — la date à laquelle le plafond repart entier. */
export function nextTorontoDayStart(now: Date): Date {
  return new Date(startOfTorontoDay(now).getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Statuts qui comptent dans le plafond du jour : tout ce qui a quitté la maison.
 *
 * Exporté parce qu'un troisième lecteur est apparu — le tableau de bord de
 * délivrabilité, qui affiche la marge restante sous le plafond. Un tableau de
 * bord qui compte autrement que l'exécutant est pire qu'aucun tableau de bord :
 * il dit « il reste de la place » pendant que l'envoi reporte au lendemain.
 */
export const COUNTED = ["queued", "sending", "sent", "delivered", "accepted", "undelivered", "failed", "unknown"];

/** Combien ce numéro a-t-il envoyé depuis minuit (heure de Toronto) ? */
export async function outboundCountToday(smsNumberId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.smsNumberId, smsNumberId),
        eq(messages.direction, "out"),
        gte(messages.createdAt, startOfTorontoDay(now)),
        inArray(messages.status, COUNTED),
      ),
    );
  return row?.n ?? 0;
}
