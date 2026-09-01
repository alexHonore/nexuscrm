"use server";

import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { HUMAN_CLOSED_REASON, UNREACHED_SEND_STATUSES } from "@/components/conversations/state";
import { db } from "@/db";
import { clients } from "@/db/schema";
import {
  assistants,
  campaignEnrollments,
  conversations,
  messages,
  scheduledJobs,
  smsNumbers,
  suppressions,
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
import { normalizePhone } from "@/lib/phone";
import { detectOptOut } from "@/lib/sms/optout";
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
        | "assistantUnavailable"
        // Un STOP ne se lève pas depuis une interface (règle 12) : c'est le
        // seul refus de ce fichier qui n'est pas une question de droits.
        | "stopIsAbsolute";
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
 * La case `sms` de CHAQUE fiche, résolue une fois par DÉTENTEUR.
 *
 * Les gestes en masse posent la même troisième question que les gestes
 * unitaires — la fiche derrière ce fil ouvre-t-elle sa case `sms` ? — mais sur
 * deux cents fils d'un coup. La réponse ne dépend QUE du détenteur de la
 * fiche : on la calcule une fois par détenteur, pas une fois par fil.
 *
 * Écrite ici une seule fois parce que deux copies finissent par diverger, et
 * qu'un écart entre « Tout clore » et « Tout archiver » voudrait dire qu'un des
 * deux gestes touche des fiches que l'autre protège.
 */
async function smsOpenByHolder(actor: Actor): Promise<(assignedToId: string | null) => boolean> {
  const { cfg, roleOf } = await loadDirectory();
  const smsOpen = new Map<string, boolean>();
  return (assignedToId: string | null): boolean => {
    const key = assignedToId ?? "";
    const hit = smsOpen.get(key);
    if (hit !== undefined) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const open = grantsFor(cfg, actor.role, bucketFor(actor.user.id, { assignedToId }, holder)).sms;
    smsOpen.set(key, open);
    return open;
  };
}

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

  // La case `sms` de CHAQUE fiche, résolue une fois par détenteur.
  const mayWrite = await smsOpenByHolder(actor);
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
 * Ranger un fil fait tomber sa pastille — mais SANS effacer un verdict.
 *
 * Deux raisons de ne pas laisser une pastille allumée sous l'archive : le
 * tableau de bord compte les fils « à reprendre » sans rien savoir de l'archive
 * (`needsHumanCondition`), et annoncerait donc du travail que plus aucun écran
 * ne montre — exactement la panne « cinq ici, trois là-bas » déjà réparée
 * ailleurs ; et l'onglet « Archivées » afficherait des rangées qui crient
 * encore « à traiter » alors qu'on vient de dire le contraire.
 *
 * Le MOTIF, lui, ne tombe que s'il n'est pas un verdict : « Conclue »,
 * « Refusé », « Désabonné » sont la CONCLUSION du fil, pas une demande en
 * attente. Les effacer ferait mentir la fiche du client et les sections de la
 * boîte, alors qu'archiver ne prétend rien changer à ce qui s'est passé. La
 * condition est celle de `noVerdictCondition()`, pour qu'il n'existe jamais
 * deux définitions du mot « verdict ».
 */
const CLEAR_REASON_UNLESS_VERDICT = sql<
  string | null
>`case when ${noVerdictCondition()} then null else ${conversations.attentionReason} end`;

/**
 * « Archiver » — le fil sort des listes, et RIEN n'est effacé.
 *
 * Le geste que la boîte n'avait pas : les fils éteints (un contact qui n'a
 * jamais répondu, une conclusion vieille de six semaines) restaient là pour
 * toujours, et une liste qu'on ne peut pas finir cesse d'être regardée. Ce qui
 * disparaît est l'ENTRÉE DE LISTE, pas la conversation : le fil reste entier
 * sur la fiche du client, ses messages, son verdict et son historique intacts,
 * et l'onglet « Archivées » le rend en un clic.
 *
 * ── La promesse, et il faut la lire avant de croire ce bouton dangereux ────
 * Un fil archivé n'est PAS réduit au silence pour toujours : le prochain
 * message du client remet `archivedAt` à null (voir `lib/sms-server/inbound.ts`)
 * et le ramène dans « À traiter », pastille comprise. Rien d'archivé ne peut
 * donc avaler un client vivant — c'est exactement ce que « Clore » promet déjà,
 * et les deux gestes tiennent la même promesse pour que personne n'ait à se
 * demander lequel est sûr.
 *
 * ── Ce n'est PAS un réglage d'affichage personnel ──────────────────────────
 * Le fil quitte la boucle de TOUT LE MONDE, comme « Marquer traité » et
 * « Clore » : deux colonnes sur la table, pas une préférence par personne.
 * Décider que plus personne n'a à regarder la demande d'un client n'est pas une
 * décision privée — et deux téléphonistes devant deux boîtes différentes
 * finiraient par croire, chacun, que l'autre s'en occupe. D'où la même porte
 * que ses voisins : le droit `conversations.control` comme plafond, la case
 * `sms` de la fiche comme robinet.
 *
 * Idempotent : archiver deux fois (deux onglets, un clic répété) répond
 * « fait » sans réécrire qui a rangé le fil ni quand — la signature du PREMIER
 * est la seule qui veuille dire quelque chose six semaines plus tard.
 */
export async function archiveConversationAction(conversationId: string): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const seen = await threadFor(actor, conversationId, "sms");
  if (!seen) return NOT_FOUND;

  // Déjà rangé : c'est fait, et on ne touche pas à la signature du premier.
  if (seen.thread.archivedAt) return { ok: true, id: conversationId };

  const [archived] = await db
    .update(conversations)
    .set({
      archivedAt: new Date(),
      archivedById: actor.user.id,
      needsAttention: false,
      attentionReason: CLEAR_REASON_UNLESS_VERDICT,
    })
    // La condition est REDITE ici et c'est elle qui tient : entre la lecture
    // ci-dessus et cette ligne, un collègue a pu ranger le même fil.
    .where(and(eq(conversations.id, conversationId), isNull(conversations.archivedAt)))
    .returning({ id: conversations.id });
  // Quelqu'un est passé avant nous : rien à journaliser, rien n'a eu lieu.
  if (!archived) return { ok: true, id: conversationId };

  await logAudit({
    userId: actor.user.id,
    action: "sms.archive",
    entity: "conversation",
    entityId: conversationId,
    detail: { clientId: seen.thread.clientId },
  });

  revalidateFor(seen.thread.clientId);
  return { ok: true, id: conversationId };
}

