import { NextResponse } from "next/server";
import { diffFields, logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { getSetting, setSetting, transcriptsSettingsSchema } from "@/lib/settings";
import { readJson } from "../../_helpers";

/**
 * Notes d'appel IA — remplacement EN BLOC (la carte envoie toujours le
 * formulaire complet), validé par LE schéma des réglages : les bornes sont
 * les gardes de coût et vivent à un seul endroit (`src/lib/settings.ts`) —
 * le formulaire admin n'est pas un `<form>`, ses min/max HTML ne
 * s'appliquent jamais.
 */
const schema = transcriptsSettingsSchema;

const FIELDS = [
  "enabled",
  "detail",
  "language",
  "model",
  "minSeconds",
  "maxMinutes",
  "keepTranscript",
] as const;

export async function POST(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const current = await getSetting("transcripts");
  await setSetting("transcripts", body);

  const changes = diffFields(current, body, [...FIELDS]);
  await logAudit({
    userId: actor.user.id,
    action: "settings.transcripts",
    entity: "settings",
    detail: { enabled: body.enabled, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ transcripts: body });
}
