import { type NextRequest, NextResponse } from "next/server";
import { runDispatchCycle } from "@/lib/jobs/dispatch";
import { isCronAuthorized } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
// Un lot de 50 jobs (défaut) doit pouvoir s'exécuter au complet.
export const maxDuration = 300;

/**
 * GET /api/cron/dispatch — Bearer CRON_SECRET.
 * Dispatcher de la file `scheduled_jobs` : appelé chaque minute par n8n, avec
 * un filet quotidien côté Vercel. Ravive les jobs orphelins, réclame les jobs
 * dus puis les exécute. Sûr en exécution concurrente : les réclamations passent
 * par FOR UPDATE SKIP LOCKED — deux dispatchers simultanés ne traitent jamais
 * le même job.
 */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const counts = await runDispatchCycle();
  return NextResponse.json(counts);
}