/**
 * « Sortir de l'archive » — le fil revient dans les listes de tout le monde.
 *
 * Même porte que l'archivage, et pour la raison symétrique : remettre un fil
 * dans la boucle de l'équipe est une décision aussi collective que l'en sortir.
 * Un rôle qui peut ranger sans pouvoir dé-ranger (ou l'inverse) laisserait un
 * geste sans retour.
 *
 * Ce qui revient est le fil TEL QU'IL A ÉTÉ RANGÉ : la pastille ne se rallume
 * pas. Sortir un fil de l'archive n'invente aucune demande du client — seul un
 * message de sa part le remet dans « À traiter », par le même chemin que
 * l'archive automatique (`lib/sms-server/inbound.ts`). Un bouton qui
 * ressusciterait une pastille à la place du client ferait réclamer du travail
 * que personne n'a demandé.
 *
 * Idempotent, comme son jumeau : un fil déjà dans la boucle répond « fait ».
 */
export async function unarchiveConversationAction(
  conversationId: string,
): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;
  if (!z.uuid().safeParse(conversationId).success) return INVALID;

  const seen = await threadFor(actor, conversationId, "sms");
  if (!seen) return NOT_FOUND;

  // Déjà dans la boucle : rien à défaire.
  if (!seen.thread.archivedAt) return { ok: true, id: conversationId };

  const [restored] = await db
    .update(conversations)
    .set({ archivedAt: null, archivedById: null })
    .where(and(eq(conversations.id, conversationId), isNotNull(conversations.archivedAt)))
    .returning({ id: conversations.id });
  if (!restored) return { ok: true, id: conversationId };

  await logAudit({
    userId: actor.user.id,
    action: "sms.unarchive",
    entity: "conversation",
    entityId: conversationId,
    detail: { clientId: seen.thread.clientId, archivedAt: seen.thread.archivedAt.toISOString() },
  });

  revalidateFor(seen.thread.clientId);
  return { ok: true, id: conversationId };
}

