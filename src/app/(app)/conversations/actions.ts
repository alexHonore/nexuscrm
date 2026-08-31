"use server";

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { HUMAN_CLOSED_REASON } from "@/components/conversations/state";
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
import { noVerdictCondition } from "@/lib/conversations/attention";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import {
  type Actor,
  currentActor,
  guardClient,
  loadDirectory,
  verifyAssignment,
  withVisibility,
} from "@/lib/permissions/server";
import { cancelPendingJobs, enqueueJob } from "@/lib/jobs/queue";
import { kickDispatch } from "@/lib/jobs/kick";
import { analyzeSms } from "@/lib/sms/segments";
import { setClientCategoryAction } from "../clients/actions";

/**
 * Actions du fil SMS.
 *
 * C'est le point du cahier §16 : quelqu'un doit pouvoir reprendre la main sur
 * une conversation depuis son cellulaire, en pleine journée d'appels. Les
 * gestes réservés à l'administrateur (interrupteur général, suppression
 * manuelle d'un numéro) ne sont PAS ici.
 *
 * DEUX questions se posent à chaque geste, jamais une seule :
 *
 *   · le RÔLE l'autorise-t-il ? — `conversations.reply` pour écrire,
 *     `conversations.control` pour reprendre, rendre, assigner, archiver,
 *     `conversations.assistant` pour CHOISIR l'assistant qui tient le fil ;
 *   · la FICHE derrière le fil s'ouvre-t-elle à lui ? — la même matrice que
 *     partout ailleurs (`guardClient`), parce qu'un fil parle d'une fiche.
 *
 * Et la case exigée sur la fiche est celle du geste RÉEL, jamais la simple
 * visibilité : commander l'assistant (couper, rendre, réessayer, archiver,
 * s'attribuer le fil) décide de ce que le robot ENVERRA à ce client-là — donc
 * la case `sms`, comme écrire soi-même. Voir une fiche prise par un collègue
 * pour ne pas la rappeler ne donne pas la parole sur elle. BRANCHER un robot
 * sur ce client-là est encore autre chose : c'est la case `assistant`. Classer,
 * c'est la case `category`. Les droits `conversations.control` /
 * `conversations.reply` / `conversations.assistant` restent le plafond
 * au-dessus, chacun sur son geste.
 *
 * Quand la fiche est invisible, la réponse est « introuvable » et jamais
 * « interdit » : un refus confirmerait l'existence de ce que le réglage cache.
 *
 * Un envoi manuel n'est pas un envoi d'agent : il est marqué `automated: false`,
 * ce qui le dispense des heures de politesse ET de la pause IA — un humain qui
 * décide d'écrire à 21 h assume ce choix, alors qu'une machine ne le peut pas.
 */

export type SmsActionResult =
  | { ok: true; id?: string; relaunched?: boolean; closed?: number }
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

/**
 * Le fil VU par cet acteur — et rien du tout si la fiche derrière lui échappe.
 *
 * Toutes les actions passent par ici : elles n'ont pas le droit de charger une
 * conversation par son identifiant sans repasser par la fiche, sinon il
 * suffirait de connaître un UUID pour agir sur un fil qu'on ne voit pas.
 *
 * @param grant la case exigée sur la fiche. Sans valeur par défaut, à dessein :
 *   un geste ajouté demain doit DIRE ce qu'il ouvre, et non hériter en silence
 *   de la case la plus faible.
 */
async function threadFor(actor: Actor, conversationId: string, grant: keyof Grants) {
  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!thread) return null;
  const guarded = await guardClient(actor, thread.clientId, grant);
  if (!guarded) return null;
  return { thread, client: guarded.ref, grants: guarded.grants };
}

const sendSchema = z.object({
  clientId: z.uuid(),
  body: z.string().trim().min(1).max(1600),
});

/**
 * Envoi manuel. Crée le fil s'il n'existe pas encore : un téléphoniste doit
 * pouvoir écrire le premier, sans dépendre d'une campagne ou d'un entrant.
 *
 * Deux verrous : le droit d'écrire (`conversations.reply`) et la case `sms` de
 * CETTE fiche — un rôle peut avoir le droit de répondre partout où il travaille
 * sans pouvoir écrire à la fiche que le courtier a prise.
 */
