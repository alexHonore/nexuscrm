import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { readJson } from "../../_helpers";

const schema = z.object({ orderedIds: z.array(z.number().int()).min(1).max(200) });

/** Réordonne les catégories : sortOrder = index dans orderedIds. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  await db.transaction(async (tx) => {
    for (let i = 0; i < body.orderedIds.length; i++) {
      await tx.update(categories).set({ sortOrder: i }).where(eq(categories.id, body.orderedIds[i]));
    }
  });

  await logAudit({
    userId: admin.id,
    action: "category.reorder",
    entity: "category",
    detail: { orderedIds: body.orderedIds },
  });

  return NextResponse.json({ ok: true });
}