/**
 * « Tout archiver » — le même rangement, sur la pile entière.
 *
 * Le jumeau de « Tout clore », et pour la même raison : ranger deux cents fils
 * éteints un par un, personne ne le fera, et c'est ainsi qu'une boîte de
 * réception devient du décor.
 *
 * L'écran envoie les identifiants qu'il MONTRE (filtres compris) : ranger ce
 * qu'on voit et ranger ce qui existe ne sont pas la même promesse, et c'est la
 * première qu'on tient ici.
 *
 * Le serveur ne fait confiance à aucun de ces identifiants. Il repose les trois
 * questions — la fiche est-elle visible pour ce regard (`withVisibility`), sa
 * case `sms` est-elle ouverte, le fil est-il encore dans la boucle
 * (`archivedAt is null`) — et n'archive que ce qui passe les trois. Le compte
 * rendu est celui des fils RÉELLEMENT rangés, jamais celui des identifiants
 * reçus : un « 12 fils archivés » sur 9 rangements serait un mensonge, et
 * renvoyer les fils déjà archivés d'un onglet périmé en gonflerait le nombre
 * sans que rien ne bouge à l'écran.
 */
export async function archiveConversationsAction(ids: string[]): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;

  const parsed = z.array(z.uuid()).min(1).max(MAX_BULK_CLOSE).safeParse(ids);
  if (!parsed.success) return INVALID;
  const asked = [...new Set(parsed.data)];

  // Les fils vus par CE regard, encore dans la boucle, et le détenteur de la
  // fiche derrière chacun.
  const threads = await db
    .select({ id: conversations.id, holderId: clients.assignedToId })
    .from(conversations)
    .innerJoin(clients, eq(clients.id, conversations.clientId))
    .where(
      await withVisibility(
        actor,
        and(inArray(conversations.id, asked), isNull(conversations.archivedAt)),
      ),
    );
  if (threads.length === 0) return { ok: true, closed: 0 };

  const mayWrite = await smsOpenByHolder(actor);
  const archivable = threads.filter((t) => mayWrite(t.holderId)).map((t) => t.id);
  if (archivable.length === 0) return { ok: true, closed: 0 };

  const archived = await db
    .update(conversations)
    .set({
      archivedAt: new Date(),
      archivedById: actor.user.id,
      needsAttention: false,
      attentionReason: CLEAR_REASON_UNLESS_VERDICT,
    })
    .where(and(inArray(conversations.id, archivable), isNull(conversations.archivedAt)))
    .returning({ id: conversations.id, clientId: conversations.clientId });

  await logAudit({
    userId: actor.user.id,
    action: "sms.archive_bulk",
    entity: "conversation",
    detail: { count: archived.length, asked: asked.length, ids: archived.map((c) => c.id) },
  });

  for (const clientId of new Set(archived.map((c) => c.clientId))) {
    revalidatePath(`/clients/${clientId}`);
  }
  revalidatePath("/conversations");
  return { ok: true, closed: archived.length };
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
 * La MÊME définition d'« il n'est pas arrivé » que la vue « Échecs » et que la
 * bulle rouge du fil. Deux listes finiraient par offrir « Réessayer » sur un
 * message livré, ou par le refuser sur un message perdu.
 */
const UNREACHED = new Set<string>(UNREACHED_SEND_STATUSES);

/** Le motif de pastille que « Réessayer l'envoi » répare — et le seul. */
const SEND_FAILED_REASON = "send_failed";

/**
 * « Réessayer l'envoi » — renvoyer un texto qui n'a jamais atteint le client.
 *
 * Le geste n'existe que parce qu'on corrige la fiche AVANT de le presser : on
 * lit « Numéro inexistant · code 30005 » dans les Échecs, on va rectifier le
 * téléphone du contact, puis on revient. D'où la seule chose qui compte ici :
 * la destination est relue sur `clients.phone` tel qu'il est MAINTENANT, jamais
 * reprise du `to` de l'ancien job. Rejouer la charge d'origine renverrait
 * fidèlement le message au numéro qui vient d'échouer — donc pour rien, et
 * c'est vrai de tous les codes qu'on propose quand même de réessayer (filtré,
 * désabonné, inexistant).
 *
 * Écrire à un client reste écrire à un client : `conversations.reply` comme
 * plafond, la case `sms` de la fiche comme robinet. Ce n'est qu'une variante de
 * l'envoi manuel — le texte est déjà rédigé, voilà toute la différence. Le
 * renvoi part donc comme un envoi HUMAIN (`source: "human"`, `automated:
 * false`) : c'est une personne qui a décidé, à cette heure-ci, que ce message
 * devait repartir ; ni les heures de politesse ni la pause IA n'ont à trancher
 * pour elle.
 *
 * La rangée en échec, elle, n'est pas touchée : elle EST la preuve que la
 * première tentative a échoué et la délivrabilité la compte toujours. Elle est
 * seulement ÉCARTÉE de la vue « Échecs », dans la même transaction que la mise
 * en file — l'écran ne doit pas continuer de réclamer un geste qu'on vient de
 * faire, et il doit continuer de le réclamer si la mise en file échoue.
 */
