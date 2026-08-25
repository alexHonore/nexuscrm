import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { logAudit } from "@/lib/audit";

/**
 * Rejet de signature Twilio — journalisation PARTAGÉE des deux webhooks
 * (entrant et statut). Avant, seul l'entrant journalisait : un rappel de
 * statut rejeté était invisible, et 44 messages sont restés « En file » des
 * jours sans qu'aucune trace ne le dise.
 */

/**
 * Une signature invalide est journalisée dans l'audit au plus une fois par
 * fenêtre : la route est publique, et sans cette borne n'importe qui pouvait
 * faire grossir `audit_logs` d'une rangée par requête anonyme.
 */
const INVALID_SIGNATURE_AUDIT_WINDOW_MS = 10 * 60_000;
export const INVALID_SIGNATURE_ACTION = "sms.webhook_invalid_signature";

/**
 * Journalise un rejet (audit borné + ligne JSON systématique). `candidates`
 * porte les URL que NOUS avons essayées — ce sont nos propres adresses, pas un
 * secret : c'est ce qui permet de trancher « URL mal reconstruite » (une
 * candidate ressemble à la config Twilio mais diffère) de « jeton erroné »
 * (les candidates sont exactement l'URL configurée et ça échoue quand même).
 * Un pépin BD sur la lecture ne change rien : l'appelant répond 403 quoi
 * qu'il arrive.
 */
export async function auditInvalidSignature(path: string, candidates: string[]): Promise<void> {
  let recentlyAudited = false;
  try {
    recentlyAudited = Boolean(
      await db.query.auditLogs.findFirst({
        // Fenêtre PAR ROUTE : pendant une panne de jeton, les rejets entrants
        // pleuvent — sans ce filtre, le webhook de statut n'aurait jamais sa
        // rangée et l'audit ne montrerait qu'une moitié du problème.
        where: and(
          eq(auditLogs.action, INVALID_SIGNATURE_ACTION),
          sql`${auditLogs.detail}->>'path' = ${path}`,
          gt(auditLogs.createdAt, new Date(Date.now() - INVALID_SIGNATURE_AUDIT_WINDOW_MS)),
        ),
        columns: { id: true },
      }),
    );
  } catch {
    recentlyAudited = true;
  }
  if (!recentlyAudited) {
    await logAudit({
      userId: null,
      action: INVALID_SIGNATURE_ACTION,
      entity: "message",
      detail: {
        path,
        hasToken: Boolean(process.env.TWILIO_AUTH_TOKEN),
        candidates,
      },
    });
  }
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: INVALID_SIGNATURE_ACTION, path }),
  );
}
