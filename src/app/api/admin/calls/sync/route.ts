import { NextResponse } from "next/server";
import { z } from "zod";
import { shiftDateStr, todayStr } from "@/components/analytics/period";
import { logAudit } from "@/lib/audit";
import { syncCdrRange } from "@/lib/cdr-sync";
import { apiPerm } from "@/lib/permissions/server";

export const dynamic = "force-dynamic";
// L'API voip.ms peut mettre plus de 90 s à répondre — laisser de la marge.
export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 31;

const schema = z
  .object({
    from: z.string().regex(DATE_RE).optional(),
    to: z.string().regex(DATE_RE).optional(),
  })
  .optional();

/**
 * POST /api/admin/calls/sync — synchronisation voip.ms à la demande (admin).
 * Sans corps : hier + aujourd'hui (même fenêtre que le cron quotidien).
 * Avec {from, to} : rattrapage d'une plage passée (31 jours max) — les
 * enregistrements d'appels apparaissent dans /admin/calls sans attendre le
 * cron du lendemain matin.
 */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.calls");
  if (actor instanceof NextResponse) return actor;

  let body: z.infer<typeof schema>;
  try {
    const raw: unknown = await req.json().catch(() => undefined);
    body = schema.parse(raw ?? undefined);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 422 });
  }

  const today = todayStr();
  const from = body?.from ?? shiftDateStr(today, -1);
  const to = body?.to ?? today;
  if (from > to) {
    return NextResponse.json({ error: "invalid_range" }, { status: 422 });
  }
  const spanDays =
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000 +
    1;
  if (spanDays > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: "range_too_wide", maxDays: MAX_RANGE_DAYS }, { status: 422 });
  }

  const { counts, recordingFields, errors } = await syncCdrRange(from, to);

  await logAudit({
    userId: actor.user.id,
    action: "calls.sync",
    entity: "calls",
    detail: { range: { from, to }, counts, errors },
  });

  return NextResponse.json({
    ok: errors.length === 0,
    range: { from, to },
    ...counts,
    recordingFields,
    errors,
  });
}
