import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/auth/guards";
import { getUsageReport } from "@/lib/telephony-usage";
import { voipmsErrorResponse } from "../_helpers";

/** Le CDR d'une longue période est lent chez voip.ms — le client attend 110 s. */
export const maxDuration = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Même borne que la synchronisation ad hoc des appels : au-delà, le CDR
 * voip.ms devient trop lent pour une page qu'on rafraîchit à la main.
 */
const MAX_RANGE_DAYS = 31;

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Consommation par téléphoniste + dépense voip.ms sur une période.
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` (heure de Toronto).
 */
export async function GET(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const url = new URL(req.url);
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "invalid_range" }, { status: 422 });
  }
  if (from > to) return NextResponse.json({ error: "invalid_range" }, { status: 422 });
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    return NextResponse.json(
      { error: "range_too_long", maxDays: MAX_RANGE_DAYS },
      { status: 422 },
    );
  }

  try {
    return NextResponse.json(await getUsageReport(from, to));
  } catch (err) {
    return voipmsErrorResponse(err);
  }
}
