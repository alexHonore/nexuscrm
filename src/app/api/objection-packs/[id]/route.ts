import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { assistants, objectionPacks } from "@/db/schema-sms";
import { diffFields, logAudit } from "@/lib/audit";
import { objectionItemSchema } from "@/lib/guardrails/types";
import { apiPerm } from "@/lib/permissions/server";

/**
 * Modifier ou supprimer un paquet d'objections.
 *
 * L'identifiant ne se change PAS : c'est lui que `assistants.objection_packs`
 * référence. Le renommer romprait chaque assistant qui l'utilise, en silence —
 * le paquet disparaîtrait simplement de leur prompt au prochain compilage.
 *
 * Les deux gestes exigent `admin.assistantsEdit` et non le droit de lire : un
 * paquet est PARTAGÉ, une phrase corrigée ici change ce que disent tous les
 * assistants qui s'en servent, et la modification les marque à recompiler.
 */
const patchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  language: z.string().trim().min(2).max(10).optional(),
  items: z.array(objectionItemSchema).max(40).optional(),
});

/** Les assistants qui référencent ce paquet — vide = suppression sans risque. */
async function assistantsUsing(packId: string) {
  return db
    .select({ id: assistants.id, name: assistants.name, status: assistants.status })
    .from(assistants)
    .where(sql`${packId} = any(${assistants.objectionPacks})`);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistantsEdit");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
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

  const before = await db.query.objectionPacks.findFirst({
    where: (p, { eq: is }) => is(p.id, id),
  });
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [row] = await db
    .update(objectionPacks)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(objectionPacks.id, id))
    .returning();

  // Les assistants qui s'en servent portent un prompt devenu périmé : leur
  // texte compilé cite encore l'ancienne formulation.
  const used = await assistantsUsing(id);
  if (used.length > 0) {
    await db
      .update(assistants)
      .set({ needsRecompile: true })
      .where(sql`${id} = any(${assistants.objectionPacks})`);
  }

  await logAudit({
    userId: actor.user.id,
    action: "objection_pack.update",
    entity: "objection_pack",
    entityId: id,
    detail: {
      changes: diffFields(before, row, ["label", "language"]),
      items: Array.isArray(row.items) ? row.items.length : 0,
      invalidated: used.length,
    },
  });

  return NextResponse.json({ pack: row, invalidated: used.map((a) => a.name) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistantsEdit");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  const before = await db.query.objectionPacks.findFirst({
    where: (p, { eq: is }) => is(p.id, id),
  });
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Refus PLUTÔT que suppression en cascade : un paquet retiré sous les pieds
  // d'un assistant actif change ce qu'il répond, sans que rien ne le dise. On
  // nomme les assistants concernés pour que le geste suivant soit évident.
  const used = await assistantsUsing(id);
  if (used.length > 0) {
    return NextResponse.json(
      { error: "in_use", assistants: used.map((a) => ({ id: a.id, name: a.name })) },
      { status: 409 },
    );
  }

  await db.delete(objectionPacks).where(eq(objectionPacks.id, id));
  await logAudit({
    userId: actor.user.id,
    action: "objection_pack.delete",
    entity: "objection_pack",
    entityId: id,
    detail: { label: before.label, isBuiltin: before.isBuiltin },
  });

  return NextResponse.json({ ok: true });
}
