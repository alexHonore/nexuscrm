import { and, eq, isNull, like, or } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { assistants, consents, conversations, messages, smsNumbers, suppressions } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { normalizePhone, phoneMatchKey } from "@/lib/phone";
import { markEnrollmentsReplied, markEnrollmentsStopped } from "@/lib/campaigns-server/inbound";
import { detectOptOut } from "@/lib/sms/optout";
import { analyzeSms } from "@/lib/sms/segments";
import { isValidTwilioSignature, publicWebhookUrl } from "@/lib/sms-server/twilio-signature";
import { enqueueJob } from "@/lib/jobs/queue";
import { notifyHumans } from "@/lib/sms-server/notify";
import { kickDispatch } from "@/lib/jobs/kick";

/**
 * POST /api/webhooks/twilio/inbound — SMS entrant appelé PAR LES SERVEURS
 * TWILIO (jamais par notre front). Configuré comme « Inbound Request URL » du
 * Messaging Service (application/x-www-form-urlencoded).
 *
 * Ordre imposé : l'opt-out (STOP/ARRÊT…) est traité AVANT tout le reste — la
 * suppression est par numéro et doit tenir même sans fiche client. Ensuite :
 * correspondance client par les 10 derniers chiffres (jamais de création
 * automatique), ligne SMS auto-enregistrée si le DID est inconnu (un texto
 * entrant ne doit pas être perdu), conversation upsertée et marquée « à
 * traiter », rangée `messages` idempotente sur MessageSid (Twilio relivre
 * parfois), et notification humaine — les phases IA n'existent pas encore.
 *
 * Pas d'apiUser ici (requête serveur-à-serveur) : l'authenticité est vérifiée
 * via la signature X-Twilio-Signature. Toutes les écritures sont idempotentes ;
 * une vraie erreur BD remonte en 500 exprès pour que Twilio retente.
 */

