"use server";

import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import {
  assistants,
  campaignEnrollments,
  conversations,
  messages,
  scheduledJobs,
  smsNumbers,
} from "@/db/schema-sms";
import { UNDELIVERED_STATUSES } from "@/lib/agent/runtime";
import { logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/guards";
import { cancelPendingJobs, enqueueJob } from "@/lib/jobs/queue";
import { kickDispatch } from "@/lib/jobs/kick";
import { analyzeSms } from "@/lib/sms/segments";

/**
 * Actions du fil SMS — accessibles aux TÉLÉPHONISTES.
 *
 * C'est le point du cahier §16 : quelqu'un doit pouvoir reprendre la main sur
 * une conversation depuis son cellulaire, en pleine journée d'appels. Les
 * gestes réservés à l'administrateur (interrupteur général, suppression
 * manuelle d'un numéro) ne sont PAS ici.
 *
 * Un envoi manuel n'est pas un envoi d'agent : il est marqué `automated: false`,
 * ce qui le dispense des heures de politesse ET de la pause IA — un humain qui
 * décide d'écrire à 21 h assume ce choix, alors qu'une machine ne le peut pas.
 */

export type SmsActionResult =
  | { ok: true; id?: string; relaunched?: boolean }
  | {
      ok: false;
      error:
        | "invalid"
        | "forbidden"
        | "notFound"
        | "suppressed"
        | "noNumber"
        | "alreadySent"
        | "assistantUnavailable";
    };

const INVALID = { ok: false, error: "invalid" } as const;
const FORBIDDEN = { ok: false, error: "forbidden" } as const;
const NOT_FOUND = { ok: false, error: "notFound" } as const;

function revalidateFor(clientId: string): void {
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/conversations");
}

const sendSchema = z.object({
  clientId: z.uuid(),
  body: z.string().trim().min(1).max(1600),
});

/**
 * Envoi manuel. Crée le fil s'il n'existe pas encore : un téléphoniste doit
 * pouvoir écrire le premier, sans dépendre d'une campagne ou d'un entrant.
 */
export async function sendManualSmsAction(input: {
  clientId: string;
  body: string;
}): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return INVALID;

  const client = await db.query.clients.findFirst({
    where: eq(clients.id, parsed.data.clientId),
  });
  if (!client) return NOT_FOUND;
  if (!client.phone) return { ok: false, error: "invalid" };

  // La suppression est vérifiée ICI en plus du garde d'envoi : refuser dans
  // l'écran vaut mieux que mettre en file un message qui sera jeté sans que
  // personne ne le voie.
  const suppressed = await db.query.suppressions.findFirst({
    where: (s, { eq: e }) => e(s.phoneE164, client.phone),
  });
  if (suppressed) return { ok: false, error: "suppressed" };

  // Un fil existant garde SON numéro : écrire depuis un autre créerait un
  // second fil pour la même personne, et sa réponse tomberait à côté.
  const existing = await db.query.conversations.findFirst({
    where: eq(conversations.clientPhone, client.phone),
    orderBy: [desc(conversations.lastInboundAt), desc(conversations.createdAt)],
  });
  const number = existing
    ? await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.id, existing.smsNumberId) })
    : await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.active, true) });
  if (!number) return { ok: false, error: "noNumber" };

  const analysis = analyzeSms(parsed.data.body);

  const conversationId = await db.transaction(async (tx) => {
    await tx
      .insert(conversations)
      .values({ clientId: client.id, clientPhone: client.phone, smsNumberId: number.id })
      .onConflictDoNothing();
    const thread = await tx.query.conversations.findFirst({
      where: and(
        eq(conversations.clientPhone, client.phone),
        eq(conversations.smsNumberId, number.id),
      ),
    });
    if (!thread) throw new Error("conversation_upsert_failed");

    await enqueueJob(
      {
        type: "send_sms",
        runAt: new Date(),
        payload: {
          conversationId: thread.id,
          to: client.phone,
          body: parsed.data.body,
          source: "human",
          automated: false,
          aiGenerated: false,
          sentById: user.id,
        },
      },
      tx,
    );

    // Écrire soi-même vaut prise en charge : la conversation sort de la file
    // « à traiter » sans qu'on ait à cliquer deux fois.
    await tx
      .update(conversations)
      .set({ needsAttention: false, attentionReason: null })
      .where(eq(conversations.id, thread.id));

    return thread.id;
  });

  await logAudit({
    userId: user.id,
    action: "sms.send_manual",
    entity: "conversation",
    entityId: conversationId,
    detail: { clientId: client.id, segments: analysis.segments, encoding: analysis.encoding },
  });
  // Chemin rapide : le message part dans les secondes, sans attendre le cron.
  kickDispatch();
  revalidateFor(client.id);
  return { ok: true, id: conversationId };
}

