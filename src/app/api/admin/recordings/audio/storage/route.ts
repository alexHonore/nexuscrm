import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/app/api/admin/_helpers";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { audioUsage, removeAllAudio } from "@/lib/recordings/audio";
import { getSetting, setSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ capMb: z.number().int().min(0).max(8_000) });

/**
 * La jauge de l'audio conservé, son plafond, et « tout retirer ».
 *
 * Réservé au droit de CONFIGURER l'application (`admin.settings`) : la place
 * occupée est un chiffre de TOUTE la base, qui compte aussi l'audio d'appels
 * que ce regard-ci ne voit peut-être pas — le montrer à un regard restreint
 * lui apprendrait que ces appels existent (règle 13).
 */
export async function GET() {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await audioUsage());
}

export async function PATCH(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const before = await getSetting("recordings");
  await setSetting("recordings", { ...before, audioCapMb: body.capMb });

  await logAudit({
    userId: actor.user.id,
    action: "recording_audio.cap",
    entity: "settings",
    entityId: "recordings",
    detail: { from: before.audioCapMb, to: body.capMb },
  });

  return NextResponse.json({ ok: true, usage: await audioUsage() });
}

export async function DELETE() {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const freed = await removeAllAudio(actor.user.id);

  await logAudit({
    userId: actor.user.id,
    action: "recording_audio.remove_all",
    entity: "settings",
    entityId: "recordings",
    detail: freed,
  });

  return NextResponse.json({ ok: true, ...freed });
}
