import "server-only";
import { and, eq, gte, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { clients } from "@/db/schema";
import {
  campaignEnrollments,
  campaignTouches,
  campaigns,
  consents,
  conversations,
  smsNumbers,
  suppressions,
} from "@/db/schema-sms";
import { enqueueJob } from "@/lib/jobs/queue";
import { campaignRowToConfig } from "@/lib/campaigns/schema";
import { canSendTouch, type TouchRefusal } from "@/lib/campaigns/eligibility";
import { bodyForStep, ladderExhausted, nextTouchAt } from "@/lib/campaigns/ladder";
import { variantBody } from "@/lib/campaigns/variants";

/**
 * Envoi d'un barreau d'échelle.
 *
 * Deux verrous d'idempotence, et ils ne protègent pas de la même chose :
 *
 *  · `campaign_touches (enrollment_id, step)` est UNIQUE — le barreau 3 d'une
 *    inscription ne peut exister qu'une fois, même si le job est rejoué après
 *    une panne survenue entre la mise en file et le règlement.
 *  · La trace est écrite DANS la transaction qui met l'envoi en file. Poser la
 *    trace après coup laisserait, en cas de rollback, une file contenant un
 *    message dont rien n'atteste l'autorisation.
 *
 * L'éligibilité est re-vérifiée ici et pas seulement à l'inscription : une
 * échelle de trois semaines peut très bien traverser un STOP.
 */

export interface TouchResult {
  sent: boolean;
  step: number;
  refusal?: TouchRefusal;
  /** Prochain barreau planifié, quand il y en a un. */
  nextAt?: Date | null;
}

/** L'assistant rédige : on ne pose pas de texte, on lui passe la main. */
const AGENT_WRITES = null;

export async function runTouch(enrollmentId: string, now = new Date()): Promise<TouchResult> {
  const enrollment = await db.query.campaignEnrollments.findFirst({
    where: eq(campaignEnrollments.id, enrollmentId),
  });
  if (!enrollment) throw new Error("enrollment_not_found");

  const campaignRow = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, enrollment.campaignId),
  });
  if (!campaignRow) throw new Error("campaign_not_found");
  const config = campaignRowToConfig(campaignRow);

  const client = await db.query.clients.findFirst({ where: eq(clients.id, enrollment.clientId) });
  if (!client) return finish(enrollment.id, "excluded", "client_deleted", { sent: false, step: enrollment.step });

  const step = enrollment.step;

  // ── Faits ────────────────────────────────────────────────────────────────
  const [suppressedRow] = await db
    .select({ phone: suppressions.phoneE164 })
    .from(suppressions)
    .where(eq(suppressions.phoneE164, client.phone))
    .limit(1);

  const [consentRow] = await db
    .select({ id: consents.id })
    .from(consents)
    .where(
      and(
        eq(consents.clientId, client.id),
        eq(consents.channel, "sms"),
        isNull(consents.revokedAt),
        or(isNull(consents.expiresAt), gte(consents.expiresAt, now))!,
      ),
    )
    .limit(1);

  const conversation = enrollment.conversationId
    ? await db.query.conversations.findFirst({
        where: eq(conversations.id, enrollment.conversationId),
      })
    : null;

  // Une réponse APRÈS notre dernier barreau rend la main à l'assistant.
  const repliedSince =
    conversation !== null &&
    conversation !== undefined &&
    conversation.lastInboundAt !== null &&
    (enrollment.lastTouchAt === null || conversation.lastInboundAt > enrollment.lastTouchAt);

  const [existingTouch] = await db
    .select({ id: campaignTouches.id })
    .from(campaignTouches)
    .where(and(eq(campaignTouches.enrollmentId, enrollment.id), eq(campaignTouches.step, step)))
    .limit(1);

  const decision = canSendTouch({
    campaignStatus: campaignRow.status,
    enrollmentStatus: enrollment.status,
    suppressed: suppressedRow !== undefined,
    hasValidConsent: config.requireConsent ? consentRow !== undefined : true,
    aiEnabled: conversation?.aiEnabled ?? true,
    ladderLength: config.ladder.length,
    step,
    alreadySent: existingTouch !== undefined,
    repliedSince,
  });

  if (!decision.allowed) {
    return handleRefusal(enrollment.id, step, decision.refusal);
  }

  // Le barreau est-il DÛ? Sans cette question, un job rejoué juste après un
  // envoi réussi trouve l'inscription déjà avancée d'un cran et expédie le
  // barreau suivant sur-le-champ — deux messages à quelques secondes d'écart,
  // exactement ce que les délais de l'échelle servent à éviter.
  if (enrollment.nextTouchAt !== null && enrollment.nextTouchAt > now) {
    return { sent: false, step, refusal: "not_due", nextAt: enrollment.nextTouchAt };
  }

  // ── Numéro expéditeur ────────────────────────────────────────────────────
  const smsNumber = campaignRow.smsNumberId
    ? await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.id, campaignRow.smsNumberId) })
    : await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.active, true) });
  if (!smsNumber) {
    // Pas de DID configuré : c'est une panne de configuration, pas une décision
    // sur la personne. On ne clôt pas l'inscription, on repousse.
    return { sent: false, step, refusal: "campaign_not_active" };
  }

  const opener = variantBody(config.variants, enrollment.variant);
  const body = bodyForStep(config.ladder, step, opener);

  const nextStep = step + 1;
  const plannedNext = ladderExhausted(config.ladder, nextStep)
    ? null
    : nextTouchAt(config.ladder, nextStep, enrollment.enrolledAt, now);

  await db.transaction(async (tx) => {
    // La conversation est le fil : upsertée sur (téléphone, numéro), comme le
    // fait le webhook entrant — un client qui a déjà écrit garde son fil.
    await tx
      .insert(conversations)
      .values({
        clientId: client.id,
        clientPhone: client.phone,
        smsNumberId: smsNumber.id,
        activeAssistantId: campaignRow.assistantId,
      })
      .onConflictDoNothing();
    const thread = await tx.query.conversations.findFirst({
      where: and(
        eq(conversations.clientPhone, client.phone),
        eq(conversations.smsNumberId, smsNumber.id),
      ),
    });
    if (!thread) throw new Error("conversation_upsert_failed");

    // L'assistant de la campagne prend le fil s'il n'y en a pas déjà un.
    if (thread.activeAssistantId === null && campaignRow.assistantId !== null) {
      await tx
        .update(conversations)
        .set({ activeAssistantId: campaignRow.assistantId })
        .where(eq(conversations.id, thread.id));
    }

    // La trace AVANT la mise en file, dans la même transaction : l'index unique
    // fait échouer un rejeu ici, donc aucun deuxième message ne part.
    await tx.insert(campaignTouches).values({
      enrollmentId: enrollment.id,
      step,
      variant: enrollment.variant,
      plannedAt: enrollment.nextTouchAt ?? now,
      sentAt: now,
      status: body === AGENT_WRITES ? "queued" : "sent",
    });

    if (body !== AGENT_WRITES) {
      await enqueueJob(
        {
          type: "send_sms",
          runAt: now,
          payload: {
            conversationId: thread.id,
            to: client.phone,
            body,
            source: "ladder",
            automated: true,
            aiGenerated: false,
            sentById: null,
          },
          // Un barreau donné ne met en file qu'un envoi, jamais deux.
          dedupeKey: `touch:${enrollment.id}:${step}`,
        },
        tx,
      );
    } else {
      // Barreau sans texte : c'est l'assistant qui écrit. On le réveille au
      // lieu d'inventer une formulation ici.
      await enqueueJob(
        {
          type: "agent_turn",
          runAt: now,
          payload: { conversationId: thread.id },
          dedupeKey: `turn:${thread.id}`,
        },
        tx,
      );
    }

    await tx
      .update(campaignEnrollments)
      .set({
        conversationId: thread.id,
        step: nextStep,
        lastTouchAt: now,
        nextTouchAt: plannedNext,
        // Dernier barreau : on clôt ICI. Laisser l'inscription « active » avec
        // `next_touch_at` à null la rendrait invisible pour toujours — la file
        // ne sélectionne que les barreaux dus, donc rien ne viendrait jamais la
        // fermer, et les statistiques compteraient éternellement des campagnes
        // « en cours » qui ont fini leur travail.
        ...(plannedNext === null
          ? { status: "completed" as const, endReason: "ladder_exhausted", endedAt: now }
          : { status: "active" as const }),
        updatedAt: now,
      })
      .where(eq(campaignEnrollments.id, enrollment.id));
  });

  return { sent: true, step, nextAt: plannedNext };
}

/**
 * Un refus n'a pas toujours la même conséquence. Un désabonnement CLÔT
 * l'inscription ; une pause de campagne la laisse en attente, pour qu'elle
 * reprenne quand la campagne repart.
 */
async function handleRefusal(
  enrollmentId: string,
  step: number,
  refusal: TouchRefusal,
): Promise<TouchResult> {
  const terminal: TouchRefusal[] = ["suppressed", "consent_expired", "ladder_exhausted", "replied"];
  if (!terminal.includes(refusal)) {
    return { sent: false, step, refusal };
  }

  const status =
    refusal === "replied" ? "replied" : refusal === "ladder_exhausted" ? "completed" : "stopped";
  return finish(enrollmentId, status, refusal, { sent: false, step, refusal });
}

async function finish(
  enrollmentId: string,
  status: "stopped" | "completed" | "replied" | "excluded",
  reason: string,
  result: TouchResult,
): Promise<TouchResult> {
  await db
    .update(campaignEnrollments)
    .set({
      status,
      endReason: reason,
      endedAt: new Date(),
      nextTouchAt: null,
      updatedAt: new Date(),
    })
    .where(eq(campaignEnrollments.id, enrollmentId));
  return result;
}