/**
 * Annuler un envoi encore EN FILE — identifié par son JOB. Tant que le
 * répartiteur ne l'a pas pris, aucune rangée `messages` n'existe : c'est le
 * job qu'il faut annuler, et c'est le seul moment où « annuler » veut dire
 * quelque chose. Un SMS remis à Twilio ne se rappelle pas.
 */
export async function cancelQueuedSmsAction(jobId: string): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.uuid().safeParse(jobId).success) return INVALID;
  const job = await db.query.scheduledJobs.findFirst({ where: eq(scheduledJobs.id, jobId) });
  if (!job || job.type !== "send_sms") return NOT_FOUND;
  const payload = job.payload as { conversationId?: string };
  const rows = await db
    .update(scheduledJobs)
    .set({ status: "cancelled" })
    .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, "pending")))
    .returning({ id: scheduledJobs.id });
  if (rows.length === 0) return { ok: false, error: "alreadySent" };
  await logAudit({
    userId: user.id,
    action: "sms.cancel",
    entity: "conversation",
    entityId: payload.conversationId,
    detail: { jobId },
  });
  if (payload.conversationId) {
    const thread = await db.query.conversations.findFirst({
      where: eq(conversations.id, payload.conversationId),
    });
    if (thread?.clientId) revalidateFor(thread.clientId);
  }
  return { ok: true, id: jobId };
}

/**
 * Confier le fil à un assistant (ou le lui retirer). Avant, seul un barreau de
 * campagne savait le faire : un contact qui écrivait de lui-même n'avait jamais
 * de réponse IA, et un humain ne pouvait pas « rendre » un fil à l'assistant.
 */
export async function assignAssistantAction(input: {
  conversationId: string;
  assistantId: string | null;
}): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.uuid().safeParse(input.conversationId).success) return INVALID;
  if (input.assistantId !== null && !z.uuid().safeParse(input.assistantId).success) return INVALID;
  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, input.conversationId),
  });
  if (!thread) return NOT_FOUND;

  let version: number | null = null;
  if (input.assistantId !== null) {
    const target = await db.query.assistants.findFirst({
      where: eq(assistants.id, input.assistantId),
      columns: { id: true, status: true, compiledPrompt: true, version: true },
    });
    if (!target || target.status !== "active" || !target.compiledPrompt) {
      return { ok: false, error: "assistantUnavailable" };
    }
    version = target.version;
  }
  await db
    .update(conversations)
    .set({
      activeAssistantId: input.assistantId,
      activeAssistantVersion: version,
      // Confier = l'IA reprend la parole ; retirer = un humain répond.
      ...(input.assistantId !== null
        ? { aiEnabled: true, pausedById: null, pausedAt: null, pauseReason: null }
        : {}),
    })
    .where(eq(conversations.id, thread.id));

  // Un entrant attend ? L'assistant répond tout de suite.
  if (input.assistantId !== null) {
    const pending = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, thread.id),
        eq(messages.direction, "in"),
        isNull(messages.processedAt),
      ),
      columns: { id: true },
    });
    if (pending) {
      await enqueueJob({
        type: "agent_turn",
        runAt: new Date(),
        payload: { conversationId: thread.id },
        dedupeKey: `turn:${thread.id}`,
      });
      kickDispatch();
    }
  }
  await logAudit({
    userId: user.id,
    action: input.assistantId ? "conversation.assign_assistant" : "conversation.unassign_assistant",
    entity: "conversation",
    entityId: thread.id,
    detail: { assistantId: input.assistantId },
  });
  if (thread.clientId) revalidateFor(thread.clientId);
  else revalidatePath("/conversations");
  return { ok: true, id: thread.id };
}

const pauseSchema = z.object({
  conversationId: z.uuid(),
  enabled: z.boolean(),
  reason: z.string().trim().max(200).nullish(),
});

/**
 * Prise de contrôle : couper ou rendre l'IA sur un fil.
 *
 * On enregistre QUI a coupé et POURQUOI. Six semaines plus tard, « pourquoi
 * cette conversation ne répond-elle plus? » doit avoir une réponse dans la
 * donnée, pas dans la mémoire de quelqu'un.
 */
