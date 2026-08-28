import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { webhookKeys } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { readJson } from "../../_helpers";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
  defaults: z
    .object({
      categoryId: z.number().int().nullable().optional(),
      sourceId: z.number().int().nullable().optional(),
      assignedToId: z.uuid().nullable().optional(),
    })
    .optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const actor = await apiPerm("admin.webhooks");
  if (actor instanceof NextResponse) return actor;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const [updated] = await db.update(webhookKeys).set(body).where(eq(webhookKeys.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await logAudit({
    userId: actor.user.id,
    action: "webhook.key_update",
    entity: "webhookKey",
    entityId: String(id),
    detail: { name: updated.name, isActive: updated.isActive, defaults: updated.defaults },
  });

  return NextResponse.json({
    key: {
      id: updated.id,
      name: updated.name,
      keyLast4: updated.keyLast4,
      defaults: updated.defaults,
      isActive: updated.isActive,
      lastUsedAt: updated.lastUsedAt?.toISOString() ?? null,
    },
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const actor = await apiPerm("admin.webhooks");
  if (actor instanceof NextResponse) return actor;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const target = await db.query.webhookKeys.findFirst({ where: eq(webhookKeys.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await db.delete(webhookKeys).where(eq(webhookKeys.id, id));

  await logAudit({
    userId: actor.user.id,
    action: "webhook.key_delete",
    entity: "webhookKey",
    entityId: String(id),
    detail: { name: target.name },
  });

  return NextResponse.json({ ok: true });
}
