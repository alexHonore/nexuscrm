import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { recordDeliveryOutcome } from "@/lib/sms-server/delivery";
import {
  isValidTwilioSignatureAnyUrl,
  webhookUrlCandidates,
} from "@/lib/sms-server/twilio-signature";
import { auditInvalidSignature } from "@/lib/sms-server/webhook-guard";

/**
 * POST /api/webhooks/twilio/status — rappel de statut de livraison SMS appelé
 * PAR LES SERVEURS TWILIO (jamais par notre front). Configuré comme « Status
 * Callback URL » du Messaging Service.
 *
 * À chaque transition (queued → sent → delivered / undelivered / failed),
 * Twilio poste MessageSid + MessageStatus (+ ErrorCode en cas d'échec) : on
 * reporte l'état sur la rangée `messages` correspondante via
 * recordDeliveryOutcome (chemin d'écriture partagé avec la réconciliation
 * REST — même règle de non-régression, même suppression sur échec définitif
 * du transporteur).
 *
 * Pas d'apiUser ici (requête serveur-à-serveur) : l'authenticité est vérifiée
 * via la signature X-Twilio-Signature. Un rejet est JOURNALISÉ comme sur le
 * webhook entrant — avant, un rappel rejeté était invisible et les messages
 * restaient « En file » sans qu'aucune trace ne le dise. On répond 200 même
 * pour un sid inconnu, sinon Twilio réessaierait sans fin.
 */

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

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const params = new URLSearchParams(raw);

  const candidates = webhookUrlCandidates({
    path: "/api/webhooks/twilio/status",
    search: req.nextUrl.search,
    headers: req.headers,
  });
  const valid = isValidTwilioSignatureAnyUrl({
    urls: candidates,
    params,
    signature: req.headers.get("x-twilio-signature"),
    authToken: process.env.TWILIO_AUTH_TOKEN,
    isProduction: process.env.NODE_ENV === "production",
  });
  if (!valid) {
    await auditInvalidSignature("/api/webhooks/twilio/status", candidates);
    return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
  }

  const parsed = statusSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { MessageSid, MessageStatus, ErrorCode, To } = parsed.data;

  const outcome = await recordDeliveryOutcome({
    sid: MessageSid,
    status: MessageStatus,
    errorCode: ErrorCode,
    to: To,
  });

  // Sid inconnu (message purgé, environnement croisé…) : on trace et on répond
  // 200 quand même — un statut d'erreur ferait retenter Twilio indéfiniment.
  if (!outcome.found) {
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

  return NextResponse.json({ ok: true });
}