export async function setConversationAiAction(input: {
  conversationId: string;
  enabled: boolean;
  reason?: string | null;
}): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = pauseSchema.safeParse(input);
  if (!parsed.success) return INVALID;

  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, parsed.data.conversationId),
  });
  if (!thread) return NOT_FOUND;

  const now = new Date();
  await db
    .update(conversations)
    .set(
      parsed.data.enabled
        ? { aiEnabled: true, pausedById: null, pausedAt: null, pauseReason: null }
        : {
            aiEnabled: false,
            pausedById: user.id,
            pausedAt: now,
            pauseReason: parsed.data.reason ?? "manual",
          },
    )
    .where(eq(conversations.id, thread.id));
  // Prendre le contrôle annule ce que l'IA avait DÉJÀ mis en file pour ce
  // fil : une réponse différée (heures de politesse) composée avant la prise
  // de contrôle partirait sinon par-dessus l'humain.
  if (!parsed.data.enabled) {
    await cancelPendingJobs({ types: ["send_sms"], conversationId: thread.id, automatedOnly: true });
    await cancelPendingJobs({ types: ["agent_turn"], conversationId: thread.id });
  }

  await logAudit({
    userId: user.id,
    action: parsed.data.enabled ? "conversation.ai_resume" : "conversation.ai_pause",
    entity: "conversation",
    entityId: thread.id,
    detail: { reason: parsed.data.reason ?? null },
  });

  if (thread.clientId) revalidateFor(thread.clientId);
  else revalidatePath("/conversations");
  return { ok: true, id: thread.id };
}

/**
 * « Rendre à l'IA » — LE geste de la boîte de réception quand la bonne
 * réponse est : que l'assistant continue.
 *
 * Trois choses en un clic, parce qu'aucune des actions existantes ne les
 * faisait toutes : l'IA reprend la parole (fin de pause), la pastille « à
 * traiter » tombe (la décision EST le traitement), et si un entrant attend
 * encore sa réponse, le tour repart tout de suite — sans quoi « rendre à
 * l'IA » laisserait le client sans réponse jusqu'à son prochain message.
 */
export async function handBackToAiAction(conversationId: string): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!thread) return NOT_FOUND;

  // Rendre la main à personne n'est pas rendre la main : sans assistant actif
  // et compilé, le fil resterait muet en prétendant le contraire.
  if (!thread.activeAssistantId) return { ok: false, error: "assistantUnavailable" };
  const assistant = await db.query.assistants.findFirst({
    where: eq(assistants.id, thread.activeAssistantId),
    columns: { id: true, status: true, compiledPrompt: true },
  });
  if (!assistant || assistant.status !== "active" || !assistant.compiledPrompt) {
    return { ok: false, error: "assistantUnavailable" };
  }

  await db
    .update(conversations)
    .set({
      aiEnabled: true,
      pausedById: null,
      pausedAt: null,
      pauseReason: null,
      needsAttention: false,
      attentionReason: null,
    })
    .where(eq(conversations.id, thread.id));

  const pending = await db.query.messages.findFirst({
    where: and(
      eq(messages.conversationId, thread.id),
      eq(messages.direction, "in"),
      isNull(messages.processedAt),
    ),
    columns: { id: true },
  });
  if (pending) {
    await enqueueJob({
      type: "agent_turn",
      runAt: new Date(),
      payload: { conversationId: thread.id },
      dedupeKey: `turn:${thread.id}`,
    });
    kickDispatch();
  }

  await logAudit({
    userId: user.id,
    action: "conversation.ai_resume",
    entity: "conversation",
    entityId: thread.id,
    detail: { source: "inbox_handback", relaunched: Boolean(pending) },
  });

  if (thread.clientId) revalidateFor(thread.clientId);
  else revalidatePath("/conversations");
  return { ok: true, id: thread.id };
}

