import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduledJobs } from "@/db/schema-sms";
import { handleSendSms } from "./handlers/send-sms";
import {
  claimDueJobs,
  completeJob,
  failJob,
  requeueStaleJobs,
  rescheduleJob,
} from "./queue";
import type { JobHandler, ScheduledJob } from "./types";

/**
 * One dispatcher cycle — the execution layer between the queue (./queue) and
 * the handlers (./handlers/*). Ran by /api/cron/dispatch every minute and by
 * kickDispatch() right after an enqueue. Safe to run concurrently: claims go
 * through FOR UPDATE SKIP LOCKED, so two overlapping cycles never execute the
 * same job.
 */

export interface DispatchCounts {
  claimed: number;
  done: number;
  skipped: number;
  rescheduled: number;
  failed: number;
  requeued: number;
}

/** Terminal failure — no retry, unlike failJob's backoff path. */
async function failPermanently(id: string, error: string): Promise<void> {
  await db
    .update(scheduledJobs)
    .set({ status: "failed", lastError: error, lockedAt: null })
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, "running")));
}

/**
 * Les messages d'erreur Twilio peuvent embarquer le numéro complet du
 * destinataire (ex. 21614 « To number is not a valid mobile number: +1514… ») —
 * masqué avant d'atterrir dans scheduled_jobs.last_error.
 */
function maskPhones(text: string): string {
  return text.replace(/\+?\d{7,15}/g, (m) => `…${m.slice(-4)}`);
}

/** One JSON line per executed job — never the payload (phone numbers, bodies). */
function logExecuted(job: ScheduledJob, outcome: string, ms: number): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      msg: "job.executed",
      jobId: job.id,
      type: job.type,
      outcome,
      ms,
    }),
  );
}

export async function runDispatchCycle(
  opts: { limit?: number; now?: () => Date } = {},
): Promise<DispatchCounts> {
  const now = opts.now ?? (() => new Date());
  // The registry binds the cycle's clock so handlers stay injectable.
  const registry: Record<string, JobHandler> = {
    send_sms: (job) => handleSendSms(job, now),
  };

  const counts: DispatchCounts = {
    claimed: 0,
    done: 0,
    skipped: 0,
    rescheduled: 0,
    failed: 0,
    requeued: 0,
  };

  counts.requeued = await requeueStaleJobs(undefined, now());

  const jobs = await claimDueJobs(opts.limit ?? 50, now());
  counts.claimed = jobs.length;

  for (const job of jobs) {
    const startedMs = Date.now();
    const handler = registry[job.type];
    if (handler === undefined) {
      // No handler will ever succeed on this row — retrying is pointless.
      await failPermanently(job.id, `unknown_job_type: ${job.type}`);
      counts.failed += 1;
      logExecuted(job, "failed_permanent", Date.now() - startedMs);
      continue;
    }

    let outcomeLabel: string;
    try {
      const result = await handler(job);
      outcomeLabel = result.outcome;
      switch (result.outcome) {
        case "done":
          await completeJob(job.id, "done", result.note);
          counts.done += 1;
          break;
        case "skipped":
          await completeJob(job.id, "skipped", result.reason);
          counts.skipped += 1;
          break;
        case "reschedule":
          await rescheduleJob(job.id, result.runAt);
          counts.rescheduled += 1;
          break;
        case "failed_permanent":
          await failPermanently(job.id, maskPhones(result.error));
          counts.failed += 1;
          break;
      }
    } catch (err) {
      // Unexpected throw (transport, database): retry with backoff until
      // MAX_ATTEMPTS, then failJob settles the row as failed.
      await failJob(job, maskPhones(err instanceof Error ? err.message : String(err)), now());
      counts.failed += 1;
      outcomeLabel = "failed";
    }
    logExecuted(job, outcomeLabel, Date.now() - startedMs);
  }

  return counts;
}
