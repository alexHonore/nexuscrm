import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { getSetting, setSetting } from "@/lib/settings";

/** Déconnecte le compte Google (efface le refresh token chiffré). */
export async function POST() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const current = await getSetting("google");
  await setSetting("google", {
    refreshTokenEnc: null,
    email: null,
    calendarId: current.calendarId || "primary",
    connectedAt: null,
  });

  await logAudit({
    userId: admin.id,
    action: "settings.google_disconnect",
    entity: "settings",
    detail: { email: current.email },
  });

  return NextResponse.json({ ok: true });
}
