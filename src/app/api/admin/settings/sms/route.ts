import { NextResponse } from "next/server";
import { z } from "zod";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { getSetting, setSetting, smsSettingsSchema } from "@/lib/settings";
import { CONSENT_VALIDITIES } from "@/lib/sms/consent";
import { readJson } from "../../_helpers";

/**
 * Seule la durée de validité des consentements se règle ici. L'interrupteur
 * d'arrêt (killSwitch) a sa propre route (/api/kill-switch) : on lit l'état
 * courant et on n'écrase QUE consentValidity — une rustine, jamais un reset.
 *
 * Le registre des consentements est append-only : cette durée n'est estampillée
 * que sur les FUTURS consentements, les rangées existantes gardent leur échéance.
 */
const patchSchema = z.object({ consentValidity: z.enum(CONSENT_VALIDITIES) });

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const current = await getSetting("sms");
  const next = smsSettingsSchema.parse({ ...current, consentValidity: body.consentValidity });
  await setSetting("sms", next);

  const changes = diffFields(current, next, ["consentValidity"]);
  await logAudit({
    userId: admin.id,
    action: "settings.sms",
    entity: "settings",
    detail: { consentValidity: body.consentValidity, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ sms: next });
}
