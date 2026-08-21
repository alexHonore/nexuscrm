import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { assistants, smsNumbers } from "@/db/schema-sms";
import { eq } from "drizzle-orm";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { normalizePhone } from "@/lib/phone";
import { listSmsNumbersForAdmin } from "@/lib/sms-server/numbers";

/** GET /api/admin/sms-numbers — les numéros et les assistants actifs (admin). */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json(await listSmsNumbersForAdmin());
}

export const createNumberSchema = z.object({
  e164: z.string().trim().min(3),
  label: z.string().trim().max(80).nullable().default(null),
  messagingServiceSid: z.string().trim().max(64).default(""),
  dailyCap: z.number().int().min(1).max(10_000).default(200),
  active: z.boolean().default(true),
  defaultAssistantId: z.uuid().nullable().default(null),
});

/** POST /api/admin/sms-numbers — enregistre un numéro d'envoi (E.164 imposé). */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = createNumberSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const e164 = normalizePhone(parsed.data.e164);
  if (!e164) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  if (parsed.data.defaultAssistantId) {
    const a = await db.query.assistants.findFirst({
      where: eq(assistants.id, parsed.data.defaultAssistantId),
      columns: { status: true },
    });
    if (!a || a.status !== "active") return NextResponse.json({ error: "assistant_inactive" }, { status: 409 });
  }
  const [row] = await db
    .insert(smsNumbers)
    .values({
      e164,
      label: parsed.data.label,
      messagingServiceSid: parsed.data.messagingServiceSid || (process.env.TWILIO_MESSAGING_SERVICE_SID ?? ""),
      dailyCap: parsed.data.dailyCap,
      active: parsed.data.active,
      defaultAssistantId: parsed.data.defaultAssistantId,
    })
    .onConflictDoNothing({ target: smsNumbers.e164 })
    .returning({ id: smsNumbers.id });
  if (!row) return NextResponse.json({ error: "already_exists" }, { status: 409 });
  await logAudit({
    userId: admin.id,
    action: "sms_number.create",
    entity: "sms_number",
    entityId: row.id,
    detail: { e164, dailyCap: parsed.data.dailyCap, active: parsed.data.active },
  });
  return NextResponse.json({ id: row.id }, { status: 201 });
}