export async function retryFailedSmsAction(messageId: string): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.reply")) return FORBIDDEN;
  if (!z.uuid().safeParse(messageId).success) return INVALID;

  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) return NOT_FOUND;
  if (message.direction !== "out") return INVALID;

  // Le fil d'origine décide de l'accès, et une fiche cachée répond
  // « introuvable » : connaître l'identifiant d'un message ne doit pas suffire
  // à faire partir un texto vers une fiche qu'on ne voit pas.
  const seen = await threadFor(actor, message.conversationId, "sms");
  if (!seen) return NOT_FOUND;
  const origin = seen.thread;

  // Refuser de « réessayer » un message ARRIVÉ : ce bouton fait relire un texte
  // à une vraie personne. Aux statuts d'échec s'ajoute le motif de saut — un
  // envoi retenu par une garde (interrupteur, plafond du jour) ne porte pas de
  // statut d'échec, mais il n'est jamais parti non plus.
  const unreached = UNREACHED.has(message.status ?? "") || Boolean(message.skipReason);
  if (!unreached) return INVALID;

  // Déjà écarté : ou bien ce renvoi a DÉJÀ été fait, ou bien quelqu'un a retiré
  // la rangée. Dans les deux cas l'écran qui l'affiche encore est périmé, et on
  // répond « introuvable » — le mot qui fait rafraîchir la boîte au lieu
  // d'expédier un second texto. Le vrai verrou est plus bas, dans la
  // transaction ; celui-ci épargne le travail au cas ordinaire.
  if (message.dismissedAt) return NOT_FOUND;

  const client = await db.query.clients.findFirst({ where: eq(clients.id, origin.clientId) });
  if (!client) return NOT_FOUND;
  // Le numéro d'AUJOURD'HUI. Sans lui, il n'y a rien à réessayer : on le dit
  // plutôt que de mettre en file un envoi sans destination.
  const phone = client.phone;
  if (!phone) return INVALID;

  // Le désabonnement est absolu — même à la main, même après correction du
  // numéro. Vérifié ici en plus du garde d'envoi : refuser dans l'écran vaut
  // mieux que mettre en file un message qui sera jeté sans que personne ne le
  // voie.
  const suppressed = await db.query.suppressions.findFirst({
    where: (s, { eq: e }) => e(s.phoneE164, phone),
  });
  if (suppressed) return { ok: false, error: "suppressed" };

  // Le fil qui parle à ce numéro-LÀ — pas forcément celui de l'échec. Si le
  // téléphone de la fiche a été corrigé, l'ancien fil s'adresse à l'ancien
  // numéro et la réponse du client n'y reviendrait jamais (les entrants sont
  // rattachés par `clientPhone`). Même résolution que l'envoi manuel, pour que
  // les deux gestes ne créent jamais deux fils concurrents.
  const existing = await db.query.conversations.findFirst({
    where: eq(conversations.clientPhone, phone),
    orderBy: [desc(conversations.lastInboundAt), desc(conversations.createdAt)],
  });
  const number = existing
    ? await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.id, existing.smsNumberId) })
    : // Aucun fil pour ce numéro : on garde l'EXPÉDITEUR du fil d'origine tant
      // qu'il est actif — le contact a déjà reçu de lui, changer d'expéditeur
      // sans raison ferait passer le renvoi pour un inconnu.
      ((await db.query.smsNumbers.findFirst({
        where: and(eq(smsNumbers.id, origin.smsNumberId), eq(smsNumbers.active, true)),
      })) ?? (await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.active, true) })));
  if (!number) return { ok: false, error: "noNumber" };

  const targetId = await db.transaction(async (tx) => {
    // ── LE VERROU, et il vient en premier ────────────────────────────────
    // Cette rangée est le JETON du geste : `where dismissedAt is null` ne le
    // rend qu'une fois, et seul celui qui l'obtient a le droit de mettre en
    // file. Sans lui, deux téléphonistes devant la même rangée — ou un onglet
    // resté ouvert derrière un autre, ou un cellulaire dont la réponse s'est
    // perdue et qu'on represse — expédient DEUX textos identiques au même
    // contact, facturés deux fois, et sur un fil de campagne c'est exactement
    // ce qui fait répondre STOP.
    //
    // Aucune autre garde ne ferme cette porte : l'index unique `messages.job_id`
    // n'empêche qu'une reprise du MÊME job de rappeler Twilio, et deux jobs sont
    // deux textos. `disabled={pending}` ne protège que l'onglet qui a cliqué.
    //
    // Écarter DANS la transaction du renvoi tient l'autre bout : si la mise en
    // file est annulée, l'échec reste affiché. L'inverse — un écran vidé sans
    // renvoi — serait la seule panne que personne ne rattraperait, puisque plus
    // rien ne la montrerait. La rangée, elle, reste dans le fil du client.
    const claimed = await tx
      .update(messages)
      .set({ dismissedAt: new Date(), dismissedById: actor.user.id })
      .where(and(eq(messages.id, messageId), isNull(messages.dismissedAt)))
      .returning({ id: messages.id });
    if (claimed.length === 0) return null;

    await tx
      .insert(conversations)
      .values({ clientId: client.id, clientPhone: phone, smsNumberId: number.id })
      .onConflictDoNothing();
    const thread = await tx.query.conversations.findFirst({
      where: and(eq(conversations.clientPhone, phone), eq(conversations.smsNumberId, number.id)),
    });
    if (!thread) throw new Error("conversation_upsert_failed");

    await enqueueJob(
      {
        type: "send_sms",
        runAt: new Date(),
        payload: {
          conversationId: thread.id,
          to: phone,
          body: message.body,
          source: "human",
          automated: false,
          aiGenerated: false,
          sentById: actor.user.id,
        },
        // Aucune clé de dédoublonnage, à dessein : une clé stable ferait
        // ABSORBER le renvoi par le job vivant qui vient d'échouer — le bouton
        // ne ferait rien en annonçant le contraire. Ce qui empêche le double
        // envoi n'est pas ici mais plus haut : le jeton `dismissedAt`, qui ne
        // se prend qu'une fois.
      },
      tx,
    );

    // La pastille que CE geste répare, et elle seule : on ne retire pas un
    // « Nouveau message » qui attend encore un humain sous prétexte qu'un vieil
    // envoi vient de repartir. Si le renvoi échoue à son tour, le job la
    // remettra.
    await tx
      .update(conversations)
      .set({ needsAttention: false, attentionReason: null })
      .where(
        and(
          inArray(conversations.id, [...new Set([origin.id, thread.id])]),
          eq(conversations.attentionReason, SEND_FAILED_REASON),
        ),
      );

    return thread.id;
  });

  // Le jeton était déjà pris : quelqu'un d'autre a renvoyé ce texto pendant
  // qu'on regardait la rangée. « Introuvable » fait rafraîchir l'écran, qui
  // cessera de proposer un geste déjà fait — et rien n'est journalisé ni mis en
  // file, puisque rien n'a eu lieu.
  if (!targetId) return NOT_FOUND;

  await logAudit({
    userId: actor.user.id,
    action: "sms.retry_send",
    entity: "conversation",
    entityId: targetId,
    detail: { messageId, clientId: client.id },
  });
  // Chemin rapide : le renvoi part dans les secondes, sans attendre le cron.
  kickDispatch();
  revalidateFor(client.id);
  return { ok: true, id: targetId };
}

