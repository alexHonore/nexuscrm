import { NextResponse } from "next/server";
import { z } from "zod";
import { diffFields, logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { getSetting, setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

const schema = z.object({ provider: z.enum(["voipms", "twilio"]) });

/** Bascule du fournisseur de téléphonie — action sensible, auditée. */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const current = await getSetting("telephony");
  // Le réglage est RECOPIÉ avant d'être modifié. `setSetting` écrit la valeur
  // entière : depuis que la sonnerie simultanée vit sous cette même clé,
  // n'écrire que `{ provider }` effacerait silencieusement les numéros et les
  // identifiants de groupe de sonnerie de toute l'équipe — au moment le plus
  // anodin possible, un simple changement de fournisseur.
  await setSetting("telephony", { ...current, provider: body.provider });

  const changes = diffFields(current, body, ["provider"]);
  await logAudit({
    userId: actor.user.id,
    action: "settings.telephony",
    entity: "settings",
    detail: { provider: body.provider, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ telephony: { provider: body.provider } });
}