export async function sendManualSmsAction(input: {
  clientId: string;
  body: string;
}): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.reply")) return FORBIDDEN;

  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return INVALID;

  // La fiche tranche avant tout le reste : invisible pour ce regard, ou canal
  // SMS fermé sur elle, et la réponse est « introuvable ».
  if (!(await guardClient(actor, parsed.data.clientId, "sms"))) return NOT_FOUND;

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
          sentById: actor.user.id,
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
    userId: actor.user.id,
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
 *
 * Retenir un message est l'envers d'en écrire un : c'est `conversations.reply`
 * qui l'autorise, et la case `sms` de la fiche visée qui le borne.
 */
export async function cancelQueuedSmsAction(jobId: string): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.reply")) return FORBIDDEN;
  if (!z.uuid().safeParse(jobId).success) return INVALID;
  const job = await db.query.scheduledJobs.findFirst({ where: eq(scheduledJobs.id, jobId) });
  if (!job || job.type !== "send_sms") return NOT_FOUND;
  const payload = job.payload as { conversationId?: string };
  // Un job d'envoi porte TOUJOURS son fil : sans lui, impossible de dire à
  // quelle fiche ce message appartient — donc impossible de l'autoriser.
  if (!payload.conversationId) return NOT_FOUND;
  const seen = await threadFor(actor, payload.conversationId, "sms");
  if (!seen) return NOT_FOUND;
  const rows = await db
    .update(scheduledJobs)
    .set({ status: "cancelled" })
    .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, "pending")))
    .returning({ id: scheduledJobs.id });
  if (rows.length === 0) return { ok: false, error: "alreadySent" };
  await logAudit({
    userId: actor.user.id,
    action: "sms.cancel",
    entity: "conversation",
    entityId: payload.conversationId,
    detail: { jobId },
  });
  revalidateFor(seen.thread.clientId);
  return { ok: true, id: jobId };
}

/**
 * Confier le fil à un assistant (ou le lui retirer). Avant, seul un barreau de
 * campagne savait le faire : un contact qui écrivait de lui-même n'avait jamais
 * de réponse IA, et un humain ne pouvait pas « rendre » un fil à l'assistant.
 *
 * Ce geste a son droit à lui, `conversations.assistant`, et pas celui des
 * autres boutons du fil. Reprendre la main sur un fil est une décision de
 * téléphoniste ; décider QUEL robot parle au nom de l'entreprise à ce
 * client-là est une décision commerciale. On peut vouloir confier la première
 * sans la seconde — c'est exactement ce que porte le rôle superviseur livré.
 *
 * Même partage côté fiche : la case `assistant`, et non `sms`. Pouvoir écrire
 * soi-même à un client ne donne pas le droit de laisser une machine lui écrire
 * à sa place, et le contraire est vrai aussi.
 */
export async function assignAssistantAction(input: {
  conversationId: string;
  assistantId: string | null;
}): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.assistant")) return FORBIDDEN;
  if (!z.uuid().safeParse(input.conversationId).success) return INVALID;
  if (input.assistantId !== null && !z.uuid().safeParse(input.assistantId).success) return INVALID;
  const seen = await threadFor(actor, input.conversationId, "assistant");
  if (!seen) return NOT_FOUND;
  const { thread } = seen;

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
    userId: actor.user.id,
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
 * Couper l'IA, c'est retenir tout ce qu'elle allait envoyer à ce client (les
 * envois différés en file sont annulés plus bas) ; la rendre, c'est la
 * relancer. Dans les deux sens, c'est la case `sms` de la fiche.
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
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;

  const parsed = pauseSchema.safeParse(input);
  if (!parsed.success) return INVALID;

  const seen = await threadFor(actor, parsed.data.conversationId, "sms");
  if (!seen) return NOT_FOUND;
  const { thread } = seen;

  const now = new Date();
  await db
    .update(conversations)
    .set(
      parsed.data.enabled
        ? { aiEnabled: true, pausedById: null, pausedAt: null, pauseReason: null }
        : {
            aiEnabled: false,
            pausedById: actor.user.id,
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
    userId: actor.user.id,
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
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const seen = await threadFor(actor, conversationId, "sms");
  if (!seen) return NOT_FOUND;
  const { thread } = seen;

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
    userId: actor.user.id,
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
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  // Rejouer un tour, c'est remettre l'assistant aux commandes du fil : même
  // droit que reprendre ou rendre la main.
  if (!actor.can("conversations.control")) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const seen = await threadFor(actor, conversationId, "sms");
  if (!seen) return NOT_FOUND;
  const { thread } = seen;

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
    userId: actor.user.id,
    action: "sms.retry_turn",
    entity: "conversation",
    entityId: thread.id,
    detail: { reopened: reopened.length, relaunched },
  });

  if (thread.clientId) revalidateFor(thread.clientId);
  else revalidatePath("/conversations");
  return { ok: true, id: thread.id, relaunched };
}

