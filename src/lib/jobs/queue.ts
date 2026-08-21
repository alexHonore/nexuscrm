import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { scheduledJobs } from "@/db/schema-sms";
import { MAX_ATTEMPTS, RETRY_BACKOFF_MS, type ScheduledJob } from "./types";

/** `db` ou une transaction en cours — meme surface pour nos besoins. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Durable queue core — the storage layer every dispatcher cycle goes through.
 * Invariant: two concurrent dispatchers can NEVER claim the same job
 * (claimDueJobs uses FOR UPDATE SKIP LOCKED inside one transaction, which the
 * transaction pooler supports — no session state, no prepared statements).
 */

export interface EnqueueJobInput {
  type: string;
  runAt: Date;
  payload: unknown;
  dedupeKey?: string;
}

/**
 * Insert a job. With a dedupeKey, this is the debounce primitive: re-enqueueing
 * the same key while a job with that key is still ALIVE (pending/running —
 * l'index unique partiel scheduled_jobs_dedupe_live_uq) absorbs the call; a
 * pending job gets its runAt/payload refreshed (typically pushed later), a
 * running one is left untouched. A settled or cancelled job has RELEASED its
 * key: the same enqueue then creates a fresh job — sans quoi l'interrupteur
 * d'arrêt empoisonnerait pour toujours les clés stables des relances.
 */
export async function enqueueJob(
  input: EnqueueJobInput,
  /**
   * Executeur : passer la transaction en cours quand la mise en file doit
   * VIVRE OU MOURIR avec elle. Un tour d'agent en depend — une mise en file
   * validee hors transaction survivrait a un rollback, et le client recevrait
   * une reponse dont l'etat a ete annule (puis une deuxieme a la reprise).
   */
  executor: Executor = db,
): Promise<{ id: string; deduped: boolean }> {
  if (input.dedupeKey === undefined) {
    const [row] = await executor
      .insert(scheduledJobs)
      .values({ type: input.type, runAt: input.runAt, payload: input.payload })
      .returning({ id: scheduledJobs.id });
    return { id: row.id, deduped: false };
  }

  // Pre-generated id: on conflict the existing row keeps its own id, which is
  // how we know the insert was absorbed rather than created.
  const freshId = crypto.randomUUID();
  const [row] = await executor
    .insert(scheduledJobs)
    .values({
      id: freshId,
      type: input.type,
      runAt: input.runAt,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoUpdate({
      target: scheduledJobs.dedupeKey,
      // Arbitre = l'index unique PARTIEL : seuls les jobs vivants entrent en
      // conflit (le prédicat doit répéter celui de l'index).
      targetWhere: sql`${scheduledJobs.status} in ('pending', 'running')`,
      // Refresh only while the existing job is still claimable — a running job
      // keeps its runAt/payload untouched.
      set: {
        runAt: sql`case when ${scheduledJobs.status} = 'pending' then excluded.run_at else ${scheduledJobs.runAt} end`,
        payload: sql`case when ${scheduledJobs.status} = 'pending' then excluded.payload else ${scheduledJobs.payload} end`,
      },
    })
    .returning({ id: scheduledJobs.id });
  return { id: row.id, deduped: row.id !== freshId };
}

/**
 * Atomically claim up to `limit` due jobs: SELECT … FOR UPDATE SKIP LOCKED then
 * mark them running (attempts is incremented HERE, at claim time). Rows locked
 * by a concurrent claimer are skipped, never awaited — the two result sets are
 * always disjoint.
 */
export async function claimDueJobs(limit = 50, now: Date = new Date()): Promise<ScheduledJob[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: scheduledJobs.id })
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.status, "pending"), lte(scheduledJobs.runAt, now)))
      .orderBy(asc(scheduledJobs.runAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];

    const claimed = await tx
      .update(scheduledJobs)
      .set({
        status: "running",
        lockedAt: now,
        attempts: sql`${scheduledJobs.attempts} + 1`,
      })
      .where(
        inArray(
          scheduledJobs.id,
          due.map((r) => r.id),
        ),
      )
      .returning();
    // RETURNING order is unspecified — hand jobs back in due order.
    return claimed.sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
  });
}

