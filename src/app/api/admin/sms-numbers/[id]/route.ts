import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistants, conversations, smsNumbers } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";

const patchSchema = z.object({
  label: z.string().trim().max(80).nullable().optional(),
  messagingServiceSid: z.string().trim().max(64).optional(),
  dailyCap: z.number().int().min(1).max(10_000).optional(),
  active: z.boolean().optional(),
  defaultAssistantId: z.uuid().nullable().optional(),
});

/** PATCH /api/admin/sms-numbers/:id — libellé, plafond, actif, assistant par défaut. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  if (parsed.data.defaultAssistantId) {
    const a = await db.query.assistants.findFirst({
      where: eq(assistants.id, parsed.data.defaultAssistantId),
      columns: { status: true },
    });
    if (!a || a.status !== "active") return NextResponse.json({ error: "assistant_inactive" }, { status: 409 });
  }
  const [row] = await db
    .update(smsNumbers)
    .set(parsed.data)
    .where(eq(smsNumbers.id, id))
    .returning({ id: smsNumbers.id, e164: smsNumbers.e164 });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await logAudit({
    userId: actor.user.id,
    action: "sms_number.update",
    entity: "sms_number",
    entityId: id,
    detail: { e164: row.e164, changed: Object.keys(parsed.data) },
  });
  return NextResponse.json({ saved: true });
}

/**
 * DELETE /api/admin/sms-numbers/:id — refusé si des fils y sont rattachés :
 * un numéro qui a servi garde son histoire, on le désactive plutôt.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.settings");
  if (actor instanceof NextResponse) return actor;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.smsNumberId, id));
  if ((used?.n ?? 0) > 0) return NextResponse.json({ error: "in_use", conversations: used.n }, { status: 409 });
  const [row] = await db.delete(smsNumbers).where(eq(smsNumbers.id, id)).returning({ e164: smsNumbers.e164 });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await logAudit({
    userId: actor.user.id,
    action: "sms_number.delete",
    entity: "sms_number",
    entityId: id,
    detail: { e164: row.e164 },
  });
  return NextResponse.json({ deleted: true });
}