/**
 * « Abandonner » — cette tâche morte cesse de réclamer une réparation.
 *
 * La vue « Tâches du moteur » n'avait qu'une sortie : « Réessayer », et
 * seulement pour un tour d'assistant. Tout le reste — une note d'appel coupée,
 * un barreau de campagne dont l'inscription a disparu, et surtout les cent
 * soixante-quatorze tours morts d'une panne de modèle du 25 août — restait là
 * pour toujours. Une liste qu'on ne peut pas finir cesse d'être regardée, et le
 * compteur de la bande d'état finit par annoncer l'histoire ancienne comme une
 * urgence du jour.
 *
 * Ce que ce geste dit exactement : « j'ai vu, on ne rejouera pas ». La tâche
 * passe de `failed` à `cancelled` — le vocabulaire que la file emploie déjà
 * pour un travail qu'un humain a retiré (voir `cancelPendingJobs`). Elle n'est
 * pas EFFACÉE : la rangée reste, avec sa charge utile et son message d'erreur,
 * pour qui voudra comprendre plus tard ce qui est tombé cette nuit-là.
 *
 * `admin.settings`, comme la vue elle-même : une tâche est une rangée du
 * MOTEUR, pas une fiche. Elle n'appartient à personne et ne se filtre pas par
 * la visibilité (règle 13, chemins machine) — c'est justement pourquoi le droit
 * qui l'ouvre est celui qui conduit le moteur, et pas celui qui répond aux
 * clients.
 */
