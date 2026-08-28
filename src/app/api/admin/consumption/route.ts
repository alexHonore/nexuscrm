import { NextResponse } from "next/server";
import { z } from "zod";
import { getConsumption } from "@/lib/consumption";
import { apiPerm } from "@/lib/permissions/server";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * GET  /api/admin/consumption?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   → consommation IA (coût réel) et SMS (segments + estimation) sur la période.
 *     Lit la BASE : rapide, contrairement au CDR voip.ms.
 * PATCH /api/admin/consumption  { smsSegmentCostUsd }
 *   → règle le taux d'estimation SMS.
 *
 * Réservé au droit `admin.billing`.
 */

/**
 * La base répond vite, mais le rapport interroge aussi Twilio (coût, deux
 * catégories de journées, solde) et OpenRouter — en parallèle, avec leurs
 * propres délais d'attente. Une borne explicite fait apparaître un message
 * clair plutôt qu'une erreur de plateforme si un fournisseur traîne.
 */
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

/** Vraie date du calendrier — `DATE_RE` ne voit que la FORME (2026-13-01 passe). */
function isRealDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export async function GET(req: Request) {
  const actor = await apiPerm("admin.billing");
  if (actor instanceof NextResponse) return actor;

  const url = new URL(req.url);
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();
  if (!isRealDate(from) || !isRealDate(to) || from > to) {
    return NextResponse.json({ error: "invalid_range" }, { status: 422 });
  }
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: "range_too_long", maxDays: MAX_RANGE_DAYS }, { status: 422 });
  }

  return NextResponse.json(await getConsumption(from, to));
}

const rateSchema = z.object({ smsSegmentCostUsd: z.number().min(0).max(10) });

export async function PATCH(req: Request) {
  const actor = await apiPerm("admin.billing");
  if (actor instanceof NextResponse) return actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = rateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }

  const current = await getSetting("consumption");
  await setSetting("consumption", { ...current, smsSegmentCostUsd: parsed.data.smsSegmentCostUsd });
  return NextResponse.json({ ok: true, smsSegmentCostUsd: parsed.data.smsSegmentCostUsd });
}
