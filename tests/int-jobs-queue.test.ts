/**
 * Intégration — cœur de la file durable (src/lib/jobs/queue.ts).
 *
 * On exerce les vraies fonctions (qui passent par `db` de @/db) sur la base de
 * test locale. L'invariant central : deux dispatchers concurrents ne réclament
 * JAMAIS le même job (FOR UPDATE SKIP LOCKED). Les horloges sont injectées —
 * aucune assertion ne dépend du temps réel.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, resetDb, testDb } from "./helpers/db";
import { scheduledJobs } from "@/db/schema-sms";
import { MAX_ATTEMPTS, RETRY_BACKOFF_MS } from "@/lib/jobs/types";
import {
  cancelPendingJobs,
  claimDueJobs,
  completeJob,
  enqueueJob,
  failJob,
  requeueStaleJobs,
  rescheduleJob,
} from "@/lib/jobs/queue";

const T0 = new Date("2026-08-20T12:00:00.000Z");
const CONV_A = "11111111-1111-1111-1111-111111111111";
const CONV_B = "22222222-2222-2222-2222-222222222222";

function secondsAfter(base: Date, s: number): Date {
  return new Date(base.getTime() + s * 1000);
}

/** Insertion directe (statut/verrou arbitraires) pour préparer un scénario. */
async function seedJob(overrides: Partial<typeof scheduledJobs.$inferInsert> = {}) {
  const [row] = await testDb
    .insert(scheduledJobs)
    .values({
      type: "send_sms",
      runAt: secondsAfter(T0, -60),
      payload: {},
      ...overrides,
    })
    .returning();
  return row;
}

async function getJob(id: string) {
  const [row] = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.id, id));
  return row;
}