/**
 * Marque un fil comme traité — retire la pastille « à traiter ».
 *
 * C'est ARCHIVER : la demande disparaît de la file de tout le monde, pas
 * seulement de son propre écran. D'où `conversations.control` — et la case
 * `sms` de la fiche : faire taire la demande d'un client, c'est décider que
 * personne ne lui répondra.
 */
export async function markConversationHandledAction(
  conversationId: string,
): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const seen = await threadFor(actor, conversationId, "sms");
  if (!seen) return NOT_FOUND;

  await db
    .update(conversations)
    .set({ needsAttention: false, attentionReason: null })
    .where(eq(conversations.id, conversationId));

  revalidateFor(seen.thread.clientId);
  return { ok: true, id: conversationId };
}

/**
 * La condition « ENTRE VOS MAINS », écrite une fois.
 *
 * Un fil est entre les mains d'un humain quand l'IA y est coupée, qu'aucune
 * pastille ne réclame plus personne, ET qu'aucun verdict n'a été rendu — les
 * TROIS tests de `conversationStateOf` pour l'état `human`, pas deux. Le
 * troisième n'est pas décoratif : sans lui, un fil déjà clos redevenait
 * clorable, et « Tout clore » deux fois de suite annonçait deux fois le même
 * nombre en écrivant deux fois la même ligne au journal d'audit.
 *
 * Posée dans le `where` de la mise à jour, elle fait qu'un fil rendu à l'IA
 * (ou redevenu « à traiter », ou déjà clos) pendant qu'un onglet dormait n'est
 * pas clos par un clic périmé — il est simplement sauté, et le compte rendu le
 * dit.
 */
const HELD = and(
  eq(conversations.aiEnabled, false),
  eq(conversations.needsAttention, false),
  noVerdictCondition(),
);

/**
 * « Clore » — le fil sort de « à traiter », un humain ayant décidé qu'il était
 * fini.
 *
 * C'est la sortie qui manquait à la section « Entre vos mains ». Les deux
 * gestes voisins n'y répondaient pas : « Marquer traité » ne retire qu'une
 * pastille déjà tombée, et « Rendre à l'IA » n'existe pas quand aucun
 * assistant ne tient le fil — la section grossissait donc sans fin.
 *
 * Clore n'est ni supprimer, ni faire taire :
 *  · l'IA reste COUPÉE (on ne remet pas une machine aux commandes d'un fil
 *    qu'un humain avait pris) — donc rien ne partira tout seul ;
 *  · le fil reste lisible sous « Toutes », section « Conclues » ;
 *  · le prochain message du client réécrit `attentionReason` (« Nouveau
 *    message ») et le ramène dans « à traiter ».
 *
 * Même porte que les autres commandes du fil : le droit `conversations.control`
 * comme plafond, la case `sms` de la fiche comme robinet — décider que
 * personne ne répond plus à ce client-là, c'est prendre la parole sur lui.
 */
export async function closeConversationAction(conversationId: string): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const seen = await threadFor(actor, conversationId, "sms");
  if (!seen) return NOT_FOUND;

  const rows = await db
    .update(conversations)
    .set({ needsAttention: false, attentionReason: HUMAN_CLOSED_REASON })
    .where(and(eq(conversations.id, conversationId), HELD))
    .returning({ id: conversations.id });
  // Zéro rangée = le fil n'est plus entre des mains humaines. On ne prétend pas
  // l'avoir clos : l'écran rafraîchira et montrera où il est passé.
  if (rows.length === 0) return INVALID;

  await logAudit({
    userId: actor.user.id,
    action: "conversation.close",
    entity: "conversation",
    entityId: conversationId,
    detail: { reason: HUMAN_CLOSED_REASON },
  });

  revalidateFor(seen.thread.clientId);
  return { ok: true, id: conversationId, closed: 1 };
}

