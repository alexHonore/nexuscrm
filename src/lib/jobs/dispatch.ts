import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentTurnTraces, scheduledJobs } from "@/db/schema-sms";
import { handleAgentTurn } from "./handlers/agent-turn";
import { handleSendSms } from "./handlers/send-sms";
import { handleCampaignTouch } from "./handlers/campaign-touch";
import { handleCallTranscript } from "./handlers/call-transcript";
import { queueDueTouches, sweepDueCampaigns } from "@/lib/campaigns-server/match";
import { reconcileTwilioMessages } from "./reconcile";
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


/**
 * Purge des traces de tours (TRACE_RETENTION_DAYS, defaut 30). Elles
 * contiennent des renseignements personnels : nom, projet, budget, ce que la
 * personne a ecrit. Une retention indefinie serait un passif, pas une
 * fonctionnalite. Best-effort : une purge qui echoue ne doit pas faire tomber
 * le cycle du dispatcher.
 */
async function pruneTraces(now: Date): Promise<void> {
  const days = Number(process.env.TRACE_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    await db.delete(agentTurnTraces).where(lt(agentTurnTraces.createdAt, cutoff));
  } catch {
    // journalise par le cycle appelant ; jamais bloquant
  }
}

/**
 * Battement du répartiteur.
 *
 * Écrit par `jsonb_set` sur la SEULE clé concernée, et non par une lecture
 * suivie d'une écriture : un cycle par minute qui réécrirait tout l'objet
 * pourrait ressusciter un interrupteur d'arrêt qu'un administrateur vient de
 * relever. C'est le contrôle de sécurité le plus important du moteur ; il ne
 * doit pas dépendre d'une course.
 */
/**
 * Les jobs réglés (done / skipped / cancelled / failed) de plus de N jours
 * partent : la table ne doit pas grossir sans fin, et rien ne les relit.
 */
async function pruneSettledJobs(now: Date): Promise<void> {
  const days = Number(process.env.JOB_RETENTION_DAYS ?? 14);
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  try {
    await db
      .delete(scheduledJobs)
      .where(
        and(
          sql`${scheduledJobs.status} in ('done', 'skipped', 'cancelled', 'failed')`,
          lt(scheduledJobs.runAt, cutoff),
        ),
      );
  } catch {
    // Entretien : ne jamais faire échouer un cycle pour ça.
  }
}

async function recordHeartbeat(now: Date): Promise<void> {
  try {
    await db.execute(sql`
      insert into settings (key, value)
      values ('sms', jsonb_build_object('lastDispatchAt', ${now.toISOString()}::text))
      on conflict (key) do update
        set value = jsonb_set(settings.value, '{lastDispatchAt}', to_jsonb(${now.toISOString()}::text))
    `);
  } catch {
    // Un battement manqué ne doit jamais empêcher un cycle de tourner.
  }
}

/**
 * Budget de temps d'un cycle. La fonction Vercel meurt à 300 s ; cinquante
 * tours d'agent avec un modèle lent dépassent ça et laissaient des jobs
 * « running » jusqu'au requeue des dix minutes. On réclame par petits lots et
 * on s'arrête AVANT la limite — le cron de la minute suivante continue.
 */
const CYCLE_BUDGET_MS = Number(process.env.DISPATCH_BUDGET_MS ?? 240_000);
const CLAIM_BATCH = 10;