describe("file durable des jobs", () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  // ── enqueueJob ─────────────────────────────────────────────────────────────

  describe("enqueueJob", () => {
    it("insère un job pending sans dedupeKey (deux appels = deux rangées)", async () => {
      const first = await enqueueJob({
        type: "send_sms",
        runAt: T0,
        payload: { conversationId: CONV_A },
      });
      const second = await enqueueJob({
        type: "send_sms",
        runAt: T0,
        payload: { conversationId: CONV_A },
      });
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(false);
      expect(first.id).not.toBe(second.id);

      const rows = await testDb.select().from(scheduledJobs);
      expect(rows).toHaveLength(2);
      const row = rows.find((r) => r.id === first.id)!;
      expect(row.status).toBe("pending");
      expect(row.attempts).toBe(0);
      expect(row.runAt.getTime()).toBe(T0.getTime());
      expect(row.payload).toEqual({ conversationId: CONV_A });
      expect(row.dedupeKey).toBeNull();
    });

    it("dedupeKey : un job pending absorbe le rappel (runAt et payload rafraîchis)", async () => {
      const first = await enqueueJob({
        type: "send_sms",
        runAt: T0,
        payload: { n: 1 },
        dedupeKey: "conv:A:debounce",
      });
      const second = await enqueueJob({
        type: "send_sms",
        runAt: secondsAfter(T0, 90),
        payload: { n: 2 },
        dedupeKey: "conv:A:debounce",
      });
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);

      const rows = await testDb.select().from(scheduledJobs);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].runAt.getTime()).toBe(secondsAfter(T0, 90).getTime());
      expect(rows[0].payload).toEqual({ n: 2 });
    });

    it("dedupeKey : un job réglé (done) LIBÈRE sa clé — un nouveau job est créé", async () => {
      const settled = await seedJob({
        dedupeKey: "conv:A:done",
        status: "done",
        runAt: T0,
        payload: { n: 1 },
      });

      const res = await enqueueJob({
        type: "send_sms",
        runAt: secondsAfter(T0, 3600),
        payload: { n: 2 },
        dedupeKey: "conv:A:done",
      });
      expect(res.deduped).toBe(false);
      expect(res.id).not.toBe(settled.id);

      const rows = await testDb.select().from(scheduledJobs);
      expect(rows).toHaveLength(2);
      // L'ancien job réglé n'est pas touché ; le nouveau est bien vivant.
      expect((await getJob(settled.id)).status).toBe("done");
      expect((await getJob(res.id)).status).toBe("pending");
      expect((await getJob(res.id)).payload).toEqual({ n: 2 });
    });

    it("dedupeKey : un job annulé (kill switch) libère sa clé — un ré-enfilement fonctionne", async () => {
      // Scénario interrupteur d'arrêt : annulation, puis reprise du service.
      const [job] = await claimNothingSeed();
      const count = await cancelPendingJobs({ types: ["send_sms"] });
      expect(count).toBe(1);
      expect((await getJob(job.id)).status).toBe("cancelled");

      const res = await enqueueJob({
        type: "send_sms",
        runAt: secondsAfter(T0, 60),
        payload: { n: 2 },
        dedupeKey: "conv:A:ladder:2",
      });
      expect(res.deduped).toBe(false);
      expect(res.id).not.toBe(job.id);
      expect((await getJob(res.id)).status).toBe("pending");
      expect((await getJob(job.id)).status).toBe("cancelled");
    });

    it("dedupeKey : un job running absorbe l'appel SANS être repoussé (contrat phase 4 : à revoir)", async () => {
      const running = await seedJob({
        dedupeKey: "conv:A:turn",
        status: "running",
        lockedAt: T0,
        runAt: T0,
        payload: { n: 1 },
      });

      const res = await enqueueJob({
        type: "send_sms",
        runAt: secondsAfter(T0, 3600),
        payload: { n: 2 },
        dedupeKey: "conv:A:turn",
      });
      expect(res.deduped).toBe(true);
      expect(res.id).toBe(running.id);
      expect((await getJob(running.id)).runAt.getTime()).toBe(T0.getTime());
      expect((await getJob(running.id)).payload).toEqual({ n: 1 });
    });
  });

  /** Prépare un job pending avec la clé stable d'une relance de phase 6. */
  async function claimNothingSeed() {
    return [
      await seedJob({ dedupeKey: "conv:A:ladder:2", runAt: secondsAfter(T0, 600) }),
    ] as const;
  }

  // ── claimDueJobs ───────────────────────────────────────────────────────────

  describe("claimDueJobs", () => {
    it("ne réclame que les jobs dus et pending, et les marque running (attempts+1)", async () => {
      const due = await seedJob({ runAt: secondsAfter(T0, -10) });
      const future = await seedJob({ runAt: secondsAfter(T0, 3600) });
      const done = await seedJob({ runAt: secondsAfter(T0, -10), status: "done" });
      const running = await seedJob({ runAt: secondsAfter(T0, -10), status: "running", lockedAt: T0 });

      const claimed = await claimDueJobs(10, T0);
      expect(claimed.map((j) => j.id)).toEqual([due.id]);
      expect(claimed[0].status).toBe("running");
      expect(claimed[0].attempts).toBe(1);
      expect(claimed[0].lockedAt?.getTime()).toBe(T0.getTime());

      expect((await getJob(future.id)).status).toBe("pending");
      expect((await getJob(done.id)).status).toBe("done");
      expect((await getJob(running.id)).attempts).toBe(0);
    });

    it("respecte la limite et l'ordre runAt croissant", async () => {
      const late = await seedJob({ runAt: secondsAfter(T0, -10) });
      const early = await seedJob({ runAt: secondsAfter(T0, -300) });
      const middle = await seedJob({ runAt: secondsAfter(T0, -60) });

      const claimed = await claimDueJobs(2, T0);
      expect(claimed.map((j) => j.id)).toEqual([early.id, middle.id]);
      expect((await getJob(late.id)).status).toBe("pending");
    });

    it("INVARIANT : deux réclamants concurrents sur 1 job dû — ensembles disjoints, total 1", async () => {
      await seedJob();

      const [a, b] = await Promise.all([claimDueJobs(10), claimDueJobs(10)]);

      expect(a.length + b.length).toBe(1);
      const idsA = new Set(a.map((j) => j.id));
      for (const job of b) expect(idsA.has(job.id)).toBe(false);
    });

    it("INVARIANT : 5 jobs dus, 2 réclamants concurrents — partition sans chevauchement", async () => {
      for (let i = 0; i < 5; i += 1) await seedJob();

      const [a, b] = await Promise.all([claimDueJobs(10), claimDueJobs(10)]);

      const union = [...a, ...b].map((j) => j.id);
      expect(union).toHaveLength(5);
      expect(new Set(union).size).toBe(5);

      const still = await testDb
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.status, "running"));
      expect(still).toHaveLength(5);
      for (const row of still) expect(row.attempts).toBe(1);
    });
  });

  // ── completeJob / rescheduleJob ────────────────────────────────────────────

  describe("completeJob", () => {
    it("done : statut posé, verrou levé, lastError nul", async () => {
      await seedJob();
      const [job] = await claimDueJobs(1, T0);

      await completeJob(job.id, "done");

      const row = await getJob(job.id);
      expect(row.status).toBe("done");
      expect(row.lockedAt).toBeNull();
      expect(row.lastError).toBeNull();
    });

    it("skipped : la raison est consignée dans lastError", async () => {
      await seedJob();
      const [job] = await claimDueJobs(1, T0);

      await completeJob(job.id, "skipped", "conversation_paused");

      const row = await getJob(job.id);
      expect(row.status).toBe("skipped");
      expect(row.lastError).toBe("conversation_paused");
      expect(row.lockedAt).toBeNull();
    });
  });

  describe("rescheduleJob", () => {
    it("remet en pending sans brûler de tentative (attempts - 1)", async () => {
      await seedJob();
      const [job] = await claimDueJobs(1, T0);
      expect(job.attempts).toBe(1);

      const later = secondsAfter(T0, 7200);
      await rescheduleJob(job.id, later);

      const row = await getJob(job.id);
      expect(row.status).toBe("pending");
      expect(row.runAt.getTime()).toBe(later.getTime());
      expect(row.lockedAt).toBeNull();
      expect(row.attempts).toBe(0);
    });

    it("plancher : attempts ne descend jamais sous 0", async () => {
      const job = await seedJob({ status: "running", lockedAt: T0, attempts: 0 });

      await rescheduleJob(job.id, secondsAfter(T0, 60));

      const row = await getJob(job.id);
      expect(row.attempts).toBe(0);
      expect(row.status).toBe("pending");
    });
  });

  // ── failJob ────────────────────────────────────────────────────────────────

  describe("failJob", () => {
    it("progression du backoff 1 min / 5 min / 30 min, puis échec permanent", async () => {
      const seeded = await seedJob({ runAt: secondsAfter(T0, -1) });

      // Tentative 1 → retour pending dans 1 min.
      let [job] = await claimDueJobs(1, T0);
      expect(job.attempts).toBe(1);
      await failJob(job, "boom 1", T0);
      let row = await getJob(seeded.id);
      expect(row.status).toBe("pending");
      expect(row.lastError).toBe("boom 1");
      expect(row.lockedAt).toBeNull();
      expect(row.runAt.getTime() - T0.getTime()).toBe(RETRY_BACKOFF_MS[0]);

      // Tentative 2 → 5 min.
      let clock = secondsAfter(T0, 61);
      [job] = await claimDueJobs(1, clock);
      expect(job.attempts).toBe(2);
      await failJob(job, "boom 2", clock);
      row = await getJob(seeded.id);
      expect(row.status).toBe("pending");
      expect(row.runAt.getTime() - clock.getTime()).toBe(RETRY_BACKOFF_MS[1]);

      // Tentative 3 → 30 min.
      clock = secondsAfter(clock, 301);
      [job] = await claimDueJobs(1, clock);
      expect(job.attempts).toBe(3);
      await failJob(job, "boom 3", clock);
      row = await getJob(seeded.id);
      expect(row.status).toBe("pending");
      expect(row.runAt.getTime() - clock.getTime()).toBe(RETRY_BACKOFF_MS[2]);

      // Tentative 4 (= MAX_ATTEMPTS) → échec permanent.
      clock = secondsAfter(clock, 1801);
      [job] = await claimDueJobs(1, clock);
      expect(job.attempts).toBe(MAX_ATTEMPTS);
      await failJob(job, "boom final", clock);
      row = await getJob(seeded.id);
      expect(row.status).toBe("failed");
      expect(row.lastError).toBe("boom final");

      // Un job failed n'est plus jamais réclamé.
      expect(await claimDueJobs(10, secondsAfter(clock, 86_400))).toHaveLength(0);
    });
  });

  // ── cancelPendingJobs ──────────────────────────────────────────────────────

  describe("cancelPendingJobs", () => {
    it("par type : n'annule que les pending du type demandé", async () => {
      const sendA = await seedJob({ payload: { conversationId: CONV_A } });
      const sendB = await seedJob({ payload: { conversationId: CONV_B } });
      const other = await seedJob({ type: "agent_turn" });
      const running = await seedJob({ status: "running", lockedAt: T0 });
      const done = await seedJob({ status: "done" });

      const count = await cancelPendingJobs({ types: ["send_sms"] });
      expect(count).toBe(2);

      expect((await getJob(sendA.id)).status).toBe("cancelled");
      expect((await getJob(sendB.id)).status).toBe("cancelled");
      expect((await getJob(other.id)).status).toBe("pending");
      expect((await getJob(running.id)).status).toBe("running");
      expect((await getJob(done.id)).status).toBe("done");
    });

    it("par conversationId : filtre sur payload->>'conversationId'", async () => {
      const a1 = await seedJob({ payload: { conversationId: CONV_A } });
      const a2 = await seedJob({ type: "agent_turn", payload: { conversationId: CONV_A } });
      const b = await seedJob({ payload: { conversationId: CONV_B } });
      const noConv = await seedJob({ payload: {} });

      const count = await cancelPendingJobs({ conversationId: CONV_A });
      expect(count).toBe(2);

      expect((await getJob(a1.id)).status).toBe("cancelled");
      expect((await getJob(a2.id)).status).toBe("cancelled");
      expect((await getJob(b.id)).status).toBe("pending");
      expect((await getJob(noConv.id)).status).toBe("pending");
    });

    it("types + conversationId combinés", async () => {
      const match = await seedJob({ payload: { conversationId: CONV_A } });
      const wrongType = await seedJob({ type: "agent_turn", payload: { conversationId: CONV_A } });
      const wrongConv = await seedJob({ payload: { conversationId: CONV_B } });

      const count = await cancelPendingJobs({ types: ["send_sms"], conversationId: CONV_A });
      expect(count).toBe(1);
      expect((await getJob(match.id)).status).toBe("cancelled");
      expect((await getJob(wrongType.id)).status).toBe("pending");
      expect((await getJob(wrongConv.id)).status).toBe("pending");
    });

    it("sans filtre : annule tous les pending, ne touche jamais running/done", async () => {
      await seedJob();
      await seedJob({ type: "agent_turn" });
      const running = await seedJob({ status: "running", lockedAt: T0 });

      const count = await cancelPendingJobs({});
      expect(count).toBe(2);
      expect((await getJob(running.id)).status).toBe("running");
    });
  });

  // ── requeueStaleJobs ───────────────────────────────────────────────────────

  describe("requeueStaleJobs", () => {
    it("ne ravive que les running dont le verrou est périmé", async () => {
      const stale = await seedJob({
        status: "running",
        lockedAt: secondsAfter(T0, -11 * 60),
        attempts: 1,
      });
      const fresh = await seedJob({
        status: "running",
        lockedAt: secondsAfter(T0, -2 * 60),
        attempts: 1,
      });
      const pending = await seedJob({ runAt: secondsAfter(T0, -3600) });
      const done = await seedJob({ status: "done" });

      const count = await requeueStaleJobs(10 * 60_000, T0);
      expect(count).toBe(1);

      const revived = await getJob(stale.id);
      expect(revived.status).toBe("pending");
      expect(revived.lockedAt).toBeNull();
      // La tentative comptée au claim reste comptée (un crash répété converge
      // vers failed).
      expect(revived.attempts).toBe(1);

      expect((await getJob(fresh.id)).status).toBe("running");
      expect((await getJob(pending.id)).status).toBe("pending");
      expect((await getJob(done.id)).status).toBe("done");
    });

    it("plafond : un running périmé ayant épuisé ses tentatives devient failed, pas pending", async () => {
      const exhausted = await seedJob({
        status: "running",
        lockedAt: secondsAfter(T0, -11 * 60),
        attempts: MAX_ATTEMPTS,
      });
      const oneLeft = await seedJob({
        status: "running",
        lockedAt: secondsAfter(T0, -11 * 60),
        attempts: MAX_ATTEMPTS - 1,
      });

      const count = await requeueStaleJobs(10 * 60_000, T0);
      // Seul le job encore sous le plafond est ravivé.
      expect(count).toBe(1);

      const dead = await getJob(exhausted.id);
      expect(dead.status).toBe("failed");
      expect(dead.lastError).toBe("stale_requeue_limit");
      expect((await getJob(oneLeft.id)).status).toBe("pending");
    });

    it("un job ravivé redevient réclamable", async () => {
      await seedJob({
        status: "running",
        lockedAt: secondsAfter(T0, -30 * 60),
        runAt: secondsAfter(T0, -31 * 60),
        attempts: 1,
      });

      await requeueStaleJobs(10 * 60_000, T0);
      const claimed = await claimDueJobs(10, T0);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].attempts).toBe(2);
    });
  });
});
