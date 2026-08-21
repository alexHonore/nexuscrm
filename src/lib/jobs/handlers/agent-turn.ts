import { z } from "zod";
import { MAX_ATTEMPTS, type JobOutcome, type ScheduledJob } from "@/lib/jobs/types";
import { runTurn, type TurnOutcome } from "@/lib/agent/runtime";
import { markTouchOutcome } from "@/lib/campaigns-server/touch";

/**
 * Job `agent_turn` — un tour d'agent pour une conversation.
 *
 * Deux déclencheurs, une seule logique de tour (runtime.ts) :
 *
 *  · un SMS ENTRANT — le débounce vit dans la clé `turn:<conversationId>`
 *    posée par le webhook : trois SMS en quatre secondes repoussent le MÊME
 *    job au lieu d'en créer trois, donc une seule réponse part ;
 *
 *  · un barreau de campagne SANS texte (`outreach`) — l'assistant écrit en
 *    premier. Sans ce contexte, le tour ne trouvait aucun entrant à traiter et
 *    se terminait en « skipped » : l'échelle avançait, la trace disait
 *    « queued », et aucun message ne partait jamais. Trouvé en démonstration,
 *    pas par les tests — qui vérifiaient seulement qu'un job était mis en file.
 */

export const agentTurnPayloadSchema = z.object({
  conversationId: z.uuid(),
  outreach: z
    .object({
      enrollmentId: z.uuid(),
      step: z.number().int().min(0),
    })
    .optional(),
});

/** Ce qu'un tour proactif laisse sur la trace du barreau. */
function touchStatusFor(outcome: TurnOutcome): string {
  switch (outcome) {
    case "sent":
      return "sent";
    case "blocked":
      return "blocked";
    case "handoff":
      return "handoff";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    case "skipped_superseded":
      // Le contact a écrit en premier : c'est sa réponse qu'on traite, pas
      // notre ouverture.
      return "superseded";
    default:
      return "skipped";
  }
}

export async function handleAgentTurn(job: ScheduledJob): Promise<JobOutcome> {
  const parsed = agentTurnPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return { outcome: "failed_permanent", error: "invalid_payload" };

  // La file compte les tentatives : à la dernière, une panne du modèle doit
  // consommer les entrants et passer la main au lieu de réessayer dans le vide.
  const result = await runTurn(parsed.data.conversationId, {
    outreach: parsed.data.outreach,
    finalAttempt: job.attempts + 1 >= MAX_ATTEMPTS,
  });

  if (parsed.data.outreach) {
    await markTouchOutcome(
      parsed.data.outreach.enrollmentId,
      parsed.data.outreach.step,
      touchStatusFor(result.outcome),
    );
  }

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
