import { type NextRequest, NextResponse } from "next/server";
import { shiftDateStr, todayStr } from "@/components/analytics/period";
import { logAudit } from "@/lib/audit";
import { syncCdrRange } from "@/lib/cdr-sync";

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
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = todayStr();
  const yesterday = shiftDateStr(today, -1);
  const { counts, errors } = await syncCdrRange(yesterday, today);

  await logAudit({
    userId: null,
    action: "cron.sync_cdr",
    entity: "calls",
    detail: { range: { from: yesterday, to: today }, counts, errors },
  });

  return NextResponse.json({
    ok: errors.length === 0,
    range: { from: yesterday, to: today },
    ...counts,
    errors,
  });
}