/** La boîte ne charge pas plus de 200 fils (voir la page) — la vider non plus. */
const MAX_BULK_CLOSE = 200;

/**
 * « Tout clore » — le même geste, sur la pile entière.
 *
 * L'écran envoie les identifiants qu'il MONTRE (le filtre « les miennes »
 * compris) : vider ce qu'on voit et vider ce qui existe ne sont pas la même
 * promesse, et c'est la première qu'on tient ici.
 *
 * Le serveur ne fait confiance à aucun de ces identifiants. Il refait les trois
 * questions de la matrice — la fiche est-elle visible pour ce regard
 * (`withVisibility`), sa case `sms` est-elle ouverte, le fil est-il vraiment
 * entre des mains humaines (`HELD`) — et ne clôt que ce qui passe les trois.
 * Le compte rendu est celui des fils RÉELLEMENT clos, jamais celui des
 * identifiants reçus : un « 12 fils clos » sur 9 fermetures serait un mensonge.
 */
export async function closeHeldConversationsAction(
  conversationIds: string[],
): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;

  const parsed = z.array(z.uuid()).min(1).max(MAX_BULK_CLOSE).safeParse(conversationIds);
  if (!parsed.success) return INVALID;
  const ids = [...new Set(parsed.data)];

  // Les fils vus par CE regard, et le détenteur de la fiche derrière chacun.
  const threads = await db
    .select({ id: conversations.id, holderId: clients.assignedToId })
    .from(conversations)
    .innerJoin(clients, eq(clients.id, conversations.clientId))
    .where(await withVisibility(actor, and(inArray(conversations.id, ids), HELD)));
  if (threads.length === 0) return { ok: true, closed: 0 };

  // La case `sms` de CHAQUE fiche. Elle ne dépend que du détenteur : on la
  // résout une fois par détenteur, pas une fois par fil.
  const { cfg, roleOf } = await loadDirectory();
  const smsOpen = new Map<string, boolean>();
  const mayWrite = (assignedToId: string | null): boolean => {
    const key = assignedToId ?? "";
    const hit = smsOpen.get(key);
    if (hit !== undefined) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const open = grantsFor(
      cfg,
      actor.role,
      bucketFor(actor.user.id, { assignedToId }, holder),
    ).sms;
    smsOpen.set(key, open);
    return open;
  };
  const closable = threads.filter((t) => mayWrite(t.holderId)).map((t) => t.id);
  if (closable.length === 0) return { ok: true, closed: 0 };

  const closed = await db
    .update(conversations)
    .set({ needsAttention: false, attentionReason: HUMAN_CLOSED_REASON })
    .where(and(inArray(conversations.id, closable), HELD))
    .returning({ id: conversations.id, clientId: conversations.clientId });

  await logAudit({
    userId: actor.user.id,
    action: "conversation.close_bulk",
    entity: "conversation",
    detail: { count: closed.length, asked: ids.length, ids: closed.map((c) => c.id) },
  });

  for (const clientId of new Set(closed.map((c) => c.clientId))) {
    revalidatePath(`/clients/${clientId}`);
  }
  revalidatePath("/conversations");
  return { ok: true, closed: closed.length };
}

/**
 * Assigner un fil à quelqu'un — ou le rendre au bassin (`userId: null`).
 *
 * Cette action DISAIT suivre la règle des fiches ; elle ne la suivait pas :
 * n'importe quel téléphoniste pouvait s'attribuer le fil d'un collègue, alors
 * que la fiche derrière lui, elle, ne changeait pas de main. Un fil est une
 * poignée sur une fiche : le voler revient à voler le lead.
 *
 * Le verdict est donc rendu par le MÊME moteur que les fiches
 * (`verifyAssignment` sur la fiche du fil) — plafond de fiches détenues,
 * verrou anti-vol et son expiration compris. Ce qui change de main ici reste
 * le fil seul : réassigner la FICHE est un geste de la fiche, pas de la boîte.
 *
 * Et avant même le verdict, la case `sms` : prendre un fil, c'est prendre la
 * parole vers ce client. Une fiche seulement visible ne se prend pas.
 */