export async function dismissFailedJobAction(jobId: string): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("admin.settings")) return FORBIDDEN;
  if (!z.uuid().safeParse(jobId).success) return INVALID;

  // `where status = 'failed'` porte l'idempotence ET la garde : on n'annule pas
  // un travail qui attend encore son heure ou qui tourne en ce moment — seul
  // ce qui est DÉFINITIVEMENT tombé s'abandonne.
  const [dropped] = await db
    .update(scheduledJobs)
    .set({ status: "cancelled" })
    .where(and(eq(scheduledJobs.id, jobId), eq(scheduledJobs.status, "failed")))
    .returning({ id: scheduledJobs.id, type: scheduledJobs.type });
  if (!dropped) return NOT_FOUND;

  await logAudit({
    userId: actor.user.id,
    action: "sms.dismiss_job",
    entity: "job",
    entityId: jobId,
    detail: { type: dropped.type },
  });

  revalidatePath("/conversations");
  return { ok: true, id: jobId };
}

/**
 * « Tout abandonner » — la même décision, sur la pile entière.
 *
 * Cent soixante-quatorze rangées d'une seule nuit de panne ne se retirent pas
 * une par une : personne ne le ferait, et c'est ainsi qu'un compteur devient
 * du décor. Le geste porte donc sur TOUT ce qui est en échec, et le compte rendu
 * dit ce qui a RÉELLEMENT été abandonné — jamais ce qu'on a demandé.
 *
 * Volontairement sans liste d'identifiants, contrairement à « Tout clore » :
 * là-bas on ferme les fils AFFICHÉS (la vue est bornée par la visibilité des
 * fiches, et vider ce qu'on voit est la promesse qu'on tient). Ici la liste est
 * bornée aux cent plus récentes pour des raisons d'écran seulement, alors que
 * le nombre annoncé par la bande est celui de TOUTES : n'abandonner que les
 * cent affichées laisserait le compteur à soixante-quatorze sans que personne
 * ne comprenne pourquoi.
 */
export async function dismissAllFailedJobsAction(): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("admin.settings")) return FORBIDDEN;

  const dropped = await db
    .update(scheduledJobs)
    .set({ status: "cancelled" })
    .where(eq(scheduledJobs.status, "failed"))
    .returning({ id: scheduledJobs.id });

  await logAudit({
    userId: actor.user.id,
    action: "sms.dismiss_jobs_bulk",
    entity: "job",
    detail: { count: dropped.length },
  });

  revalidatePath("/conversations");
  return { ok: true, closed: dropped.length };
}

/**
 * « Retirer » — l'échec sort de la vue, et RIEN n'est détruit.
 *
 * Ce que ce bouton ne fait pas mérite d'être écrit en toutes lettres, parce que
 * son libellé laisse craindre le contraire : le message reste dans le fil du
 * client, il compte toujours dans /admin/deliverability, son code d'erreur et
 * son texte sont intacts. On range un écran qu'on relit chaque matin, on
 * n'efface pas la preuve d'une panne — c'est précisément pour cela que
 * « Retirer » existe plutôt qu'une suppression : sans cette colonne, la seule
 * façon de faire disparaître un envoi perdu de la vue était de l'effacer pour
 * de bon, et avec lui ce qu'il apprenait sur la délivrabilité.
 *
 * C'est ARCHIVER, de la même nature que « Marquer traité » : l'échec quitte la
 * vue de TOUT LE MONDE, pas seulement celle de qui a cliqué. D'où
 * `conversations.control` et non `conversations.reply` — décider que plus
 * personne n'a à regarder cet envoi perdu n'est pas une décision privée. Et
 * par-dessus, la case `sms` de la fiche : ce qu'on range est ce qui a été dit,
 * ou n'a pas pu l'être, à ce client-là.
 *
 * Idempotent : retirer deux fois (deux onglets, un clic répété) répond « fait »
 * sans réécrire qui l'a écarté ni quand.
 */
