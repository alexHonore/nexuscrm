import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messages, suppressions } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { HARD_FAILURE_CODES, rankOf } from "@/lib/sms/status";

/**
 * Report d'un état de livraison Twilio sur la rangée `messages` — chemin
 * d'écriture UNIQUE, utilisé par le webhook de statut ET par la
 * réconciliation REST. Les deux sources appliquent la même règle de
 * non-régression (rang de statut) et le même traitement des échecs
 * définitifs du transporteur (suppression du numéro).
 */

export interface DeliveryOutcomeInput {
  /** MessageSid Twilio (SM…). */
  sid: string;
  /** MessageStatus Twilio (queued / sent / delivered / undelivered / failed…). */
  status: string;
  /** ErrorCode Twilio — undefined quand il n'y a pas d'erreur. */
  errorCode?: number | null;
  /** Destinataire — sert uniquement à la suppression sur échec définitif. */
  to?: string | null;
}

export interface DeliveryOutcomeResult {
  /** La rangée `messages` correspondant au sid existe-t-elle ? */
  found: boolean;
  /** Le statut de la rangée a-t-il réellement avancé ? */
  advanced: boolean;
}

/**
 * Toutes les écritures sont idempotentes — Twilio relivre parfois le même
 * rappel, et la réconciliation repasse sur les mêmes rangées.
 */
export async function recordDeliveryOutcome(input: DeliveryOutcomeInput): Promise<DeliveryOutcomeResult> {
  const { sid, status, to } = input;
  const errorCode = input.errorCode ?? undefined;

  const existing = await db.query.messages.findFirst({
    where: eq(messages.twilioSid, sid),
    columns: { id: true, status: true, errorCode: true },
  });

  let advanced = false;
  if (existing) {
    const next = rankOf(status) >= rankOf(existing.status) ? status : existing.status;
    advanced = next !== existing.status;
    await db
      .update(messages)
      .set({
        // Jamais de régression de statut ; un code d'erreur consigné n'est
        // jamais remis à null par un rappel tardif sans erreur.
        status: next,
        errorCode: errorCode ?? existing.errorCode,
      })
      .where(eq(messages.id, existing.id));
  }

  if (errorCode !== undefined && HARD_FAILURE_CODES.has(errorCode)) {
    const phoneE164 = normalizePhone(to);
    if (phoneE164) {
      await db
        .insert(suppressions)
        .values({ phoneE164, reason: "carrier_error", note: `code ${errorCode}` })
        .onConflictDoNothing();
      await logAudit({
        action: "sms.carrier_suppression",
        entity: "suppression",
        // Masqué : audit_logs n'a pas de chemin de purge ; le numéro complet
        // vit dans la rangée suppressions, qui est la référence.
        entityId: `…${phoneE164.slice(-4)}`,
        detail: { messageSid: sid, errorCode },
      });
    }
  }

  return { found: Boolean(existing), advanced };
}
