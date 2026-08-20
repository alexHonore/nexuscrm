import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { messages, suppressions } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { normalizePhone } from "@/lib/phone";
import { isValidTwilioSignature, publicWebhookUrl } from "@/lib/sms-server/twilio-signature";

/**
 * POST /api/webhooks/twilio/status — rappel de statut de livraison SMS appelé
 * PAR LES SERVEURS TWILIO (jamais par notre front). Configuré comme « Status
 * Callback URL » du Messaging Service.
 *
 * À chaque transition (queued → sent → delivered / undelivered / failed),
 * Twilio poste MessageSid + MessageStatus (+ ErrorCode en cas d'échec) : on
 * reporte l'état sur la rangée `messages` correspondante. Un code d'échec
 * PERMANENT côté transporteur (injoignable, combiné inconnu, ligne fixe)
 * ajoute le numéro aux suppressions — plus rien ne lui sera envoyé.
 *
 * Pas d'apiUser ici (requête serveur-à-serveur) : l'authenticité est vérifiée
 * via la signature X-Twilio-Signature. Toutes les écritures sont idempotentes —
 * Twilio relivre parfois le même rappel, et on répond 200 même pour un sid
 * inconnu, sinon il réessaierait sans fin.
 */

/**
 * Codes d'erreur Twilio d'échec DÉFINITIF du transporteur : 30003 (injoignable/
 * hors service), 30005 (numéro inconnu), 30006 (ligne fixe ou injoignable par
 * SMS). Les codes transitoires (30008…) ne suppriment rien.
 */
const HARD_FAILURE_CODES = new Set([30003, 30005, 30006]);

const statusSchema = z.object({
  MessageSid: z.string().min(1),
  MessageStatus: z.string().min(1),
  // Twilio l'envoie en chaîne ("30003") et seulement en cas d'échec. Chaîne
  // vide ou "0" = pas d'erreur (Number("") === 0, il faut le neutraliser).
  ErrorCode: z.preprocess(
    (v) => (v === "" || v === "0" || v === undefined ? undefined : v),
    z.coerce.number().int().optional(),
  ),
  To: z.string().optional(),
});

/**
 * Les rappels Twilio peuvent arriver en désordre ou en double : un « sent »
 * tardif ne doit jamais écraser un « undelivered » déjà consigné — le registre
 * des messages est une pièce de conformité. Rang croissant = plus définitif.
 */
const STATUS_RANK: Record<string, number> = {
  accepted: 1,
  queued: 1,
  scheduled: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
  canceled: 4,
};
const rankOf = (status: string | null): number => STATUS_RANK[status ?? ""] ?? 0;

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const params = new URLSearchParams(raw);

  const valid = isValidTwilioSignature({
    url: publicWebhookUrl("/api/webhooks/twilio/status", req.nextUrl.search),
    params,
    signature: req.headers.get("x-twilio-signature"),
    authToken: process.env.TWILIO_AUTH_TOKEN,
    isProduction: process.env.NODE_ENV === "production",
  });
  if (!valid) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
  }

  const parsed = statusSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { MessageSid, MessageStatus, ErrorCode, To } = parsed.data;

  const existing = await db.query.messages.findFirst({
    where: eq(messages.twilioSid, MessageSid),
    columns: { id: true, status: true, errorCode: true },
  });

  if (existing) {
    await db
      .update(messages)
      .set({
        // Jamais de régression de statut ; un code d'erreur consigné n'est
        // jamais remis à null par un rappel tardif sans erreur.
        status: rankOf(MessageStatus) >= rankOf(existing.status) ? MessageStatus : existing.status,
        errorCode: ErrorCode ?? existing.errorCode,
      })
      .where(eq(messages.id, existing.id));
  }

  // Sid inconnu (message purgé, environnement croisé…) : on trace et on répond
  // 200 quand même — un statut d'erreur ferait retenter Twilio indéfiniment.
  if (!existing) {
    await logAudit({
      action: "sms.status_unknown_sid",
      entity: "message",
      detail: {
        messageSid: MessageSid,
        messageStatus: MessageStatus,
        errorCode: ErrorCode ?? null,
      },
    });
  }

  if (ErrorCode !== undefined && HARD_FAILURE_CODES.has(ErrorCode)) {
    const phoneE164 = normalizePhone(To);
    if (phoneE164) {
      await db
        .insert(suppressions)
        .values({ phoneE164, reason: "carrier_error", note: `code ${ErrorCode}` })
        .onConflictDoNothing();
      await logAudit({
        action: "sms.carrier_suppression",
        entity: "suppression",
        // Masqué : audit_logs n'a pas de chemin de purge ; le numéro complet
        // vit dans la rangée suppressions, qui est la référence.
        entityId: `…${phoneE164.slice(-4)}`,
        detail: { messageSid: MessageSid, errorCode: ErrorCode },
      });
      // Les inscriptions de campagne seront clôturées en phase 6 (table à venir) ;
      // la suppression garantit déjà qu'aucun envoi ne partira vers ce numéro.
    }
  }

  return NextResponse.json({ ok: true });
}
