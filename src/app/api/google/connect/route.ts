import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { buildConsentUrl, GOOGLE_STATE_COOKIE } from "@/lib/google";

/** Droit `admin.settings` — 302 to the Google consent screen (offline access, forced consent). */
export async function GET() {
  const auth = await apiPerm("admin.settings");
  if (auth instanceof NextResponse) return auth;

  const state = randomBytes(16).toString("hex");

  let url: string;
  try {
    url = buildConsentUrl(state);
  } catch {
    return NextResponse.json({ error: "google_env_missing" }, { status: 500 });
  }

  await logAudit({ userId: auth.user.id, action: "google.connect.start" });

  const res = NextResponse.redirect(url, 302);
  res.cookies.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes
  });
  return res;
}