/**
 * « Réessayer » — relancer l'assistant sur UN fil tombé en panne.
 *
 * Le rejeu global (/api/admin/sms/replay-llm-errors) répare une panne de
 * flotte, mais il est réservé à l'administrateur et ratisse tout. Ici, le
 * geste d'un téléphoniste devant UNE carte « Panne du modèle » : la même
 * mécanique, bornée à ce fil.
 *
 * Ce que « réessayer » veut dire, dans l'ordre :
 *  · rouvrir les entrants consommés restés SANS réponse (tout entrant
 *    postérieur au dernier sortant réellement reçu — la définition
 *    d'« indélivré » du budget de tours) et remettre un tour en file ;
 *  · sinon, remettre en file l'OUVERTURE de campagne dont le job a échoué —
 *    sauf inscription stoppée ou exclue entre-temps ;
 *  · sinon, un entrant jamais consommé (tour mort avant sa tentative finale)
 *    reçoit simplement son tour.
 *
 * Dans tous les cas l'IA est remise en selle et la pastille tombe — le tour
 * rejoué la remettra s'il échoue encore. `relaunched` dit honnêtement si
 * quelque chose est reparti : « réessayé » et « rien à réessayer » ne doivent
 * pas afficher le même toast.
 */
export async function retryAiTurnAction(conversationId: string): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!thread) return NOT_FOUND;

  // Réessayer sans assistant actif et compilé ne relancerait rien : refuser
  // vaut mieux qu'une pastille qui tombe en silence.
  if (!thread.activeAssistantId) return { ok: false, error: "assistantUnavailable" };
  const assistant = await db.query.assistants.findFirst({
    where: eq(assistants.id, thread.activeAssistantId),
    columns: { id: true, status: true, compiledPrompt: true },
  });
  if (!assistant || assistant.status !== "active" || !assistant.compiledPrompt) {
    return { ok: false, error: "assistantUnavailable" };
  }

  const reopened = await db
    .update(messages)
    .set({ processedAt: null })
    .where(
      and(
        eq(messages.conversationId, thread.id),
        eq(messages.direction, "in"),
        isNotNull(messages.processedAt),
        sql`${messages.createdAt} > coalesce((
          select max(m2.created_at) from messages m2
          where m2.conversation_id = ${thread.id}
            and m2.direction = 'out'
            and coalesce(m2.status, '') not in ${UNDELIVERED_STATUSES}
        ), to_timestamp(0))`,
      ),
    )
    .returning({ id: messages.id });

  let relaunched = false;
  if (reopened.length > 0) {
    await enqueueJob({
      type: "agent_turn",
      runAt: new Date(),
      payload: { conversationId: thread.id },
      // La MÊME clé que le webhook : un tour déjà en file absorbe le nôtre.
      dedupeKey: `turn:${thread.id}`,
    });
    relaunched = true;
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
          sql`${scheduledJobs.payload}->>'conversationId' = ${thread.id}`,
        ),
      )
      .orderBy(desc(scheduledJobs.createdAt))
      .limit(1);
    const outreach = (
      failedJob?.payload as { outreach?: { enrollmentId: string; step: number } } | undefined
    )?.outreach;
    const enrollment = outreach
      ? await db.query.campaignEnrollments.findFirst({
          where: eq(campaignEnrollments.id, outreach.enrollmentId),
          columns: { status: true },
        })
      : undefined;

    if (
      outreach &&
      enrollment &&
      enrollment.status !== "stopped" &&
      enrollment.status !== "excluded"
    ) {
      await enqueueJob({
        type: "agent_turn",
        runAt: new Date(),
        payload: { conversationId: thread.id, outreach },
        // La clé du barreau d'origine — le dédoublonnage n'absorbe que les
        // jobs vivants, jamais celui en échec qu'on remplace.
        dedupeKey: `outreach:${outreach.enrollmentId}:${outreach.step}`,
      });
      relaunched = true;
    } else {
      // Entrant ORPHELIN : jamais consommé, son tour est mort avant la
      // tentative finale. Remettre le tour du webhook suffit.
      const pending = await db.query.messages.findFirst({
        where: and(
          eq(messages.conversationId, thread.id),
          eq(messages.direction, "in"),
          isNull(messages.processedAt),
        ),
        columns: { id: true },
      });
      if (pending) {
        await enqueueJob({
          type: "agent_turn",
          runAt: new Date(),
          payload: { conversationId: thread.id },
          dedupeKey: `turn:${thread.id}`,
        });
        relaunched = true;
      }
    }
  }

  await db
    .update(conversations)
    .set({
      aiEnabled: true,
      pausedById: null,
      pausedAt: null,
      pauseReason: null,
      needsAttention: false,
      attentionReason: null,
    })
    .where(eq(conversations.id, thread.id));

  if (relaunched) kickDispatch();

  await logAudit({
    userId: user.id,
    action: "sms.retry_turn",
    entity: "conversation",
    entityId: thread.id,
    detail: { reopened: reopened.length, relaunched },
  });

  if (thread.clientId) revalidateFor(thread.clientId);
  else revalidatePath("/conversations");
  return { ok: true, id: thread.id, relaunched };
}

