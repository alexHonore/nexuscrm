import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { campaignTouches, conversations, messages, scheduledJobs } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { sendSmsPayloadSchema } from "@/lib/jobs/types";
import { analyzeSms } from "@/lib/sms/segments";
import { getSetting, setSetting } from "@/lib/settings";

const bodySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Interrupteur d'arrêt global du moteur SMS — admin seulement.
 *
 * Deux mécanismes complémentaires : le réglage `sms.killSwitch` est relu par
 * le fournisseur avant CHAQUE envoi (`settingsSendGate` de
 * `src/lib/sms-server`) et bloque les nouveaux envois ; activer
 * l'interrupteur annule EN PLUS tous les jobs `send_sms` encore en attente
 * dans la file. Ensemble, ils garantissent que l'interrupteur stoppe tout en
 * au plus un cycle du dispatcher. Désactiver ne ressuscite rien : les jobs
 * annulés restent annulés.
 *
 * Annuler ne suffit pas : un envoi en file n'a pas encore de rangée `messages`
 * (elle n'est écrite qu'à l'exécution du job). Le tour d'agent qui l'avait
 * commandé a déjà consommé l'entrant et éteint la pastille ; le barreau de
 * campagne qui l'avait commandé est déjà tracé « envoyé ». Annuler à
 * l'aveugle laissait donc un contact sans réponse et sans signal, et des
 * traces qui mentaient. Chaque annulation laisse maintenant la MÊME empreinte
 * que la porte d'envoi aurait laissée : une rangée « non envoyé —
 * interrupteur » dans le fil, une réponse d'agent coupée remet le fil « à
 * traiter », et le barreau de campagne passe « cancelled ».
 */
export async function POST(req: Request) {
  const auth = await apiAdmin();
  if (auth instanceof NextResponse) return auth;

  const raw: unknown = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { enabled, reason } = parsed.data;

  // Fusion avec l'état courant : le réglage `sms` porte aussi d'autres champs
  // que le basculement de l'interrupteur ne doit pas remettre
  // à leurs défauts.
  const current = await getSetting("sms");
  await setSetting("sms", {
    ...current,
    killSwitch: enabled,
    killSwitchReason: enabled ? (reason ?? null) : null,
    killSwitchAt: enabled ? new Date().toISOString() : null,
  });

  // Les jobs déjà réclamés (`running`) sont laissés au dispatcher : leur
  // handler relit le réglage et refusera l'envoi lui-même.
  const cancelledJobs = enabled ? await cancelPendingSends() : 0;

  await logAudit({
    userId: auth.id,
    action: "sms.kill_switch",
    entity: "settings",
    detail: { enabled, reason: reason ?? null, cancelledJobs },
  });

  return NextResponse.json({ ok: true, enabled, cancelledJobs });
}

/**
 * Annule les `send_sms` en attente et réconcilie ce qu'ils laissent derrière
 * eux. Retourne le nombre de jobs annulés (charges illisibles comprises : le
 * job est annulé quand même, il n'y a juste rien à réconcilier).
 */
async function cancelPendingSends(): Promise<number> {
  const cancelled = await db
    .update(scheduledJobs)
    .set({ status: "cancelled" })
    .where(and(eq(scheduledJobs.status, "pending"), eq(scheduledJobs.type, "send_sms")))
    .returning({ id: scheduledJobs.id, payload: scheduledJobs.payload, dedupeKey: scheduledJobs.dedupeKey });
  if (cancelled.length === 0) return 0;

  const agentThreads = new Set<string>();
  const touchKeys: string[] = [];

  for (const job of cancelled) {
    const payload = sendSmsPayloadSchema.safeParse(job.payload);
    if (!payload.success) continue;
    const p = payload.data;
    const analysis = analyzeSms(p.body);
    // La rangée que `handleSendSms` aurait laissée si la porte l'avait refusé :
    // le téléphoniste voit « non envoyé — interrupteur » au lieu d'un message
    // qui s'évapore. `job_id` est unique : un job qui aurait déjà sa rangée
    // (impossible pour un job encore « pending », mais sûr) n'en reçoit pas une
    // seconde.
    await db
      .insert(messages)
      .values({
        conversationId: p.conversationId,
        direction: "out",
        body: p.body,
        jobId: job.id,
        status: "skipped",
        skipReason: "kill_switch",
        source: p.source,
        aiGenerated: p.aiGenerated,
        sentById: p.sentById,
        assistantId: p.assistantId,
        assistantVersion: p.assistantVersion,
        model: p.model,
        segments: analysis.segments,
        encoding: analysis.encoding,
      })
      .onConflictDoNothing({ target: messages.jobId });
    // Une réponse d'agent coupée : le tour a consommé l'entrant et éteint la
    // pastille — la personne attend une réponse qui ne viendra pas. Le fil
    // revient « à traiter », avec le motif qu'un envoi en échec porte déjà.
    if (p.source === "agent") agentThreads.add(p.conversationId);
    if (job.dedupeKey?.startsWith("csend:")) touchKeys.push(job.dedupeKey);
  }

  if (agentThreads.size > 0) {
    await db
      .update(conversations)
      .set({ needsAttention: true, attentionReason: "send_failed" })
      .where(inArray(conversations.id, [...agentThreads]));
  }

  // Le barreau était tracé « envoyé » dans la transaction qui a mis l'envoi en
  // file (`csend:<inscription>:<barreau>`) : sans ce passage, la trace ment —
  // c'est précisément pourquoi l'archivage n'annule jamais un `csend:`.
  for (const key of touchKeys) {
    const [, enrollmentId, stepText] = key.split(":");
    const step = Number(stepText);
    if (!z.uuid().safeParse(enrollmentId).success || !Number.isInteger(step)) continue;
    await db
      .update(campaignTouches)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(campaignTouches.enrollmentId, enrollmentId),
          eq(campaignTouches.step, step),
          eq(campaignTouches.status, "sent"),
        ),
      );
  }

  return cancelled.length;
}
