import { NextResponse } from "next/server";
import { apiPerm } from "@/lib/permissions/server";
import { getSubAccounts, VoipMsError } from "@/lib/voipms";

/** Test de connexion voip.ms (getSubAccounts) — pour la page Réglages. */
export async function GET() {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  try {
    const accounts = await getSubAccounts();
    return NextResponse.json({ ok: true, count: accounts.length });
  } catch (err) {
    if (err instanceof VoipMsError) {
      return NextResponse.json({ ok: false, status: err.status, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, status: "unknown", message });
  }
}
