import { google } from "googleapis";
import { NextResponse } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { apiPerm } from "@/lib/permissions/server";
import { getSetting } from "@/lib/settings";

/**
 * Liste les calendriers du compte Google connecté (pour le sélecteur).
 *
 * NOTE : utilise directement googleapis avec le refresh token stocké dans le
 * réglage `google` (schéma partagé src/lib/settings.ts). Si un module
 * `@/lib/google` (getAuthedCalendar) est ajouté par le module réservation,
 * cette route peut être basculée dessus — même contrat de données.
 */
export async function GET() {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const settings = await getSetting("google");
  if (!settings.refreshTokenEnc) {
    return NextResponse.json({ error: "not_connected" }, { status: 400 });
  }

  try {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth2.setCredentials({ refresh_token: decryptSecret(settings.refreshTokenEnc) });
    const calendar = google.calendar({ version: "v3", auth: oauth2 });
    const res = await calendar.calendarList.list({ maxResults: 100 });

    return NextResponse.json({
      calendars: (res.data.items ?? [])
        .filter((c) => c.id)
        .map((c) => ({
          id: c.id as string,
          summary: c.summary ?? (c.id as string),
          primary: Boolean(c.primary),
        })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "google_failed", message }, { status: 502 });
  }
}
