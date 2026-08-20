import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema-sms";
import { sendSmsPayloadSchema, type JobOutcome, type ScheduledJob } from "@/lib/jobs/types";
import { DEFAULT_QUIET_HOURS, isWithinSendWindow, nextSendTime } from "@/lib/sms/quiet-hours";
import { analyzeSms } from "@/lib/sms/segments";
import type { SendResult } from "@/lib/sms/types";
import { getSmsProvider } from "@/lib/sms-server";

/**
 * send_sms job handler — the one path every outbound SMS of the engine takes
 * (opener, ladder, agent, human, system). Guard order matters:
 *
 * 1. payload shape — malformed payloads never retry (failed_permanent);
 * 2. anti-double-send guard — if THIS job's intent row already exists, a
 *    previous claim may have reached Twilio before dying: the transport is
 *    NEVER called again. Assumed direction: better one lost send than one
 *    duplicate (compliance ledger + recipient trust);
 * 3. conversation + AI pause — `automated` sends exit when a human paused the
 *    thread (conversations.aiEnabled = false); human sends do not;
 * 4. quiet hours — AUTOMATED sends outside the window are deferred to the next
 *    opening (reschedule: no send, no attempt burned). A human reply in an
 *    open conversation is not solicitation and is exempt. DEFAULT_QUIET_HOURS
 *    is the floor; campaign-specific windows arrive in phase 6;
 * 5. intent row BEFORE the transport (messages.jobId unique), then the send —
 *    the provider enforces kill switch and suppressions internally;
 * 6. after Twilio accepted (or dry_run), failures in the remaining writes
 *    settle the job `done` with a note — NEVER a retry that would resend.
 *
 * A dry-run send IS recorded as a messages row (status "dry_run") — the thread
 * must show what would have gone out. A transport THROW deletes the intent row
 * and propagates so the dispatcher's backoff can retry: a thrown fetch almost
 * always failed before acceptance (the ambiguous accepted-then-disconnected
 * window is accepted as residual risk, Twilio has no idempotency key).
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
    columns: { id: true },
  });
  if (already) return { outcome: "done", note: "already_recorded" };

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, payload.conversationId),
  });
  if (!conversation) return { outcome: "failed_permanent", error: "conversation_not_found" };
  if (payload.automated && !conversation.aiEnabled) {
    return { outcome: "skipped", reason: "ai_paused" };
  }

  if (payload.automated && !isWithinSendWindow(now(), DEFAULT_QUIET_HOURS)) {
    return { outcome: "reschedule", runAt: nextSendTime(now(), DEFAULT_QUIET_HOURS) };
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
      segments: analysis.segments,
      encoding: analysis.encoding,
    })
    .returning({ id: messages.id });

  let result: SendResult;
  try {
    result = await getSmsProvider().send({
      to: payload.to,
      body: payload.body,
      conversationId: payload.conversationId,
      idempotencyKey: job.dedupeKey ?? job.id,
    });
  } catch (err) {
    await db.delete(messages).where(eq(messages.id, intent.id));
    throw err;
  }

  // Blocked send (suppressed | kill_switch | sandbox_not_allowlisted |
  // invalid_to): the intent row is removed — nothing went out, nothing to show.
  if (!result.sent && result.skippedReason !== "dry_run") {
    await db.delete(messages).where(eq(messages.id, intent.id));
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
  } catch {
    // Twilio a déjà accepté : on règle `done` quand même — la rangée-intention
    // (statut "sending") reste la trace visible du trou d'écriture.
    return { outcome: "done", note: "post_send_write_failed" };
  }

  return { outcome: "done" };
}
