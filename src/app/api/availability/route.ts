import { type NextRequest, NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/guards";
import { computeAvailability, DATE_RE } from "./slots";

/**
 * GET /api/availability?date=YYYY-MM-DD&type=meet|inperson
 * Any authenticated user (callers book on the admin's calendar).
 */
export async function GET(req: NextRequest) {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const params = req.nextUrl.searchParams;
  const date = params.get("date") ?? "";
  const type = params.get("type") === "inperson" ? "inperson" : "meet";

  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  try {
    const result = await computeAvailability(date, type);
    return NextResponse.json({
      ...result,
      // Lets the dialog show the "Google not connected" warning to admins only.
      viewerIsAdmin: auth.role === "admin",
    });
  } catch (err) {
    console.error("availability failed", err);
    return NextResponse.json({ error: "availability_failed" }, { status: 502 });
  }
}
