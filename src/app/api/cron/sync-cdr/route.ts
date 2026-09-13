import { type NextRequest, NextResponse } from "next/server";
import { shiftDateStr, todayStr } from "@/components/analytics/period";
import { logAudit } from "@/lib/audit";
import { syncCdrRange } from "@/lib/cdr-sync";
import { isCronAuthorized } from "@/lib/cron-auth";
import { keepPendingAudio, pruneOrphanAudio } from "@/lib/recordings/audio";

export const dynamic = "force-dynamic";
// L'API voip.ms peut mettre plus de 90 s à répondre — laisser de la marge.
export const maxDuration = 300;

/**
 * GET /api/cron/sync-cdr — Bearer CRON_SECRET.
 * Réconcilie les CDR voip.ms (hier + aujourd'hui, dates Toronto) avec la table
 * `calls` — logique partagée dans src/lib/cdr-sync.ts (voir aussi la version à
 * la demande : POST /api/admin/calls/sync).
 */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = todayStr();
  const yesterday = shiftDateStr(today, -1);
  const { counts, errors } = await syncCdrRange(yesterday, today);

  // Le ménage de l'audio conservé, puis le ramassage des appels de la
  // bibliothèque qui n'ont pas encore leur copie. Une panne ici ne doit pas
  // cacher le résultat de la synchro elle-même.
  let audio: { pruned: number; kept: number; failed: number; capReached: boolean } | null = null;
  try {
    const pruned = await pruneOrphanAudio();
    audio = { pruned, ...(await keepPendingAudio({ limit: 10 })) };
  } catch (err) {
    errors.push(`audio: ${err instanceof Error ? err.message : String(err)}`);
  }

  await logAudit({
    userId: null,
    action: "cron.sync_cdr",
    entity: "calls",
    detail: { range: { from: yesterday, to: today }, counts, audio, errors },
  });

  return NextResponse.json({
    ok: errors.length === 0,
    range: { from: yesterday, to: today },
    ...counts,
    audio,
    errors,
  });
}
