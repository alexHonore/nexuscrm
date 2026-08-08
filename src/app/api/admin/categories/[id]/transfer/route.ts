import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories, clients } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { readJson } from "../../../_helpers";

const schema = z.object({ targetId: z.number().int().nullable() });

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/categories/[id]/transfer — déplace TOUTES les fiches de
 * cette catégorie vers une autre (ou vers « sans catégorie » si targetId est
 * null), sans supprimer la catégorie d'origine. Sert à réorganiser le pipeline
 * sans laisser de fiches derrière : renommer une catégorie ne déplace rien,
 * ce geste-ci si.
 */
export async function POST(req: Request, ctx: Ctx) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const source = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (body.targetId === id) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  if (body.targetId !== null) {
    const dest = await db.query.categories.findFirst({ where: eq(categories.id, body.targetId) });
    if (!dest) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }

  const moved = await db
    .update(clients)
    .set({ categoryId: body.targetId })
    .where(eq(clients.categoryId, id))
    .returning({ id: clients.id });

  await logAudit({
    userId: admin.id,
    action: "category.transfer",
    entity: "category",
    entityId: String(id),
    // Des ids, pas des noms : le journal les résout dans la langue du
    // lecteur (renderScalar → lookups) et suit les renommages.
    detail: {
      count: moved.length,
      changes: { categoryId: { from: id, to: body.targetId } },
    },
  });

  return NextResponse.json({ moved: moved.length });
}
