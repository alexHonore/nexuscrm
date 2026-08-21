import { z } from "zod";
import type { JobOutcome, ScheduledJob } from "@/lib/jobs/types";
import { runTurn } from "@/lib/agent/runtime";

/**
 * Job `agent_turn` — un tour d'agent pour une conversation.
 *
 * Le débounce vit dans la clé de dédoublonnage (`turn:<conversationId>`) posée
 * par le webhook entrant : trois SMS en quatre secondes repoussent le MÊME job
 * au lieu d'en créer trois, donc une seule réponse part. La logique de tour,
 * elle, est dans runtime.ts.
 */

export const agentTurnPayloadSchema = z.object({ conversationId: z.uuid() });

export async function handleAgentTurn(job: ScheduledJob): Promise<JobOutcome> {
  const parsed = agentTurnPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { outcome: "failed_permanent", error: "invalid_payload" };

  const result = await runTurn(parsed.data.conversationId);

  switch (result.outcome) {
    case "sent":
      return { outcome: "done" };
    // Fins légitimes d'un tour : rien à réessayer.
    case "stopped":
    case "handoff":
    case "blocked":
      return { outcome: "done", note: result.reason ?? result.outcome };
    case "skipped_ai_disabled":
      return { outcome: "skipped", reason: "ai_paused" };
    case "skipped_no_inbound":
      return { outcome: "skipped", reason: "no_unprocessed_inbound" };
    case "skipped_no_assistant":
      return { outcome: "skipped", reason: result.reason ?? "no_assistant" };
    case "skipped_superseded":
      // Un tour concurrent a consomme les memes entrants : le notre s'efface.
      return { outcome: "skipped", reason: "superseded" };
    case "error":
      // Panne du fournisseur : la file gère la reprise avec temporisation.
      throw new Error(result.reason ?? "agent_turn_failed");
  }
}