export async function runDispatchCycle(
  opts: { limit?: number; now?: () => Date; reconcile?: boolean } = {},
): Promise<DispatchCounts> {
  const now = opts.now ?? (() => new Date());
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > CYCLE_BUDGET_MS;
  // The registry binds the cycle's clock so handlers stay injectable.
  const registry: Record<string, JobHandler> = {
    send_sms: (job) => handleSendSms(job, now),
    agent_turn: (job) => handleAgentTurn(job),
    campaign_touch: (job) => handleCampaignTouch(job, now),
    call_transcript: (job) => handleCallTranscript(job),
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
  await pruneTraces(now());
  await pruneSettledJobs(now());
  // Les barreaux dus deviennent des jobs AVANT la réclamation : ils entrent
  // ainsi dans le même cycle, au lieu d'attendre la minute suivante.
  // Les campagnes périodiques d'abord : leurs nouvelles inscriptions entrent
  // dans le même cycle que les barreaux déjà dus.
  await sweepDueCampaigns(now()).catch(() => []);
  await queueDueTouches(200, now()).catch(() => 0);
  // Réconciliation REST avec Twilio (statuts bloqués + entrants perdus) —
  // AVANT la réclamation : un tour d'agent rejoué par le backfill entre ainsi
  // dans le même cycle. Sans configuration REST, elle se désarme toute seule.
  // Le chemin rapide (kickDispatch après un webhook) la SAUTE : il existe pour
  // répondre en secondes, pas pour payer un balayage REST — le cron d'1 minute
  // réconcilie bien assez souvent. Son budget propre (SWEEP_BUDGET_MS) borne
  // ce qu'un Twilio dégradé peut voler au cycle.
  if (opts.reconcile !== false)
    await reconcileTwilioMessages(now)
      .then((r) => {
      if (r.checked > 0 || r.backfilled > 0) {
        console.log(
          JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "twilio.reconcile", ...r }),
        );
      }
    })
    .catch((err: unknown) => {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          msg: "twilio.reconcile_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });

  const limit = opts.limit ?? 50;
  const jobs: ScheduledJob[] = [];
  const runOne = makeJobRunner(registry, counts, now);
  // Réclamer par lots : un lot réclamé est un lot qu'on TRAITERA dans le
  // budget ; réclamer cinquante jobs d'un coup puis mourir à mi-chemin les
  // laissait « running » dix minutes.
  while (jobs.length < limit && !overBudget()) {
    // Les notes d'appel ont leur PROPRE cycle (runTranscriptCycle) : un job
    // audio dure des dizaines de secondes et ferait attendre les SMS clients.
    const batch = await claimDueJobs(Math.min(CLAIM_BATCH, limit - jobs.length), now(), {
      exclude: ["call_transcript"],
    });
    if (batch.length === 0) break;
    jobs.push(...batch);
    for (const job of batch) await runOne(job);
    if (batch.length < CLAIM_BATCH) break;
  }
  counts.claimed = jobs.length;
  // Le battement est écrit APRÈS le travail : un cycle qui plante à la
  // réclamation (base injoignable) ne doit pas afficher « répartiteur en
  // forme » sur la page de mise en service.
  await recordHeartbeat(now());
  return counts;
}

/** Exécute et règle UN job réclamé — partagé entre le cycle SMS et le cycle notes d'appel. */
function makeJobRunner(
  registry: Record<string, JobHandler>,
  counts: DispatchCounts,
  now: () => Date,
): (job: ScheduledJob) => Promise<void> {
  return async function runOne(job: ScheduledJob): Promise<void> {
    const startedMs = Date.now();
    const handler = registry[job.type];
    if (handler === undefined) {
      // No handler will ever succeed on this row — retrying is pointless.
      await failPermanently(job.id, `unknown_job_type: ${job.type}`);
      counts.failed += 1;
      logExecuted(job, "failed_permanent", Date.now() - startedMs);
      return;
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
  };
}

/**
 * Cycle DÉDIÉ aux notes d'appel (`call_transcript`) — hors du cycle SMS.
 *
 * Pourquoi un couloir séparé : un job audio tient des MINUTES d'enregistrement
 * (téléchargement voip.ms + modèle multimodal, jusqu'à ~340 s au pire) là où
 * un envoi SMS tient en secondes. Dans le même couloir, vingt notes d'appel
 * mises en file par la synchronisation CDR passeraient DEVANT les réponses
 * d'assistant aux clients (réclamation stricte par runAt), et un seul job
 * audio pouvait avaler le budget du cycle en laissant neuf SMS co-réclamés
 * bloqués « running » dix minutes.
 *
 * Ici : réclamation UN par UN (une mort en plein vol n'échoue qu'un job), et
 * on ne réclame le suivant que s'il reste assez de budget pour le pire cas.
 */
export async function runTranscriptCycle(
  opts: { limit?: number; now?: () => Date; handler?: JobHandler } = {},
): Promise<DispatchCounts> {
  const now = opts.now ?? (() => new Date());
  const startedAt = Date.now();
  // Le pire job (voip.ms 100 s + téléchargement 60 s + modèle 180 s) doit
  // finir AVANT le plafond de 300 s de la fonction : on ne réclame que si
  // moins de 90 s se sont écoulées — après, on laisse au prochain passage.
  const canClaimMore = () => Date.now() - startedAt < 90_000;
  const registry: Record<string, JobHandler> = {
    call_transcript: opts.handler ?? ((job) => handleCallTranscript(job)),
  };
  const counts: DispatchCounts = {
    claimed: 0,
    done: 0,
    skipped: 0,
    rescheduled: 0,
    failed: 0,
    requeued: 0,
  };
  const runOne = makeJobRunner(registry, counts, now);

  const limit = opts.limit ?? 20;
  while (counts.claimed < limit && canClaimMore()) {
    const batch = await claimDueJobs(1, now(), { only: ["call_transcript"] });
    if (batch.length === 0) break;
    counts.claimed += 1;
    await runOne(batch[0]);
  }
  return counts;
}
