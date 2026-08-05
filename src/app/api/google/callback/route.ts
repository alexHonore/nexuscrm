import { type NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/guards";
import { encryptSecret, safeEqual } from "@/lib/crypto";
import { exchangeCode, GOOGLE_STATE_COOKIE } from "@/lib/google";
import { setSetting } from "@/lib/settings";

function settingsRedirect(req: NextRequest, status: "connected" | "error"): NextResponse {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
  const res = NextResponse.redirect(new URL(`/admin/settings?google=${status}`, base), 302);
  // The state nonce is single-use.
  res.cookies.set(GOOGLE_STATE_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}

/** OAuth return leg — must run in the same browser session as the admin who started it. */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return settingsRedirect(req, "error");
  }

  const params = req.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const cookieState = req.cookies.get(GOOGLE_STATE_COOKIE)?.value;

  if (params.get("error") || !code || !state || !cookieState || !safeEqual(state, cookieState)) {
    await logAudit({
      userId: user.id,
      action: "google.connect.error",
      detail: { reason: params.get("error") ?? (!code ? "missing_code" : "state_mismatch") },
    });
    return settingsRedirect(req, "error");
  }

  try {
    const { refreshToken, email } = await exchangeCode(code);
    await setSetting("google", {
      refreshTokenEnc: encryptSecret(refreshToken),
      email,
      calendarId: "primary",
      connectedAt: new Date().toISOString(),
    });
    await logAudit({
      userId: user.id,
      action: "google.connect",
      entity: "settings",
      entityId: "google",
      detail: { email },
    });
    return settingsRedirect(req, "connected");
  } catch (err) {
    console.error("google oauth callback failed", err);
    await logAudit({
      userId: user.id,
      action: "google.connect.error",
      detail: { reason: "token_exchange_failed" },
    });
    return settingsRedirect(req, "error");
  }
}