/** Fenetre de debounce d'une rafale de SMS entrants. */
const AGENT_TURN_DEBOUNCE_MS = 10_000;

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

  const valid = isValidTwilioSignature({
    url: publicWebhookUrl("/api/webhooks/twilio/inbound", req.nextUrl.search),
    params,
    signature: req.headers.get("x-twilio-signature"),
    authToken: process.env.TWILIO_AUTH_TOKEN,
    isProduction: process.env.NODE_ENV === "production",
  });
  if (!valid) {
    // Une signature invalide est le plus souvent une URL mal configurée chez
    // Twilio (NEXT_PUBLIC_APP_URL ≠ l'URL appelée) : chaque STOP, chaque
    // réponse serait rejetée en silence. On le journalise pour que la page de
    // mise en service et l'audit le montrent.
    await logAudit({
      userId: null,
      action: "sms.webhook_invalid_signature",
      entity: "message",
      detail: { path: "/api/webhooks/twilio/inbound", hasToken: Boolean(process.env.TWILIO_AUTH_TOKEN) },
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "sms.webhook_invalid_signature" }));
    return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
  }

  const parsed = inboundSchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { MessageSid, From, To, Body } = parsed.data;

  const from = normalizePhone(From);
  const to = normalizePhone(To);
  // Numéros inexploitables : on trace et on répond 200 quand même — un statut
  // d'erreur ferait retenter Twilio avec la même charge inutilisable.
  if (!from || !to) {
    await logAudit({
      userId: null,
      action: "sms.inbound_invalid",
      entity: "message",
      detail: { messageSid: MessageSid },
    });
    return twiml();
  }

  const now = new Date();

  // ── Opt-out AVANT tout : la suppression est par numéro, elle vaut même sans
  // fiche client et doit survivre à toute erreur plus bas. ──
  const optOut = detectOptOut(Body);
  if (optOut.optOut) {
    await db
      .insert(suppressions)
      .values({ phoneE164: from, reason: "sms_stop", note: optOut.keyword })
      .onConflictDoNothing();
  }

  // ── Correspondance client (10 derniers chiffres, principal ET secondaire) —
  // jamais de création automatique depuis un SMS entrant. ──
  const matchKey = phoneMatchKey(from);
  const client = matchKey
    ? await db.query.clients.findFirst({
        where: or(like(clients.phone, `%${matchKey}`), like(clients.phoneAlt, `%${matchKey}`)),
        columns: { id: true, fullName: true, assignedToId: true },
      })
    : undefined;
  if (!client) {
    await logAudit({
      userId: null,
      action: "sms.inbound_unmatched",
      entity: "message",
      detail: {
        from: `…${from.slice(-4)}`,
        messageSid: MessageSid,
        ...(optOut.optOut ? { optOut: true } : {}),
      },
    });
    return twiml();
  }

  if (optOut.optOut) {
    await db
      .update(consents)
      .set({ revokedAt: now })
      .where(
        and(eq(consents.clientId, client.id), eq(consents.channel, "sms"), isNull(consents.revokedAt)),
      );
    await logAudit({
      userId: null,
      action: "sms.optout",
      entity: "client",
      entityId: client.id,
      detail: { keyword: optOut.keyword, messageSid: MessageSid },
    });
  }

  // ── Ligne SMS destinataire — auto-enregistrée si le DID est inconnu : un
  // texto entrant vers un numéro non répertorié ne doit pas être perdu. ──
  let smsNumber = await db.query.smsNumbers.findFirst({
    where: eq(smsNumbers.e164, to),
    columns: { id: true },
  });
  if (!smsNumber) {
    const [inserted] = await db
      .insert(smsNumbers)
      .values({
        e164: to,
        label: "auto (webhook entrant)",
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID ?? "",
      })
      .onConflictDoNothing()
      .returning({ id: smsNumbers.id });
    smsNumber =
      inserted ??
      (await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.e164, to), columns: { id: true } }));
  }
  if (!smsNumber) throw new Error(`sms_numbers upsert failed for ${to}`);

  // ── Conversation upsertée sur (clientPhone, smsNumberId), puis marquée « à
  // traiter » — un humain doit voir ce texto tant que les phases IA n'existent pas. ──
  await db
    .insert(conversations)
    .values({ clientId: client.id, clientPhone: from, smsNumberId: smsNumber.id })
    .onConflictDoNothing();
  let conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.clientPhone, from), eq(conversations.smsNumberId, smsNumber.id)),
  });
  if (!conversation) throw new Error(`conversations upsert failed for ${MessageSid}`);

  // Fil sans assistant : le numéro peut en désigner un par défaut. Sans ça,
  // quelqu'un qui écrit au numéro de lui-même n'avait jamais de réponse IA —
  // seul un barreau de campagne savait confier un fil.
  if (conversation.activeAssistantId === null && !optOut.optOut) {
    const numberRow = await db.query.smsNumbers.findFirst({
      where: eq(smsNumbers.id, smsNumber.id),
      columns: { defaultAssistantId: true },
    });
    if (numberRow?.defaultAssistantId) {
      const candidate = await db.query.assistants.findFirst({
        where: eq(assistants.id, numberRow.defaultAssistantId),
        columns: { id: true, status: true, compiledPrompt: true, version: true },
      });
      if (candidate && candidate.status === "active" && candidate.compiledPrompt) {
        await db
          .update(conversations)
          .set({ activeAssistantId: candidate.id, activeAssistantVersion: candidate.version })
          .where(and(eq(conversations.id, conversation.id), isNull(conversations.activeAssistantId)));
        conversation = { ...conversation, activeAssistantId: candidate.id };
      }
    }
  }

  // ── Rangée du message — idempotente sur MessageSid : une relivraison Twilio
  // produit exactement UNE rangée (et aucune seconde notification). ──
  const analysis = analyzeSms(Body);
  const inserted = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      direction: "in",
      body: Body,
      twilioSid: MessageSid,
      status: "received",
      source: "human",
      segments: analysis.segments,
      encoding: analysis.encoding,
    })
    .onConflictDoNothing({ target: messages.twilioSid })
    .returning({ id: messages.id });

  if (inserted.length > 0) {
    // Marquage « à traiter » seulement quand la rangée est nouvelle : une
    // relivraison Twilio ne doit pas re-signaler une conversation qu'un humain
    // vient de traiter.
    await db
      .update(conversations)
      .set({
        lastInboundAt: now,
        needsAttention: true,
        attentionReason: optOut.optOut ? "optout" : "inbound",
        // Un STOP met aussi l'IA en pause sur ce fil : aucun tour ne doit
        // plus s'y déclencher, et le fil le dit.
        ...(optOut.optOut ? { aiEnabled: false, pauseReason: "optout" } : {}),
      })
      .where(eq(conversations.id, conversation.id));

    // Les inscriptions de campagne sont réglées TOUT DE SUITE, pas au prochain
    // barreau. Une échelle qui se termine avant que la personne réponde
    // resterait « completed » et sa réponse ne compterait dans aucune variante :
    // le taux de réponse d'un test A/B serait sous-estimé exactement là où on
    // compare. Un désabonnement, lui, arrête TOUTES ses inscriptions — le refus
    // porte sur le numéro, pas sur une campagne.
    if (optOut.optOut) {
      await markEnrollmentsStopped(client.id, now);
    } else {
      await markEnrollmentsReplied(conversation.id, now);
    }

    // Les humains sont prévenus quand c'est À EUX de répondre : pas
    // d'assistant, IA en pause, ou désabonnement. Quand l'assistant va
    // répondre, c'est lui qui prévient en cas de passage à l'humain, de
    // blocage ou de panne — sinon chaque texto réveillait tout le monde pour
    // rien et l'inbox ne voulait plus rien dire.
    const aiWillHandle =
      !optOut.optOut && conversation.aiEnabled && conversation.activeAssistantId !== null;
    if (!aiWillHandle) {
      await notifyHumans({
        conversationId: conversation.id,
        clientId: client.id,
        kind: optOut.optOut ? "stopped" : "inbound",
        reason: optOut.optOut ? "désabonnement" : "",
      });
    }

    // -- Tour d'agent, debounce --------------------------------------------
    // La cle de dedoublonnage `turn:<conversation>` fait que trois SMS en
    // quatre secondes REPOUSSENT le meme job au lieu d'en creer trois : une
    // rafale = une seule reponse. Les 10 s laissent le temps a la suite d'une
    // pensee d'arriver. Un fil mis en pause par un humain n'en programme pas :
    // le runtime sortirait de toute facon, autant ne pas creer le job.
    if (!optOut.optOut && conversation.aiEnabled && conversation.activeAssistantId) {
      await enqueueJob({
        type: "agent_turn",
        runAt: new Date(now.getTime() + AGENT_TURN_DEBOUNCE_MS),
        payload: { conversationId: conversation.id },
        dedupeKey: `turn:${conversation.id}`,
      });
      // Chemin rapide : le tour part des la reponse envoyee, sans attendre le
      // cron de la minute (qui reste le filet de securite).
      kickDispatch();
    }
  }

  return twiml();
}
