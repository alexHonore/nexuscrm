import { NextResponse } from "next/server";
import { z } from "zod";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { getSetting, setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

const schema = z.object({ calendarId: z.string().trim().min(1).max(300) });

/** Choix du calendrier Google utilisé pour les rendez-vous. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const current = await getSetting("google");
  await setSetting("google", { ...current, calendarId: body.calendarId });

  const changes = diffFields(current, body, ["calendarId"]);
  await logAudit({
    userId: admin.id,
    action: "settings.google",
    entity: "settings",
    detail: { calendarId: body.calendarId, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ ok: true });
}
