import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { campaignTouches, conversations, messages, smsNumbers } from "@/db/schema-sms";
import { sendSmsPayloadSchema, type JobOutcome, type ScheduledJob } from "@/lib/jobs/types";
import { TwilioSendError } from "@/lib/sms/provider";
import { isWithinSendWindow, nextSendTime } from "@/lib/sms/quiet-hours";
import { resolveQuietHours } from "@/lib/assistants/quiet-hours";
import { analyzeSms } from "@/lib/sms/segments";
import type { SendResult } from "@/lib/sms/types";
import { getSmsProvider } from "@/lib/sms-server";
import { nextTorontoDayStart, outboundCountToday } from "@/lib/sms-server/daily-cap";
import { notifyHumans } from "@/lib/sms-server/notify";

/**
 * Job `send_sms` — UN message sortant, idempotent.
 *
 * Ordre des gardes, volontairement :
 *  1. charge déjà enregistrée pour ce job (reprise) → terminé, rien à refaire ;
 *  2. conversation introuvable → échec définitif ;
 *  3. automatisé + IA en pause → sauté ;
 *  4. automatisé + hors heures de politesse → reporté ;
 *  5. plafond du jour du NUMÉRO atteint → reporté au lendemain matin ;
 *  6. rangée d'intention écrite (messages.job_id unique = garde anti-doublon) ;
 *  7. envoi via le fournisseur ;
 *  8. après acceptation (ou dry_run), les échecs des écritures restantes ne
 *     relancent PAS l'envoi.
 *
 * Ce qui a changé avec la revue : un envoi SAUTÉ ou en ÉCHEC laisse maintenant
 * une rangée visible dans le fil (status + skip_reason) au lieu d'être effacé
 * — « Message mis en file » puis plus rien était la pire réponse possible pour
 * un téléphoniste. Et une exception du transport (délai, réseau) ne supprime
 * plus la rangée : Twilio a peut-être accepté, et la reprise renverrait un
 * doublon. On marque « unknown », on prévient, on n'insiste pas.
 */

