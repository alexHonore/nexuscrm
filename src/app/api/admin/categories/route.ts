import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { readJson } from "../_helpers";

const createSchema = z.object({
  nameFr: z.string().trim().min(1).max(80),
  nameEn: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

/** Crée une catégorie personnalisée (non système), placée en fin de liste. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  const last = await db.query.categories.findFirst({ orderBy: desc(categories.sortOrder) });
  const [created] = await db
    .insert(categories)
    .values({ ...body, isSystem: false, sortOrder: (last?.sortOrder ?? -1) + 1 })
    .returning();

  const changes = diffFields(null, created, ["nameFr", "nameEn", "color", "sortOrder"]);
  await logAudit({
    userId: admin.id,
    action: "category.create",
    entity: "category",
    entityId: String(created.id),
    detail: { nameFr: created.nameFr, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ category: created });
}
