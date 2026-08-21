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
import {
  canSendTouch,
  LIVE_CONVERSATION_WINDOW_MS,
  type TouchRefusal,
} from "@/lib/campaigns/eligibility";
import { bodyForStep, ladderExhausted, nextTouchAt } from "@/lib/campaigns/ladder";
import { variantBody } from "@/lib/campaigns/variants";
import { DEFAULT_QUIET_HOURS, isWithinSendWindow, nextSendTime } from "@/lib/sms/quiet-hours";
import { settingsSendGate } from "@/lib/sms-server";

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
 *
 * Le barreau n'est écrit et l'échelle n'avance QUE si l'envoi peut vraiment
 * partir maintenant : interrupteur d'arrêt baissé, numéro expéditeur actif,
 * heures de politesse respectées. Avancer d'abord et laisser l'envoi se faire
 * refuser plus loin consommait le barreau pour rien — après un incident d'une
 * heure sous interrupteur, des centaines d'échelles disaient « envoyé » sans
 * qu'un seul SMS ne soit parti. Et reporter l'envoi (plutôt que le barreau)
 * aux heures de politesse faisait partir deux barreaux dans la même matinée :
 * l'espacement se mesurait depuis la mise en file du soir, pas depuis l'envoi
 * réel du lendemain.
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

/**
 * Délais de reprise des refus « pas maintenant ». Sans eux, une inscription
 * refusée reste due et la file la re-présente À CHAQUE CYCLE — 1 440 jobs par
 * jour et par inscription pour un fil mis en pause par un humain.
 */
