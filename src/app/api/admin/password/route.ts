import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, readSession } from "@/lib/auth/session";
import { readJson } from "../_helpers";

const schema = z.object({
  current: z.string().min(1),
  next: z.string().min(8).max(128),
});

/**
 * Changement du mot de passe de l'admin connecté (exige le mot de passe actuel).
 * Toutes les AUTRES sessions sont révoquées ; ce navigateur reçoit un nouveau cookie.
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const ok = await verifyPassword(body.current, admin.passwordHash);
  if (!ok) return NextResponse.json({ error: "wrong_password" }, { status: 400 });

  const [row] = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(body.next),
      // Invalide les sessions existantes (cookie volé, appareil partagé)…
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, admin.id))
    .returning({ tokenVersion: users.tokenVersion });
  // …et réémet la session courante pour que CE navigateur reste connecté.
  const session = await readSession();
  await createSession({
    uid: admin.id,
    role: admin.role,
    tv: row.tokenVersion,
    remember: session?.remember ?? false,
  });

  await logAudit({ userId: admin.id, action: "user.password_change", entity: "user", entityId: admin.id });

  return NextResponse.json({ ok: true });
}
