import { type NextRequest, NextResponse } from "next/server";
import { runTranscriptCycle } from "@/lib/jobs/dispatch";
import { isCronAuthorized } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
// Un job audio au pire cas (voip.ms 100 s + téléchargement 60 s + modèle
// 180 s) doit pouvoir finir — le cycle ne réclame plus rien passé 90 s.
export const maxDuration = 300;

/**
 * GET /api/cron/transcripts — Bearer CRON_SECRET.
 * Couloir DÉDIÉ des notes d'appel (`call_transcript`) : hors du dispatcher
 * SMS pour qu'un job audio de plusieurs minutes ne fasse jamais attendre une
 * réponse d'assistant. Alimenté par le balayage de la synchronisation CDR
 * (qui donne aussi un coup d'envoi via kickTranscripts) ; ce cron est le
 * filet qui vide ce qui reste. Sûr en exécution concurrente (FOR UPDATE SKIP
 * LOCKED, réclamation un par un).
 */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const counts = await runTranscriptCycle();
  return NextResponse.json(counts);
}