export async function assignConversationAction(input: {
  conversationId: string;
  userId: string | null;
}): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;
  if (!z.uuid().safeParse(input.conversationId).success) return INVALID;
  if (input.userId !== null && !z.uuid().safeParse(input.userId).success) return INVALID;

  const seen = await threadFor(actor, input.conversationId, "sms");
  if (!seen) return NOT_FOUND;

  // La fiche est visible à ce stade : un refus d'assignation peut donc se dire
  // franchement, il ne révèle rien qu'on cachait.
  const verdict = await verifyAssignment(actor, seen.client, input.userId);
  if (!verdict.ok) return FORBIDDEN;

  /**
   * Le FIL a son propre titulaire, indépendant de celui de la fiche : une
   * fiche peut dormir au bassin pendant qu'un collègue tient la conversation.
   * Le verdict ci-dessus ne dit donc rien de ce cas-là — et sans cette
   * seconde question, n'importe qui « désattribuait » le fil d'un collègue
   * pour le reprendre ensuite, ce qui est exactement le vol qu'on ferme
   * ailleurs. Même règle que pour une fiche : on ne retire à quelqu'un que si
   * le rôle l'autorise.
   */
  const held = seen.thread.assignedToId;
  if (held !== null && held !== actor.user.id && !actor.role.superAdmin) {
    if (!actor.role.assignment.takeFromOthers) return FORBIDDEN;
  }

  await db
    .update(conversations)
    .set({ assignedToId: input.userId })
    .where(eq(conversations.id, input.conversationId));

  revalidateFor(seen.thread.clientId);
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
 *
 * Retenir un message est l'envers d'en écrire un : `conversations.reply`, et la
 * case `sms` de la fiche visée.
 */
export async function cancelOutboundSmsAction(messageId: string): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.reply")) return FORBIDDEN;
  if (!z.uuid().safeParse(messageId).success) return INVALID;

  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) return NOT_FOUND;
  if (message.direction !== "out") return INVALID;

  const seen = await threadFor(actor, message.conversationId, "sms");
  if (!seen) return NOT_FOUND;

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
    userId: actor.user.id,
    action: "sms.cancel",
    entity: "conversation",
    entityId: message.conversationId,
    detail: { messageId, source: message.source },
  });

  revalidateFor(seen.thread.clientId);
  return { ok: true, id: messageId };
}

/**
 * Classer la fiche d'un fil — depuis la boîte de réception.
 *
 * Un simple relais vers l'action des fiches : la règle de classement (statut
 * « ne pas appeler » qui coche `doNotCall`, journal d'audit, déclencheur de
 * changement de catégorie) vit là-bas et n'a aucune raison d'exister en deux
 * exemplaires. Ce qui justifie le relais, c'est l'IMPORT : la boîte est un
 * composant client, et `clients/actions` traîne des modules « server-only »
 * qu'il ne peut pas charger.
 *
 * Effet de bord VOULU, et c'est tout l'intérêt du geste : ranger une fiche
 * libère les campagnes qui ne visent plus sa nouvelle catégorie.
 *
 * Relayer n'est pas déléguer la GARDE : ce point d'entrée a sa propre porte —
 * le droit `clients.category` et la case `category` de cette fiche-là. Compter
 * sur celle de l'action relayée reviendrait à faire de cette signature un
 * contournement de la matrice, et une fiche invisible se range à travers un
 * relais aussi bien qu'à travers une fiche ouverte.
 */
export async function classifyConversationClientAction(
  clientId: string,
  categoryId: number,
): Promise<{ ok: boolean }> {
  const actor = await currentActor();
  if (!actor) return { ok: false };
  if (!actor.can("clients.category")) return { ok: false };
  if (!z.uuid().safeParse(clientId).success) return { ok: false };
  if (!(await guardClient(actor, clientId, "category"))) return { ok: false };

  const result = await setClientCategoryAction(clientId, categoryId);
  return { ok: result.ok };
}
