"use server";

import { and, eq, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { diffFields, logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/guards";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, readSession } from "@/lib/auth/session";

export type ProfileResult =
  | { ok: true }
  | { ok: false; error: "invalid" | "forbidden" | "emailTaken" | "wrongPassword" };

const FORBIDDEN = { ok: false, error: "forbidden" } as const;
const INVALID = { ok: false, error: "invalid" } as const;

const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
});

/** Chaque utilisateur (admin ou téléphoniste) modifie SON nom / courriel. */
export async function updateProfileAction(input: {
  name: string;
  email: string;
}): Promise<ProfileResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const { name, email } = parsed.data;

  // Le courriel sert d'identifiant de connexion : unicité vérifiée avant.
  const taken = await db.query.users.findFirst({
    where: and(eq(users.email, email), ne(users.id, user.id)),
    columns: { id: true },
  });
  if (taken) return { ok: false, error: "emailTaken" };

  const changes = diffFields(user, { name, email }, ["name", "email"]);
  if (changes) {
    await db
      .update(users)
      .set({ name, email, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await logAudit({
      userId: user.id,
      action: "user.update",
      entity: "user",
      entityId: user.id,
      detail: { self: true, changes },
    });
  }
  revalidatePath("/profile");
  return { ok: true };
}

/**
 * Changement de mot de passe par son détenteur — exige le mot de passe actuel.
 * Mêmes règles et même action d'audit que la route admin
 * (POST /api/admin/password) : min 8, et toutes les AUTRES sessions sont
 * révoquées (tokenVersion) — seul le navigateur courant reçoit un nouveau cookie.
 */
export async function changePasswordAction(input: {
  current: string;
  next: string;
}): Promise<ProfileResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = z
    .object({ current: z.string().min(1), next: z.string().min(8).max(128) })
    .safeParse(input);
  if (!parsed.success) return INVALID;

  const ok = await verifyPassword(parsed.data.current, user.passwordHash);
  if (!ok) return { ok: false, error: "wrongPassword" };

  const [row] = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(parsed.data.next),
      // Invalide les sessions existantes (cookie volé, appareil partagé)…
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning({ tokenVersion: users.tokenVersion });
  // …et réémet la session courante pour que CE navigateur reste connecté.
  const session = await readSession();
  await createSession({
    uid: user.id,
    role: user.role,
    tv: row.tokenVersion,
    remember: session?.remember ?? false,
  });
  await logAudit({
    userId: user.id,
    action: "user.password_change",
    entity: "user",
    entityId: user.id,
  });
  return { ok: true };
}
