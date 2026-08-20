import { after } from "next/server";
import { runDispatchCycle } from "./dispatch";

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
      runDispatchCycle({ limit: 10 }).catch((err: unknown) => {
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
