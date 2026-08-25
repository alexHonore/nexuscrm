import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaignEnrollments, conversations, messages, scheduledJobs } from "@/db/schema-sms";
import { UNDELIVERED_STATUSES } from "@/lib/agent/runtime";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { enqueueJob } from "@/lib/jobs/queue";

/**
 * POST /api/admin/sms/replay-llm-errors — rejouer les tours tombés en panne.
 *
 * Après une panne de modèle (l'incident du 2026-08-25 : crédits OpenRouter
 * épuisés), les fils marqués `llm_error` sont RÉGLÉS du point de vue de la
 * file : entrants consommés à la dernière tentative, jobs en échec définitif.
 * Réparer la cause ne les fait donc PAS repartir — chaque contact resterait
 * sans réponse jusqu'à son prochain message.
 *
 * Ce rejeu, idempotent (le relancer quand il n'y a rien à faire ne fait rien) :
 *  · fil de RÉPONSE — rouvre les entrants consommés depuis le dernier sortant
 *    reçu (même définition d'« indélivré » que le budget de tours) et remet un
 *    tour en file sous la clé du webhook ;
 *  · fil d'OUVERTURE (barreau de campagne) — remet en file le même tour
 *    proactif que celui qui a échoué, sauf si l'inscription a été stoppée ou
 *    exclue entre-temps ;
 *  · fil déjà repris par un humain (rien à rouvrir, pas d'ouverture en échec) —
 *    la pastille est simplement levée.
 *
 * Ne touche QUE les fils `attention = llm_error` avec l'IA encore active : un
 * refus ferme, un désabonnement ou une pause humaine ne sont jamais rejoués.
 */
export async function POST() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const stuck = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.aiEnabled, true),
        eq(conversations.needsAttention, true),
        eq(conversations.attentionReason, "llm_error"),
        isNotNull(conversations.activeAssistantId),
      ),
    );

  let replayedInbound = 0;
  let replayedOutreach = 0;
  let cleared = 0;

  for (const conv of stuck) {
    // Rouvrir les entrants restés sans réponse : tout entrant consommé APRÈS
    // le dernier sortant que la personne a réellement reçu.
    const reopened = await db
      .update(messages)
      .set({ processedAt: null })
      .where(
        and(
          eq(messages.conversationId, conv.id),
          eq(messages.direction, "in"),
          isNotNull(messages.processedAt),
          sql`${messages.createdAt} > coalesce((
            select max(m2.created_at) from messages m2
            where m2.conversation_id = ${conv.id}
              and m2.direction = 'out'
              and coalesce(m2.status, '') not in ${UNDELIVERED_STATUSES}
          ), to_timestamp(0))`,
        ),
      )
      .returning({ id: messages.id });

    if (reopened.length > 0) {
      await enqueueJob({
        type: "agent_turn",
        runAt: new Date(Date.now() + 2_000),
        payload: { conversationId: conv.id },
        // La MÊME clé que le webhook : un tour déjà en file absorbe le nôtre.
        dedupeKey: `turn:${conv.id}`,
      });
      replayedInbound += 1;
    } else {
      // Aucun entrant à reprendre : peut-être une OUVERTURE de campagne qui a
      // échoué — le job en échec définitif porte encore son contexte.
      const [failedJob] = await db
        .select({ payload: scheduledJobs.payload })
        .from(scheduledJobs)
        .where(
          and(
            eq(scheduledJobs.type, "agent_turn"),
            eq(scheduledJobs.status, "failed"),
            sql`${scheduledJobs.payload}->>'conversationId' = ${conv.id}`,
          ),
        )
        .orderBy(desc(scheduledJobs.createdAt))
        .limit(1);
      const outreach = (failedJob?.payload as { outreach?: { enrollmentId: string; step: number } } | undefined)
        ?.outreach;
      const enrollment = outreach
        ? await db.query.campaignEnrollments.findFirst({
            where: eq(campaignEnrollments.id, outreach.enrollmentId),
            columns: { status: true },
          })
        : undefined;

      if (outreach && enrollment && enrollment.status !== "stopped" && enrollment.status !== "excluded") {
        await enqueueJob({
          type: "agent_turn",
          runAt: new Date(Date.now() + 2_000),
          payload: { conversationId: conv.id, outreach },
          // La clé du barreau d'origine — le dédoublonnage n'absorbe que les
          // jobs vivants, jamais celui en échec qu'on remplace.
          dedupeKey: `outreach:${outreach.enrollmentId}:${outreach.step}`,
        });
        replayedOutreach += 1;
      } else {
        cleared += 1;
      }
    }

    // La pastille tombe : le tour rejoué la remettra s'il échoue encore.
    await db
      .update(conversations)
      .set({ needsAttention: false, attentionReason: null })
      .where(eq(conversations.id, conv.id));
  }

  await logAudit({
    userId: admin.id,
    action: "sms.replay_llm_errors",
    entity: "conversation",
    detail: { stuck: stuck.length, replayedInbound, replayedOutreach, cleared },
  });

  return NextResponse.json({ stuck: stuck.length, replayedInbound, replayedOutreach, cleared });
}
