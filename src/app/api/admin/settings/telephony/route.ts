import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { setSetting } from "@/lib/settings";
import { readJson } from "../../_helpers";

const schema = z.object({ provider: z.enum(["voipms", "twilio"]) });

/** Bascule du fournisseur de téléphonie — action sensible, auditée. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  await setSetting("telephony", { provider: body.provider });

  await logAudit({
    userId: admin.id,
    action: "settings.telephony",
    entity: "settings",
    detail: { provider: body.provider },
  });

  return NextResponse.json({ telephony: { provider: body.provider } });
}
