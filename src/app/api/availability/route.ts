import { type NextRequest, NextResponse } from "next/server";
import { apiActor } from "@/lib/permissions/server";
import { computeAvailability, isRealDate } from "./slots";

/**
 * GET /api/availability?date=YYYY-MM-DD&type=meet|inperson
 * Any authenticated user (callers book on the admin's calendar).
 */
export async function GET(req: NextRequest) {
  const auth = await apiActor();
  if (auth instanceof NextResponse) return auth;

  const params = req.nextUrl.searchParams;
  const date = params.get("date") ?? "";
  const type = params.get("type") === "inperson" ? "inperson" : "meet";

  if (!isRealDate(date)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  try {
    const result = await computeAvailability(date, type);
    return NextResponse.json({
      ...result,
      // L'avertissement « Google non connecté » ne sert qu'à qui peut y
      // remédier : c'est le droit sur les réglages, pas le rôle.
      viewerIsAdmin: auth.can("admin.settings"),
    });
  } catch (err) {
    console.error("availability failed", err);
    return NextResponse.json({ error: "availability_failed" }, { status: 502 });
  }
}