export async function dismissFailedSmsAction(messageId: string): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("conversations.control")) return FORBIDDEN;
  if (!z.uuid().safeParse(messageId).success) return INVALID;

  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) return NOT_FOUND;
  if (message.direction !== "out") return INVALID;

  const seen = await threadFor(actor, message.conversationId, "sms");
  if (!seen) return NOT_FOUND;

  // Déjà écarté : c'est fait, et on ne réécrit pas la signature du premier.
  // Jugé AVANT la question de l'échec, parce qu'un statut peut changer après
  // coup (une réconciliation Twilio qui repasse « unknown » en « delivered ») —
  // un geste déjà accompli ne doit pas se mettre à répondre « impossible ».
  if (message.dismissedAt) return { ok: true, id: messageId };

  // On n'écarte que ce que la vue MONTRE. Écarter un message livré n'aurait
  // aucun effet visible et laisserait une colonne qui ment sur ce qu'elle dit.
  const unreached = UNREACHED.has(message.status ?? "") || Boolean(message.skipReason);
  if (!unreached) return INVALID;

  await db
    .update(messages)
    .set({ dismissedAt: new Date(), dismissedById: actor.user.id })
    .where(and(eq(messages.id, messageId), isNull(messages.dismissedAt)));

  await logAudit({
    userId: actor.user.id,
    action: "sms.dismiss_failure",
    entity: "conversation",
    entityId: message.conversationId,
    detail: {
      messageId,
      clientId: seen.thread.clientId,
      status: message.status,
      errorCode: message.errorCode,
    },
  });

  revalidateFor(seen.thread.clientId);
  return { ok: true, id: messageId };
}

/**
 * « Rétablir » — rouvrir une ligne que ce CRM s'était fermée à LUI-MÊME.
 *
 * La bande d'état annonçait « 23 désabonnés » et aucun écran ne les montrait.
 * En production, cinq seulement avaient dit STOP : les dix-huit autres portent
 * la raison `carrier_error`, écrite par NOTRE moteur après un refus de
 * l'opérateur (`HARD_FAILURE_CODES`, dans `@/lib/sms/status`). Le code 30003 y
 * figure, et 30003 veut dire « appareil éteint ou hors de portée » — la
 * contradiction C7 de `@/lib/deliverability/error-classes` le dit depuis
 * longtemps. Autrement dit : des gens dont le cellulaire était fermé UNE fois
 * sont devenus injoignables pour toujours, sans que personne ne l'ait décidé.
 * Cette action est la porte de sortie ; sans elle, la seule issue était
 * d'effacer une rangée à la main dans la base de production.
 *
 * Ce qui ne se lève PAS : le STOP. La règle 12 le tient pour absolu, et seul
 * un START venant du contact rouvre cette ligne-là. L'écran cache déjà le
 * bouton sur ces rangées — mais un écran ne garde rien, et c'est la
 * vérification d'ici qui tient, y compris devant un appel fabriqué à la main.
 *
 * La porte est `admin.settings`, le même droit que la bande d'état qui compte
 * ces numéros : décider que cette entreprise peut de nouveau écrire à
 * quelqu'un est une conduite de MOTEUR, pas un geste de fil. Et il n'y a pas
 * de case de fiche à ouvrir en plus, parce qu'il n'y a pas de fiche : une
 * suppression est une clé de TÉLÉPHONE, écrite pour survivre à l'effacement et
 * à la ré-importation du client (voir le commentaire de la table). Un numéro
 * masqué par la case « contact » ne fait donc pas l'aller-retour : normalisé,
 * il ne correspond à aucune rangée et la réponse est « introuvable » — la
 * bonne réponse, un « interdit » confirmerait ce que l'écran masque.
 *
 * ── Rétablir ne suffit pas à rendre la personne joignable ──────────────────
 * Deux autres verrous vivent ailleurs, et cet écran n'y touche pas :
 *  · `clients.doNotCall` — coché depuis la fiche, ou par une disposition
 *    d'après-appel. Il vaut pour la voix, et pour le SMS dès qu'une campagne
 *    coche `excludeDoNotCall` (vrai par défaut) : la fiche restera hors
 *    campagne tant que la case est mise, ligne rétablie ou non. La décocher
 *    est une décision de la FICHE — on ne bascule pas en silence, depuis la
 *    boîte de réception, une case que quelqu'un a mise en raccrochant.
 *  · l'interrupteur général d'envoi (`sms.killSwitch`), qui ne connaît ni les
 *    numéros ni les fiches.
 * Un envoi manuel et l'assistant, eux, repartent dès la rangée effacée.
 */
