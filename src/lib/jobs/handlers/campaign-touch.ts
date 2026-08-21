import { z } from "zod";
import type { JobOutcome, ScheduledJob } from "@/lib/jobs/types";
import { runTouch } from "@/lib/campaigns-server/touch";

/**
 * Job `campaign_touch` — envoie un barreau d'échelle.
 *
 * Les refus ne sont PAS des échecs : un désabonnement ou une réponse sont des
 * issues normales. Les traiter comme des erreurs les ferait réessayer trois
 * fois avant de renoncer, et remplirait le journal de fausses pannes.
 */

export const campaignTouchPayloadSchema = z.object({ enrollmentId: z.uuid() });

export async function handleCampaignTouch(
  job: ScheduledJob,
  now: () => Date,
): Promise<JobOutcome> {
  const parsed = campaignTouchPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { outcome: "failed_permanent", error: "invalid_payload" };

  let result;
  try {
    result = await runTouch(parsed.data.enrollmentId, now());
  } catch (err) {
    const message = err instanceof Error ? err.message : "touch_failed";
    // Une inscription ou une campagne supprimée ne reviendra pas : réessayer
    // est certain d'échouer.
    if (message === "enrollment_not_found" || message === "campaign_not_found") {
      return { outcome: "failed_permanent", error: message };
    }
    throw err;
  }

  if (result.sent) return { outcome: "done", note: `step ${result.step}` };
  return { outcome: "skipped", reason: result.refusal ?? "not_sent" };
}
