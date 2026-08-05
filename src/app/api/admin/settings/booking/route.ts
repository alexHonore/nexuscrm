import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { bookingSettingsSchema, getSetting, setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

const patchSchema = bookingSettingsSchema.partial();

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const current = await getSetting("booking");
  const next = bookingSettingsSchema.parse({ ...current, ...body });
  await setSetting("booking", next);

  await logAudit({ userId: admin.id, action: "settings.booking", entity: "settings", detail: body });

  return NextResponse.json({ booking: next });
}
