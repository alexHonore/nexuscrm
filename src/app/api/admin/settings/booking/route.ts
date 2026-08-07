import { NextResponse } from "next/server";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { bookingSettingsSchema, getSetting, setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

const patchSchema = bookingSettingsSchema.partial();
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