/** Marque un fil comme traité — retire la pastille « à traiter ». */
export async function markConversationHandledAction(
  conversationId: string,
): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!thread) return NOT_FOUND;

  await db
    .update(conversations)
    .set({ needsAttention: false, attentionReason: null })
    .where(eq(conversations.id, conversationId));

  if (thread.clientId) revalidateFor(thread.clientId);
  else revalidatePath("/conversations");
  return { ok: true, id: conversationId };
}

/**
 * Assigner un fil à quelqu'un. Un téléphoniste peut se l'attribuer, ou
 * RELÂCHER un fil qu'il tient (ou que personne ne tient) ; seul un
 * administrateur peut l'attribuer à AUTRUI ou désattribuer le fil d'un
 * collègue — même règle que les fiches clients.
 */
export async function assignConversationAction(input: {
  conversationId: string;
  userId: string | null;
}): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.uuid().safeParse(input.conversationId).success) return INVALID;
  if (input.userId !== null && !z.uuid().safeParse(input.userId).success) return INVALID;

  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, input.conversationId),
  });
  if (!thread) return NOT_FOUND;

  if (user.role !== "admin") {
    const releasesOwn =
      input.userId === null &&
      (thread.assignedToId === null || thread.assignedToId === user.id);
    if (input.userId !== user.id && !releasesOwn) return FORBIDDEN;
  }

  await db
    .update(conversations)
    .set({ assignedToId: input.userId })
    .where(eq(conversations.id, input.conversationId));

  if (thread.clientId) revalidateFor(thread.clientId);
  else revalidatePath("/conversations");
  return { ok: true, id: input.conversationId };
}

/**
 * Annuler un envoi — « unsend », dans la seule mesure où c'est honnête.
 *
 * Un SMS remis à l'opérateur ne se rappelle PAS. Ce que cette action fait, et
 * la seule chose qu'elle puisse faire : intercepter le message tant qu'il est
 * encore DANS LA FILE. Cette fenêtre existe vraiment et elle est souvent
 * longue — le délai humanisé de l'assistant (30 à 90 s), le report par les
 * heures de politesse (jusqu'au lendemain matin), les barreaux de campagne
 * programmés à des jours d'intervalle.
 *
 * Dès que Twilio a accepté le message, on refuse plutôt que de faire semblant :
 * afficher « annulé » sur un message déjà parti serait pire que ne rien offrir,
 * parce que quelqu'un s'y fierait.
 */
export async function cancelOutboundSmsAction(messageId: string): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.uuid().safeParse(messageId).success) return INVALID;

  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) return NOT_FOUND;
  if (message.direction !== "out") return INVALID;

  // `twilioSid` renseigné = l'opérateur l'a accepté : c'est parti.
  const gone =
    message.twilioSid !== null ||
    ["sending", "sent", "delivered", "undelivered", "failed"].includes(message.status ?? "");
  if (gone) return { ok: false, error: "alreadySent" };

  const cancelled = await db.transaction(async (tx) => {
    // Le job d'abord : tant qu'il est `pending`, personne ne l'a réclamé. S'il
    // est déjà `running`, l'annulation arrive trop tard et on ne ment pas.
    let jobCancelled = true;
    if (message.jobId !== null) {
      const rows = await tx
        .update(scheduledJobs)
        .set({ status: "cancelled" })
        .where(and(eq(scheduledJobs.id, message.jobId), eq(scheduledJobs.status, "pending")))
        .returning({ id: scheduledJobs.id });
      jobCancelled = rows.length > 0;
    }
    if (!jobCancelled) return false;

    await tx
      .update(messages)
      .set({ status: "cancelled", processedAt: new Date() })
      .where(eq(messages.id, messageId));
    return true;
  });

  if (!cancelled) return { ok: false, error: "alreadySent" };

  await logAudit({
    userId: user.id,
    action: "sms.cancel",
    entity: "conversation",
    entityId: message.conversationId,
    detail: { messageId, source: message.source },
  });

  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, message.conversationId),
  });
  if (thread?.clientId) revalidateFor(thread.clientId);
  return { ok: true, id: messageId };
}
