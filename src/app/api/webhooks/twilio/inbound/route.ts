import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { processInboundSms } from "@/lib/sms-server/inbound";
import {
  isValidTwilioSignatureAnyUrl,
  webhookUrlCandidates,
} from "@/lib/sms-server/twilio-signature";
import { auditInvalidSignature } from "@/lib/sms-server/webhook-guard";
import { kickDispatch } from "@/lib/jobs/kick";

/**
 * POST /api/webhooks/twilio/inbound — SMS entrant appelé PAR LES SERVEURS
 * TWILIO (jamais par notre front). Configuré comme « Inbound Request URL » du
 * Messaging Service (application/x-www-form-urlencoded).
 *
 * La route ne fait que l'HTTP : signature (multi-URL — voir
 * webhookUrlCandidates), validation du corps, traduction du résultat en
 * réponse. Tout le traitement vit dans processInboundSms
 * (src/lib/sms-server/inbound.ts), partagé avec la réconciliation REST qui
 * rejoue les messages perdus pendant une panne de webhook.
 *
 * Pas d'apiUser ici (requête serveur-à-serveur) : l'authenticité est vérifiée
 * via la signature X-Twilio-Signature. Une vraie erreur BD remonte en 500
 * exprès pour que Twilio retente.
 */

const inboundSchema = z.object({
  MessageSid: z.string().min(1),
  From: z.string().min(1),
  To: z.string().min(1),
  // Twilio peut envoyer un corps vide (MMS sans texte).
  Body: z.string().default(""),
});

/** Réponse TwiML vide : accusé de réception, aucune auto-réponse. */
function twiml(): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const params = new URLSearchParams(raw);

  const candidates = webhookUrlCandidates({
    path: "/api/webhooks/twilio/inbound",
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
    // Chaque STOP, chaque réponse serait rejetée en silence : on journalise
    // (audit borné) avec les URL essayées — c'est ce qui permet de trancher
    // « URL mal configurée » de « jeton erroné ». 403 quoi qu'il arrive.
    await auditInvalidSignature("/api/webhooks/twilio/inbound", candidates);
    return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
  }

  const parsed = inboundSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { MessageSid, From, To, Body } = parsed.data;

  const result = await processInboundSms({
    messageSid: MessageSid,
    from: From,
    to: To,
    body: Body,
  });

  // Chemin rapide : le tour part des la reponse envoyee, sans attendre le
  // cron de la minute (qui reste le filet de securite).
  if (result.outcome === "processed" && result.agentTurnQueued) kickDispatch();

  // Numéros inexploitables ou fiche introuvable : 200 quand même — un statut
  // d'erreur ferait retenter Twilio avec la même charge inutilisable.
  return twiml();
}
