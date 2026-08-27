import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { callTranscripts, scheduledJobs } from "@/db/schema-sms";
import { enqueueJob } from "@/lib/jobs/queue";
import { getSetting } from "@/lib/settings";

/**
 * Balayage « appels enregistrés sans note » → jobs `call_transcript`.
 *
 * Pourquoi un balayage plutôt qu'une mise en file au rattachement de chaque
 * enregistrement : le rattachement (`cdr-sync.ts`) ne se produit qu'UNE fois
 * par appel — un job perdu (panne au mauvais moment, réglage éteint ce
 * jour-là) ne serait jamais recréé. Ici, chaque synchronisation repasse sur la
 * fenêtre : ce qui manque est remis en file, ce qui est réglé (une rangée
 * `call_transcripts`, même skipped/failed) ne l'est plus, et la clé de
 * dédoublonnage absorbe ce qui est déjà en file.
 *
 * La fenêtre et la limite bornent le coût : à l'activation du réglage, on
 * rattrape au plus 72 h × 20 appels par synchronisation — pas dix mille
 * appels d'archives d'un coup.
 */

export const TRANSCRIPT_SWEEP_WINDOW_MS = 72 * 3600_000;
export const TRANSCRIPT_SWEEP_LIMIT = 20;

export function transcriptDedupeKey(callId: string): string {
  return `transcript:${callId}`;
}

/** Renvoie le nombre de jobs mis en file (0 si le réglage est éteint). */
export async function queueTranscriptJobs(now: Date = new Date()): Promise<number> {
  const cfg = await getSetting("transcripts");
  if (!cfg.enabled) return 0;

  const cutoff = new Date(now.getTime() - TRANSCRIPT_SWEEP_WINDOW_MS);
  const rows = await db
    .select({ id: calls.id })
    .from(calls)
    .leftJoin(callTranscripts, eq(callTranscripts.callId, calls.id))
    .where(
      and(isNotNull(calls.recordingUrl), gte(calls.startedAt, cutoff), isNull(callTranscripts.id)),
    )
    .orderBy(desc(calls.startedAt))
    .limit(TRANSCRIPT_SWEEP_LIMIT);

  if (rows.length === 0) return 0;

  /**
   * Deux gardes que la clé de dédoublonnage seule ne donne PAS :
   *
   *  · un job encore VIVANT (pending/running) ne doit pas être retouché — le
   *    dédoublonnage d'enqueueJob rafraîchirait son runAt à « maintenant » et
   *    écraserait le recul de réessai (1/5/30 min) posé par failJob ;
   *  · un job RÉGLÉ « failed » sans rangée call_transcripts (mort en plein
   *    vol, stale_requeue_limit) a LIBÉRÉ sa clé : sans cette garde, chaque
   *    synchronisation recréerait un job — et re-paierait le modèle — pour le
   *    même appel condamné, à l'infini. Le nettoyage des jobs réglés (14 j)
   *    est plus long que la fenêtre de 72 h : la garde tient tout du long.
   */
  const keys = rows.map((row) => transcriptDedupeKey(row.id));
  const settledOrLive = await db
    .select({ dedupeKey: scheduledJobs.dedupeKey })
    .from(scheduledJobs)
    .where(
      and(
        inArray(scheduledJobs.dedupeKey, keys),
        inArray(scheduledJobs.status, ["pending", "running", "failed"]),
      ),
    );
  const blocked = new Set(settledOrLive.map((j) => j.dedupeKey));

  let queued = 0;
  for (const row of rows) {
    const key = transcriptDedupeKey(row.id);
    if (blocked.has(key)) continue;
    const { deduped } = await enqueueJob({
      type: "call_transcript",
      runAt: now,
      payload: { callId: row.id },
      dedupeKey: key,
    });
    if (!deduped) queued += 1;
  }
  return queued;
}
