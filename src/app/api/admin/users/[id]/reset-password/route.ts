import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { generateTempPassword } from "../../../_helpers";

/** Réinitialise le mot de passe — nouveau mot de passe temporaire retourné UNE fois. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;

  const target = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const tempPassword = generateTempPassword();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(tempPassword),
      // Invalide les sessions existantes de cet utilisateur.
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));

  await logAudit({
    userId: admin.id,
    action: "user.reset_password",
    entity: "user",
    entityId: id,
    detail: { email: target.email },
  });

  return NextResponse.json({ tempPassword });
}
