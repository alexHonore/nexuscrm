import { after } from "next/server";
import { runDispatchCycle, runTranscriptCycle } from "./dispatch";

/**
 * Fast path of the dispatcher: schedule a small cycle right after the current
 * response is sent (next/server `after`), so a job enqueued by a webhook or an
 * action goes out near-instantly instead of waiting for the next cron tick.
 * The 1-minute cron (/api/cron/dispatch) stays the reliable backstop — a lost
 * kick only delays a send, it never drops one.
 *
 * Never throws: outside a request context (script, test, seed) `after` is not
 * available — the kick is silently dropped and the cron picks the job up.
 * Phase 4 wires this into the inbound webhook.
 */
export function kickDispatch(): void {
  try {
    after(() =>
      runDispatchCycle({ limit: 10, reconcile: false }).catch((err: unknown) => {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            msg: "job.kick_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }),
    );
  } catch {
    // hors contexte requête — le cron d'1 minute prendra le relais
  }
}

/**
 * Même chemin rapide pour le couloir des notes d'appel : lancé après la
 * synchronisation CDR qui vient de mettre des jobs `call_transcript` en file.
 * Perdre le coup d'envoi ne perd rien — le cron /api/cron/transcripts et la
 * prochaine synchronisation reprennent ce qui reste.
 */
export function kickTranscripts(): void {
  try {
    after(() =>
      runTranscriptCycle({ limit: 5 }).catch((err: unknown) => {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            msg: "transcripts.kick_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }),
    );
  } catch {
    // hors contexte requête — le cron prendra le relais
  }
}
