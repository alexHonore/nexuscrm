import { NextResponse } from "next/server";
import { z } from "zod";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { bookingSettingsSchema, getSetting, setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

/**
 * Rustine SANS valeurs par défaut. bookingSettingsSchema.partial() remplirait
 * chaque clé omise avec son défaut (zod v4), si bien qu'une rustine partielle
 * écraserait les réglages enregistrés — un brokerEmail vidé par l'admin se
 * ferait ressusciter par le premier POST qui ne le mentionne pas. On retire
 * donc le défaut de chaque champ avant de le rendre optionnel : une clé
 * absente reste absente, et « {...current, ...body} » est une vraie rustine.
 */
const patchSchema = z.object(
  Object.fromEntries(
    Object.entries(bookingSettingsSchema.shape).map(([key, field]) => [
      key,
      (field instanceof z.ZodDefault ? field.unwrap() : field).optional(),
    ]),
  ),
) as z.ZodType<Partial<z.output<typeof bookingSettingsSchema>>>;
const BOOKING_FIELDS = Object.keys(bookingSettingsSchema.shape);

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const current = await getSetting("booking");
  const next = bookingSettingsSchema.parse({ ...current, ...body });
  await setSetting("booking", next);

  const changes = diffFields(current, next, BOOKING_FIELDS);
  await logAudit({
    userId: admin.id,
    action: "settings.booking",
    entity: "settings",
    detail: { ...body, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ booking: next });
}
