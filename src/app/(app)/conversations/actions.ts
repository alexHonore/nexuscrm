"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { conversations, smsNumbers } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/guards";
import { enqueueJob } from "@/lib/jobs/queue";
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
  | { ok: true; id?: string }
  | { ok: false; error: "invalid" | "forbidden" | "notFound" | "suppressed" | "noNumber" };

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

  const number = await db.query.smsNumbers.findFirst({ where: eq(smsNumbers.active, true) });
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

  revalidateFor(client.id);
  return { ok: true, id: conversationId };
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
 * Assigner un fil à quelqu'un. Un téléphoniste peut se l'attribuer ; seul un
 * administrateur peut l'attribuer à AUTRUI — même règle que les fiches clients.
 */
export async function assignConversationAction(input: {
  conversationId: string;
  userId: string | null;
}): Promise<SmsActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.uuid().safeParse(input.conversationId).success) return INVALID;
  if (input.userId !== null && !z.uuid().safeParse(input.userId).success) return INVALID;

  if (user.role !== "admin" && input.userId !== null && input.userId !== user.id) {
    return FORBIDDEN;
  }

  const thread = await db.query.conversations.findFirst({
    where: eq(conversations.id, input.conversationId),
  });
  if (!thread) return NOT_FOUND;

  await db
    .update(conversations)
    .set({ assignedToId: input.userId })
    .where(eq(conversations.id, input.conversationId));

  if (thread.clientId) revalidateFor(thread.clientId);
  else revalidatePath("/conversations");
  return { ok: true, id: input.conversationId };
}