export async function handleSendSms(
  job: ScheduledJob,
  now: () => Date = () => new Date(),
): Promise<JobOutcome> {
  const parsed = sendSmsPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { outcome: "failed_permanent", error: "invalid_payload" };
  const payload = parsed.data;

  const already = await db.query.messages.findFirst({
    where: eq(messages.jobId, job.id),
    columns: { id: true, status: true },
  });
  if (already) return { outcome: "done", note: "already_recorded" };

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, payload.conversationId),
  });
  if (!conversation) return { outcome: "failed_permanent", error: "conversation_not_found" };

  // Le « dernier mot » (adieu de clôture) est commis DANS la transaction qui
  // met l'IA en pause : cette garde le supprimait systématiquement. Il passe —
  // le désabonnement (suppressions) et l'interrupteur restent jugés plus bas.
  if (payload.automated && !conversation.aiEnabled && !payload.finalWord) {
    return { outcome: "skipped", reason: "ai_paused" };
  }
  // Heures de travail de l'assistant qui écrit (défaut si aucun assistant).
  // Le dernier verrou avant l'envoi : un message automatisé hors fenêtre est
  // reporté à la prochaine ouverture, jamais expédié à 3 h.
  const quietHours = await resolveQuietHours(payload.assistantId);
  if (payload.automated && !isWithinSendWindow(now(), quietHours)) {
    return { outcome: "reschedule", runAt: nextSendTime(now(), quietHours) };
  }

  // ── Plafond du jour du numéro expéditeur ────────────────────────────────
  // « Max par jour de Toronto » était écrit sur la colonne et lu nulle part.
  // Un numéro qui dépasse son quota se fait classer indésirable : on reporte
  // au prochain matin permis, et on ne l'applique qu'aux envois automatisés —
  // un humain qui tape un message à la main a décidé, lui.
  const number = await db.query.smsNumbers.findFirst({
    where: eq(smsNumbers.id, conversation.smsNumberId),
    columns: { id: true, dailyCap: true },
  });
  if (payload.automated && number) {
    // Le MÊME compte que celui sur lequel la relance calcule son étalement
    // (`sms-server/daily-cap.ts`) : deux copies finiraient par diverger.
    if ((await outboundCountToday(number.id, now())) >= number.dailyCap) {
      return { outcome: "reschedule", runAt: nextSendTime(nextTorontoDayStart(now()), quietHours) };
    }
  }

  const analysis = analyzeSms(payload.body);
  const [intent] = await db
    .insert(messages)
    .values({
      conversationId: payload.conversationId,
      direction: "out",
      body: payload.body,
      jobId: job.id,
      status: "sending",
      source: payload.source,
      aiGenerated: payload.aiGenerated,
      sentById: payload.sentById,
      assistantId: payload.assistantId,
      assistantVersion: payload.assistantVersion,
      model: payload.model,
      segments: analysis.segments,
      encoding: analysis.encoding,
    })
    .returning({ id: messages.id });

  // Le lien barreau → message, refermé ICI et nulle part ailleurs.
  //
  // `campaign_touches.message_id` est déclaré et lié par clé étrangère depuis
  // toujours, mais aucun chemin de code ne l'écrivait : remonter d'un barreau
  // au message réellement parti obligeait à reconstruire la clé
  // `csend:<inscription>:<barreau>` du job, et la branche où c'est l'assistant
  // qui rédige n'en a même pas.
  //
  // Écrit AVANT l'appel à Twilio, sur la rangée-intention : si l'envoi est
  // ensuite refusé ou sauté, le barreau pointe sur la rangée qui EXPLIQUE
  // pourquoi rien n'est arrivé — c'est précisément ce qu'on veut lire. Et si la
  // rangée est effacée pour une reprise (5xx), la clé étrangère est
  // `on delete set null` : le lien se défait proprement, il ne pend pas.
  if (payload.outreach) {
    await db
      .update(campaignTouches)
      .set({ messageId: intent.id })
      .where(
        and(
          eq(campaignTouches.enrollmentId, payload.outreach.enrollmentId),
          eq(campaignTouches.step, payload.outreach.step),
        ),
      );
  }

  let result: SendResult;
  try {
    result = await getSmsProvider().send({
      to: payload.to,
      body: payload.body,
      conversationId: payload.conversationId,
      idempotencyKey: job.dedupeKey ?? job.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Trois cas, trois réponses — tranchés sur le statut HTTP que porte
    // l'erreur typée du transport (`TwilioSendError`), jamais sur le texte :
    // Twilio met un corps JSON `{ code, message }` autant sur un 400 que sur
    // un 500, le message ne suffit pas à les distinguer.
    //  · 5xx ou 429 de Twilio : rien n'est parti, la reprise avec
    //    temporisation est sûre — la rangée s'efface et la file réessaie ;
    //  · autre 4xx de Twilio (numéro invalide, ligne fixe, désabonné…) : refus
    //    DÉFINITIF, on le dit dans le fil et on prévient ;
    //  · délai ou réseau (aucun statut) : Twilio a PEUT-ÊTRE accepté —
    //    renvoyer ferait un doublon. On marque « unknown », on prévient, on
    //    n'insiste pas.
    const status = err instanceof TwilioSendError ? err.status : null;
    if (status !== null && (status >= 500 || status === 429)) {
      await db.delete(messages).where(eq(messages.id, intent.id));
      throw err;
    }
    const synchronousRejection = status !== null && status >= 400 && status < 500;
    const reason = synchronousRejection ? "provider_rejected" : "transport_error";
    await db
      .update(messages)
      .set({
        status: synchronousRejection ? "failed" : "unknown",
        skipReason: `${reason}: ${message.slice(0, 200)}`,
      })
      .where(eq(messages.id, intent.id));
    await db
      .update(conversations)
      .set({ needsAttention: true, attentionReason: "send_failed" })
      .where(eq(conversations.id, payload.conversationId));
    await notifyHumans({
      conversationId: payload.conversationId,
      clientId: conversation.clientId,
      kind: "error",
      reason: synchronousRejection ? "envoi refusé par Twilio" : "envoi incertain (délai réseau)",
    }).catch(() => 0);
    return { outcome: "failed_permanent", error: message };
  }

  if (!result.sent && result.skippedReason !== "dry_run") {
    // La rangée RESTE, avec la raison : le téléphoniste voit « non envoyé —
    // interrupteur d'arrêt » au lieu d'un message qui s'évapore.
    await db
      .update(messages)
      .set({ status: "skipped", skipReason: result.skippedReason ?? "not_sent" })
      .where(eq(messages.id, intent.id));
    return { outcome: "skipped", reason: result.skippedReason ?? "not_sent" };
  }

  try {
    await db
      .update(messages)
      .set({
        twilioSid: result.sid ?? null,
        status: result.sent ? "queued" : "dry_run",
        segments: result.segments,
        encoding: result.encoding,
      })
      .where(eq(messages.id, intent.id));
    await db
      .update(conversations)
      .set({ lastOutboundAt: now() })
      .where(eq(conversations.id, payload.conversationId));
    // Un SMS parti est un contact : « sans nouvelles depuis N jours » doit le
    // compter, sinon une réactivation réécrit à qui on vient d'écrire.
    if (result.sent) {
      await db
        .update(clients)
        .set({ lastContactedAt: now() })
        .where(eq(clients.id, conversation.clientId));
    }
  } catch {
    return { outcome: "done", note: "post_send_write_failed" };
  }
  return { outcome: "done" };
}
