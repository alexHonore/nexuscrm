import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { clients, sources } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { readJson } from "../../_helpers";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
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

  try {
    const [updated] = await db.update(sources).set(body).where(eq(sources.id, id)).returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

    await logAudit({
      userId: admin.id,
      action: "source.update",
      entity: "source",
      entityId: String(id),
      detail: body,
    });

    return NextResponse.json({ source: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("sources_name_unique") || message.includes("duplicate key")) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }
}

/** Supprime une source ; les clients sont réassignés (ou laissés sans source). */
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
  if (reassignTo === id) reassignTo = null;

  const target = await db.query.sources.findFirst({ where: eq(sources.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await db.transaction(async (tx) => {
    await tx.update(clients).set({ sourceId: reassignTo }).where(eq(clients.sourceId, id));
    await tx.delete(sources).where(eq(sources.id, id));
  });

  await logAudit({
    userId: admin.id,
    action: "source.delete",
    entity: "source",
    entityId: String(id),
    detail: { name: target.name, reassignTo },
  });

  return NextResponse.json({ ok: true });
}
