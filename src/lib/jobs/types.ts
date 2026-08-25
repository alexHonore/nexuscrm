import { z } from "zod";
import type { scheduledJobs } from "@/db/schema-sms";

/**
 * Shared contracts of the durable job queue. One queue for the whole SMS
 * engine — new job types register a payload schema here and a handler in
 * src/lib/jobs/handlers/. (Unlike src/lib/sms, this module is allowed to know
 * Drizzle: the queue is inherently database-shaped.)
 */

export type ScheduledJob = typeof scheduledJobs.$inferSelect;

/** Known job types. Later phases add agent_turn (4) and send_ladder (6). */
export const JOB_TYPES = ["send_sms"] as const;

export const sendSmsPayloadSchema = z.object({
  conversationId: z.uuid(),
  /** E.164 destination. */
  to: z.string().min(1),
  body: z.string().min(1),
  /** Mirrors messages.source. */
  source: z.enum(["opener", "ladder", "agent", "human", "system"]),
  /**
   * true = the send exists only because of automation (opener, ladder, agent).
   * Automated sends are skipped when a human paused the conversation
   * (conversations.aiEnabled = false); human-initiated sends are not.
   */
  automated: z.boolean().default(true),
  /**
   * Le DERNIER MOT de l'assistant : un adieu commis dans la même transaction
   * que la mise en pause de l'IA (refus ferme, close_conversation). Sans ce
   * drapeau, la garde « automatisé + IA en pause » sautait ce même message —
   * le tour disait « envoyé », le fil ne recevait rien. Le désabonnement et
   * l'interrupteur d'arrêt restent prioritaires : ils se jugent à l'envoi.
   */
  finalWord: z.boolean().default(false),
  aiGenerated: z.boolean().default(false),
  sentById: z.uuid().nullable().default(null),
  /**
   * Qui a écrit ce texte, quand c'est un assistant : l'identité ET la version
   * sont figées sur la rangée `messages` (c'est elle qui garde le souvenir de
   * celui qui a parlé — l'assistant actif d'un fil change au transfert, et
   * les traces de tour sont purgées après 30 jours). Null = humain / système.
   */
  assistantId: z.uuid().nullable().default(null),
  assistantVersion: z.number().int().nullable().default(null),
  /** Modèle réellement servi (peut différer du modèle demandé : repli). */
  model: z.string().nullable().default(null),
});
export type SendSmsPayload = z.infer<typeof sendSmsPayloadSchema>;

/** Retry backoff after a failed claim: 1 min, 5 min, 30 min — then failed. */
export const RETRY_BACKOFF_MS = [60_000, 300_000, 1_800_000] as const;
/** A job may be claimed this many times before a failure becomes permanent. */
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

export type JobOutcome =
  | { outcome: "done"; note?: string }
  | { outcome: "skipped"; reason: string }
  /** Not a failure: put the job back (quiet hours, debounce) without burning an attempt. */
  | { outcome: "reschedule"; runAt: Date }
  | { outcome: "failed_permanent"; error: string };

export type JobHandler = (job: ScheduledJob) => Promise<JobOutcome>;