const KILL_SWITCH_RETRY_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

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

  // ── Numéro expéditeur ────────────────────────────────────────────────────
  // Résolu AVANT la décision : c'est lui qui permet de retrouver le fil existant
  // (unique sur téléphone + numéro) quand l'inscription n'en connaît pas encore.
  // Un numéro épinglé mais désactivé ne sert plus — on n'écrit pas depuis une
  // ligne qu'un administrateur vient de fermer.
  const smsNumber = campaignRow.smsNumberId
    ? await db.query.smsNumbers.findFirst({
        where: and(eq(smsNumbers.id, campaignRow.smsNumberId), eq(smsNumbers.active, true)),
      })
    : await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.active, true) });

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

  // Le fil : celui de l'inscription, sinon celui qui existe DÉJÀ pour ce
  // téléphone sur ce numéro. Avant le premier barreau l'inscription n'en connaît
  // aucun — mais la personne peut très bien être en pleine conversation avec
  // l'assistant, ou un humain peut avoir repris la main. Ignorer ce fil-là
  // faisait partir l'ouverture froide au milieu d'un échange en cours.
  const conversation = enrollment.conversationId
    ? await db.query.conversations.findFirst({
        where: eq(conversations.id, enrollment.conversationId),
      })
    : smsNumber
      ? await db.query.conversations.findFirst({
          where: and(
            eq(conversations.clientPhone, client.phone),
            eq(conversations.smsNumberId, smsNumber.id),
          ),
        })
      : undefined;
  const lastInboundAt = conversation?.lastInboundAt ?? null;

  // Une réponse APRÈS notre dernier barreau rend la main à l'assistant.
  const repliedSince =
    lastInboundAt !== null &&
    enrollment.lastTouchAt !== null &&
    lastInboundAt > enrollment.lastTouchAt;

  // Rien n'est encore parti : un entrant récent veut dire que le fil est vivant.
  // Sans fenêtre, un message vieux d'un an ferait passer toute réactivation
  // pour une « réponse ».
  const liveConversation =
    enrollment.lastTouchAt === null &&
    lastInboundAt !== null &&
    lastInboundAt.getTime() >= now.getTime() - LIVE_CONVERSATION_WINDOW_MS;

  const [existingTouch] = await db
    .select({ id: campaignTouches.id })
    .from(campaignTouches)
    .where(and(eq(campaignTouches.enrollmentId, enrollment.id), eq(campaignTouches.step, step)))
    .limit(1);

  const decision = canSendTouch({
    campaignStatus: campaignRow.status,
    enrollmentStatus: enrollment.status,
    // La MÊME porte que le fournisseur (`settingsSendGate`) : elle échoue fermée
    // sur un réglage illisible, comme l'envoi lui-même.
    killSwitch: !(await settingsSendGate.isSendingAllowed()),
    suppressed: suppressedRow !== undefined,
    hasValidConsent: config.requireConsent ? consentRow !== undefined : true,
    doNotCall: client.doNotCall,
    excludeDoNotCall: config.audience.excludeDoNotCall,
    aiEnabled: conversation?.aiEnabled ?? true,
    ladderLength: config.ladder.length,
    step,
    alreadySent: existingTouch !== undefined,
    repliedSince,
    liveConversation,
    hasSender: smsNumber !== undefined,
    withinSendWindow: isWithinSendWindow(now, DEFAULT_QUIET_HOURS),
  });

  if (!decision.allowed) {
    return handleRefusal(enrollment, decision.refusal, now);
  }
  // Le garde-type : `hasSender` vient d'être vérifié par la décision.
  if (!smsNumber) return handleRefusal(enrollment, "no_sender", now);

  // Le barreau est-il DÛ? Sans cette question, un job rejoué juste après un
  // envoi réussi trouve l'inscription déjà avancée d'un cran et expédie le
  // barreau suivant sur-le-champ — deux messages à quelques secondes d'écart,
  // exactement ce que les délais de l'échelle servent à éviter.
  if (enrollment.nextTouchAt !== null && enrollment.nextTouchAt > now) {
    return { sent: false, step, refusal: "not_due", nextAt: enrollment.nextTouchAt };
  }

  const opener = variantBody(config.variants, enrollment.variant);
  const body = bodyForStep(config.ladder, step, opener);

  const nextStep = step + 1;
  // `now` est bien l'instant d'envoi : on n'arrive ici que dans la fenêtre
  // d'envoi, donc l'espacement du barreau suivant se mesure depuis l'envoi réel.
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
          // Espace de noms DISTINCT de celui du job `campaign_touch`
          // (`ctouch:…`). Avec la même clé, le job de barreau encore VIVANT
          // absorbait cette mise en file — c'est le comportement documenté du
          // dédoublonnage — et l'envoi disparaissait en silence : l'échelle
          // avançait, les traces disaient « envoyé », et aucun SMS ne partait.
          dedupeKey: `csend:${enrollment.id}:${step}`,
        },
        tx,
      );
    } else {
      // Barreau sans texte : c'est l'assistant qui écrit. On le réveille avec le
      // CONTEXTE du barreau — sans lui, le tour cherche un entrant à traiter,
      // n'en trouve pas et se termine en « skipped » : rien ne part, et rien ne
      // le dit. Clé distincte de `turn:<conversation>` : un tour de réponse en
      // vol (le contact vient d'écrire) ne doit pas absorber l'ouverture, ni
      // l'inverse — le runtime arbitre entre les deux au moment d'écrire.
      await enqueueJob(
        {
          type: "agent_turn",
          runAt: now,
          payload: { conversationId: thread.id, outreach: { enrollmentId: enrollment.id, step } },
          dedupeKey: `outreach:${enrollment.id}:${step}`,
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

type EnrollmentRow = typeof campaignEnrollments.$inferSelect;

/**
 * Un refus n'a pas toujours la même conséquence.
 *
 *  · Un « non » définitif (désabonnement, consentement expiré, ne pas appeler,
 *    réponse, échelle finie, fil déjà vivant) CLÔT l'inscription.
 *  · Un « pas maintenant » (interrupteur, numéro manquant, fil en pause, heures
 *    de politesse) la REPOUSSE : `next_touch_at` avance, sinon la file la
 *    représenterait à chaque cycle — un job par minute et par inscription,
 *    pour toujours.
 *  · Une campagne en pause ne touche à rien : la file ne sélectionne déjà pas
 *    ses inscriptions, et elles doivent repartir sans délai à la reprise.
 *  · « Pas dû » non plus : la date déjà posée est la bonne.
 */
async function handleRefusal(
  enrollment: EnrollmentRow,
  refusal: TouchRefusal,
  now: Date,
): Promise<TouchResult> {
  const step = enrollment.step;
  const result: TouchResult = { sent: false, step, refusal };

  switch (refusal) {
    case "replied":
      return finish(enrollment.id, "replied", refusal, result);
    case "ladder_exhausted":
      return finish(enrollment.id, "completed", refusal, result);
    case "live_conversation":
      // Rien n'est parti : « écartée », pas « arrêtée » — l'échelle n'a jamais
      // commencé, et les statistiques ne doivent pas y voir un refus exprimé.
      return finish(enrollment.id, "excluded", refusal, result);
    case "suppressed":
    case "consent_expired":
    case "do_not_call":
      return finish(enrollment.id, "stopped", refusal, result);

    case "quiet_hours":
      // Prochaine ouverture de la fenêtre, avec le jitter de `nextSendTime` :
      // un lot reporté pendant la nuit part étalé le matin, pas en rafale.
      return defer(enrollment, nextSendTime(now, DEFAULT_QUIET_HOURS), result);
    case "kill_switch":
      return defer(enrollment, new Date(now.getTime() + KILL_SWITCH_RETRY_MS), result);
    case "ai_paused":
    case "no_sender":
    case "already_sent":
      return defer(enrollment, new Date(now.getTime() + RETRY_MS), result);

    case "campaign_not_active":
    case "enrollment_ended":
    case "not_due":
      return result;
  }
}

/** Repousse le prochain barreau — jamais plus tôt que ce qui était déjà prévu. */
async function defer(
  enrollment: EnrollmentRow,
  until: Date,
  result: TouchResult,
): Promise<TouchResult> {
  const planned = enrollment.nextTouchAt;
  const nextAt = planned !== null && planned > until ? planned : until;
  await db
    .update(campaignEnrollments)
    .set({ nextTouchAt: nextAt, updatedAt: new Date() })
    .where(eq(campaignEnrollments.id, enrollment.id));
  return { ...result, nextAt };
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

/**
 * Résultat d'un tour proactif, écrit sur la trace du barreau.
 *
 * Le barreau est créé « queued » au moment où l'assistant est réveillé ; c'est
 * le tour qui sait ensuite si un message est parti, a été bloqué par un
 * garde-fou, ou a cédé la place à une réponse du contact. Sans cette écriture,
 * tous les barreaux rédigés par l'assistant resteraient « queued » pour
 * toujours et les statistiques ne distingueraient pas « envoyé » de « rien ».
 */
export async function markTouchOutcome(
  enrollmentId: string,
  step: number,
  status: string,
): Promise<void> {
  await db
    .update(campaignTouches)
    .set({ status })
    .where(and(eq(campaignTouches.enrollmentId, enrollmentId), eq(campaignTouches.step, step)));
}