/**
 * Settle a claimed job: `done`, or `skipped` with the reason in lastError.
 * The `status = 'running'` fence (also on reschedule/fail below) keeps a
 * zombie executor from settling a job a second dispatcher has re-claimed.
 */
export async function completeJob(id: string, outcome: "done" | "skipped", note?: string): Promise<void> {
  await db
    .update(scheduledJobs)
    .set({ status: outcome, lastError: note ?? null, lockedAt: null })
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, "running")));
}

/**
 * Put a claimed job back for later (quiet hours, debounce). Not a failure:
 * the attempt consumed at claim time is refunded so a deferral never burns a
 * retry.
 */
export async function rescheduleJob(id: string, runAt: Date): Promise<void> {
  await db
    .update(scheduledJobs)
    .set({
      status: "pending",
      runAt,
      lockedAt: null,
      attempts: sql`greatest(${scheduledJobs.attempts} - 1, 0)`,
    })
    .where(and(eq(scheduledJobs.id, id), eq(scheduledJobs.status, "running")));
}

/**
 * Record a failed execution: retry with backoff (1 min / 5 min / 30 min) until
 * the claim that just failed was the MAX_ATTEMPTSth — then the failure is
 * permanent. `job.attempts` already counts the current claim.
 */
export async function failJob(job: ScheduledJob, error: string, now: Date = new Date()): Promise<void> {
  if (job.attempts >= MAX_ATTEMPTS) {
    await db
      .update(scheduledJobs)
      .set({ status: "failed", lastError: error, lockedAt: null })
      .where(and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, "running")));
    return;
  }
  const backoffIndex = Math.min(Math.max(job.attempts - 1, 0), RETRY_BACKOFF_MS.length - 1);
  await db
    .update(scheduledJobs)
    .set({
      status: "pending",
      runAt: new Date(now.getTime() + RETRY_BACKOFF_MS[backoffIndex]),
      lastError: error,
      lockedAt: null,
    })
    .where(and(eq(scheduledJobs.id, job.id), eq(scheduledJobs.status, "running")));
}

/**
 * Cancel pending jobs matching the filter (kill switch: all pending send_sms;
 * conversation pause: every job of one thread). Running jobs are left alone —
 * their handler observes the pause/kill switch itself. Returns the count.
 */
export async function cancelPendingJobs(filter: {
  types?: string[];
  conversationId?: string;
}): Promise<number> {
  const conditions = [eq(scheduledJobs.status, "pending")];
  if (filter.types !== undefined) {
    if (filter.types.length === 0) return 0;
    conditions.push(inArray(scheduledJobs.type, filter.types));
  }
  if (filter.conversationId !== undefined) {
    conditions.push(sql`${scheduledJobs.payload}->>'conversationId' = ${filter.conversationId}`);
  }
  const cancelled = await db
    .update(scheduledJobs)
    .set({ status: "cancelled" })
    .where(and(...conditions))
    .returning({ id: scheduledJobs.id });
  return cancelled.length;
}

/**
 * Crash recovery, run at the start of each dispatcher cycle: a job stuck in
 * `running` longer than `olderThanMs` belonged to a dispatcher that died —
 * put it back in the pool. A job whose claims already reached MAX_ATTEMPTS is
 * settled `failed` instead (un job qui TUE son exécuteur ne passe jamais par
 * failJob — sans ce plafond il serait ravivé pour toujours). Returns how many
 * were revived (excludes the ones settled failed).
 */
export async function requeueStaleJobs(olderThanMs = 10 * 60_000, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = await db
    .update(scheduledJobs)
    .set({
      status: sql`case when ${scheduledJobs.attempts} >= ${MAX_ATTEMPTS} then 'failed' else 'pending' end`,
      lastError: sql`case when ${scheduledJobs.attempts} >= ${MAX_ATTEMPTS} then 'stale_requeue_limit' else ${scheduledJobs.lastError} end`,
      lockedAt: null,
    })
    .where(and(eq(scheduledJobs.status, "running"), lt(scheduledJobs.lockedAt, cutoff)))
    .returning({ status: scheduledJobs.status });
  return rows.filter((r) => r.status === "pending").length;
}
