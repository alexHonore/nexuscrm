import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { clients, sources } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { readJson } from "../../../_helpers";

const schema = z.object({ targetId: z.number().int().nullable() });

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/sources/[id]/transfer — déplace TOUTES les fiches de cette
 * source vers une autre (ou vers « sans source » si targetId est null), sans
 * supprimer la source d'origine.
 */
export async function POST(req: Request, ctx: Ctx) {
  const actor = await apiPerm("admin.pipeline");
  if (actor instanceof NextResponse) return actor;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const source = await db.query.sources.findFirst({ where: eq(sources.id, id) });
  if (!source) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (body.targetId === id) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  if (body.targetId !== null) {
    const dest = await db.query.sources.findFirst({ where: eq(sources.id, body.targetId) });
    if (!dest) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }

  const moved = await db
    .update(clients)
    .set({ sourceId: body.targetId })
    .where(eq(clients.sourceId, id))
    .returning({ id: clients.id });

  await logAudit({
    userId: actor.user.id,
    action: "source.transfer",
    entity: "source",
    entityId: String(id),
    // Des ids, pas des noms : le journal les résout dans la langue du
    // lecteur (renderScalar → lookups) et suit les renommages.
    detail: {
      count: moved.length,
      changes: { sourceId: { from: id, to: body.targetId } },
    },
  });

  return NextResponse.json({ moved: moved.length });
}
