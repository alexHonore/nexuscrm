import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories, clients } from "@/db/schema";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { readJson } from "../../_helpers";

const patchSchema = z.object({
  nameFr: z.string().trim().min(1).max(80).optional(),
  nameEn: z.string().trim().min(1).max(80).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

const deleteSchema = z.object({ reassignTo: z.number().int().nullable().optional() });

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  // Lu AVANT l'écriture : le journal doit pouvoir montrer l'ancienne valeur.
  const before = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  const [updated] = await db.update(categories).set(body).where(eq(categories.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const changes = diffFields(before, updated, ["nameFr", "nameEn", "color"]);
  await logAudit({
    userId: admin.id,
    action: "category.update",
    entity: "category",
    entityId: String(id),
    detail: { ...body, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ category: updated });
}

/**
 * Supprime une catégorie NON système. Les clients de cette catégorie sont
 * déplacés vers `reassignTo` (ou laissés sans catégorie si null).
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  let reassignTo: number | null = null;
  try {
    const parsed = deleteSchema.safeParse(await req.json());
    if (parsed.success) reassignTo = parsed.data.reassignTo ?? null;
  } catch {
    // corps vide accepté
  }

  const target = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.isSystem) return NextResponse.json({ error: "system_category" }, { status: 400 });
  if (reassignTo === id) reassignTo = null;

  await db.transaction(async (tx) => {
    await tx.update(clients).set({ categoryId: reassignTo }).where(eq(clients.categoryId, id));
    await tx.delete(categories).where(eq(categories.id, id));
  });

  const changes = diffFields(target, null, ["nameFr", "nameEn", "color"]);
  await logAudit({
    userId: admin.id,
    action: "category.delete",
    entity: "category",
    entityId: String(id),
    detail: { nameFr: target.nameFr, reassignTo, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ ok: true });
}
