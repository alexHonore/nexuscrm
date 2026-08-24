import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { isUniqueViolation } from "@/lib/db-errors";
import { readJson } from "../_helpers";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  try {
    const [created] = await db.insert(sources).values(body).returning();

    const changes = diffFields(null, created, ["name", "color"]);
    await logAudit({
      userId: admin.id,
      action: "source.create",
      entity: "source",
      entityId: String(created.id),
      detail: { name: created.name, ...(changes ? { changes } : {}) },
    });

    return NextResponse.json({ source: created });
  } catch (err) {
    // Drizzle enveloppe l'erreur Postgres : le nom de la contrainte n'est que
    // dans `cause` — d'où le détecteur partagé, jamais un test sur le message.
    if (isUniqueViolation(err, "sources_name_unique")) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }
}
