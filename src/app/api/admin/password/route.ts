import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, readSession } from "@/lib/auth/session";
import { apiPerm } from "@/lib/permissions/server";
import { readJson } from "../_helpers";

const schema = z.object({
  current: z.string().min(1),
  next: z.string().min(8).max(128),
});

/**
 * Changement du mot de passe du compte connecté (exige le mot de passe actuel).
 * Toutes les AUTRES sessions sont révoquées ; ce navigateur reçoit un nouveau cookie.
 *
 * Gardée par `admin.users` : c'est la porte de l'écran des comptes, pas celle
 * de tout le monde. Qui n'a pas ce droit passe par son profil
 * (`changePasswordAction`), qui fait exactement la même chose pour lui-même.
 */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.users");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  const ok = await verifyPassword(body.current, actor.user.passwordHash);
  if (!ok) return NextResponse.json({ error: "wrong_password" }, { status: 400 });

  const [row] = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(body.next),
      // Invalide les sessions existantes (cookie volé, appareil partagé)…
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, actor.user.id))
    .returning({ tokenVersion: users.tokenVersion });
  // …et réémet la session courante pour que CE navigateur reste connecté.
  const session = await readSession();
  await createSession({
    uid: actor.user.id,
    role: actor.user.role,
    tv: row.tokenVersion,
    remember: session?.remember ?? false,
  });

  await logAudit({ userId: actor.user.id, action: "user.password_change", entity: "user", entityId: actor.user.id });

  return NextResponse.json({ ok: true });
}
