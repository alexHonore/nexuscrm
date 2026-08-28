import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { revokeStoredToken } from "@/lib/google";
import { apiPerm } from "@/lib/permissions/server";
import { getSetting, setSetting } from "@/lib/settings";

/**
 * Déconnecte le compte Google : révoque le refresh token chez Google (meilleur
 * effort — hors ligne, la déconnexion locale a lieu quand même), PUIS l'efface.
 * Sans la révocation, un jeton exfiltré plus tôt (sauvegarde, journal)
 * resterait valable indéfiniment alors que l'écran dit « déconnecté ».
 */
export async function POST() {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const current = await getSetting("google");
  // Avant l'effacement : la révocation relit le jeton stocké.
  await revokeStoredToken();
  await setSetting("google", {
    refreshTokenEnc: null,
    email: null,
    calendarId: current.calendarId || "primary",
    connectedAt: null,
  });

  await logAudit({
    userId: actor.user.id,
    action: "settings.google_disconnect",
    entity: "settings",
    detail: { email: current.email },
  });

  return NextResponse.json({ ok: true });
}