export async function liftSuppressionAction(phoneE164: string): Promise<SmsActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("admin.settings")) return FORBIDDEN;

  // Règle 3 : rien n'entre dans un `where` sans passer par la normalisation.
  // La clé de la table EST l'E.164 ; comparer la chaîne reçue telle quelle
  // ferait échouer « (418) 476-1542 » sur une rangée qui existe pourtant.
  const phone = normalizePhone(phoneE164);
  if (!phone) return INVALID;

  const row = await db.query.suppressions.findFirst({
    where: eq(suppressions.phoneE164, phone),
  });
  // Rangée absente : ou bien elle vient d'être levée par quelqu'un d'autre, ou
  // bien ce numéro n'a jamais été bloqué. Dans les deux cas l'écran est périmé.
  if (!row) return NOT_FOUND;

  if (row.reason === "sms_stop") return { ok: false, error: "stopIsAbsolute" };

  // Un STOP peut se cacher DERRIÈRE une autre raison. `suppress()` écrit avec
  // `onConflictDoNothing` : la PREMIÈRE raison consignée reste, donc un contact
  // déjà supprimé pour `carrier_error` qui répond STOP ensuite laisse une
  // rangée qui dit « carrier_error ». Lire la raison ne suffit donc pas à
  // conclure que personne n'a rien demandé — on relit ce que le contact a
  // vraiment écrit, avec la MÊME détection que le webhook entrant (mot-clé
  // exact sur le message entier : « stop it please » n'en est pas un). L'écran
  // ne peut pas deviner ce cas-là et proposera son bouton : c'est précisément
  // pourquoi le refus existe et pourquoi son message parle du CONTACT, pas de
  // la raison inscrite dans la rangée.
  const inbound = await db
    .select({ body: messages.body })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.clientPhone, phone), eq(messages.direction, "in")));
  if (inbound.some((m) => detectOptOut(m.body).optOut)) {
    return { ok: false, error: "stopIsAbsolute" };
  }

  // La condition est REDITE dans le `where` de l'effacement, et c'est elle qui
  // tient vraiment : entre la lecture ci-dessus et cette ligne, la rangée peut
  // avoir changé de main. Aucun chemin de ce fichier ne peut effacer un STOP.
  // `returning` sert au journal : la raison et la note (« code 30003 ») sont la
  // seule preuve de ce qu'on défait, et elles partent avec la rangée.
  const [lifted] = await db
    .delete(suppressions)
    .where(and(eq(suppressions.phoneE164, phone), ne(suppressions.reason, "sms_stop")))
    .returning({ reason: suppressions.reason, note: suppressions.note });
  // Zéro rangée effacée alors qu'on venait d'en lire une : quelqu'un est passé
  // avant nous. On ne prétend pas avoir rétabli ce qu'un autre a rétabli.
  if (!lifted) return NOT_FOUND;

  await logAudit({
    userId: actor.user.id,
    action: "sms.lift_suppression",
    entity: "suppression",
    entityId: phone,
    // Le numéro est écrit EN ENTIER, contrairement à `sms.carrier_suppression`
    // qui le masque : là-bas, la rangée `suppressions` restait la référence.
    // Ici, c'est justement cette rangée qu'on détruit — masquer ne protégerait
    // personne et effacerait la trace de la ligne qu'on vient de rouvrir.
    detail: { phoneE164: phone, reason: lifted.reason, note: lifted.note },
  });

  revalidatePath("/conversations");
  return { ok: true };
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
