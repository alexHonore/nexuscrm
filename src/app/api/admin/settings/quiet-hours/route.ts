import { NextResponse } from "next/server";
import { z } from "zod";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { getSetting, quietHoursSettingsSchema, setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

/**
 * POST /api/admin/settings/quiet-hours — règle la fenêtre d'envoi SMS.
 *
 * Rustine partielle (même prudence que booking) : on retire le défaut de chaque
 * champ avant de le rendre optionnel, sinon un POST partiel réécraserait les
 * fenêtres non mentionnées. La règle « début < fin » de chaque fenêtre est déjà
 * dans le schéma de tuple ; elle se revérifie sur le réglage RECOMPOSÉ.
 */
const patchSchema = z.object(
  Object.fromEntries(
    Object.entries(quietHoursSettingsSchema.shape).map(([key, field]) => [
      key,
      (field instanceof z.ZodDefault ? field.unwrap() : field).optional(),
    ]),
  ),
) as z.ZodType<Partial<z.output<typeof quietHoursSettingsSchema>>>;

const FIELDS = Object.keys(quietHoursSettingsSchema.shape);

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const current = await getSetting("quietHours");
  const merged = quietHoursSettingsSchema.safeParse({ ...current, ...body });
  if (!merged.success) {
    return NextResponse.json({ error: "validation", issues: merged.error.issues }, { status: 422 });
  }
  const next = merged.data;
  await setSetting("quietHours", next);

  const changes = diffFields(current, next, FIELDS);
  await logAudit({
    userId: admin.id,
    action: "settings.quiet_hours",
    entity: "settings",
    detail: { ...body, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ quietHours: next });
}
