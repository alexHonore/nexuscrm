import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { revokeStoredToken } from "@/lib/google";
import { setSetting } from "@/lib/settings";

/** Admin only — revoke (best effort) and clear the stored Google connection. */
export async function POST() {
  const auth = await apiAdmin();
  if (auth instanceof NextResponse) return auth;

  await revokeStoredToken();
  await setSetting("google", {
    refreshTokenEnc: null,
    email: null,
    calendarId: "primary",
    connectedAt: null,
  });
  await logAudit({
    userId: auth.id,
    action: "google.disconnect",
    entity: "settings",
    entityId: "google",
  });

  return NextResponse.json({ ok: true });
}
