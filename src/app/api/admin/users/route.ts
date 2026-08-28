import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { isUniqueViolation } from "@/lib/db-errors";
import { hashPassword } from "@/lib/auth/password";
import { ROLE_ID_RE } from "@/lib/permissions/schema";
import { loadPermissions, setUserRole } from "@/lib/permissions/server";
import {
  defaultRole,
  generateTempPassword,
  readJson,
  requestedRole,
  toAdminUser,
} from "../_helpers";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().trim().toLowerCase(),
  /** Le rôle configuré. Absent : le rôle par défaut de la matrice. */
  roleId: z.string().trim().regex(ROLE_ID_RE).optional(),
  /** Ancienne forme (le plancher de la base) — encore acceptée, traduite. */
  role: z.enum(["admin", "caller"]).optional(),
  locale: z.enum(["fr", "en"]),
});

/** Crée un utilisateur avec un mot de passe temporaire retourné UNE seule fois. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  const cfg = await loadPermissions();
  const asked = requestedRole(cfg, body);
  if (asked instanceof NextResponse) return asked;
  // Rien de demandé : le rôle par défaut de la matrice. Jamais le rôle
  // administrateur en repli — un compte ne reçoit les clés que si on les a
  // explicitement demandées.
  const role = asked ?? defaultRole(cfg) ?? cfg.roles.find((r) => !r.superAdmin);
  if (!role) return NextResponse.json({ error: "unknown_role" }, { status: 422 });

  const tempPassword = generateTempPassword();
  try {
    const [created] = await db
      .insert(users)
      .values({
        name: body.name,
        email: body.email,
        locale: body.locale,
        passwordHash: await hashPassword(tempPassword),
        // `role` n'est pas écrit ici : la colonne garde son défaut le temps
        // d'une ligne, puis `setUserRole` pose le plancher ET l'affectation
        // ensemble. Deux écritures de rôle, deux vérités à tenir d'accord.
      })
      .returning();

    const { floor } = await setUserRole(created.id, role.id);

    await logAudit({
      userId: admin.id,
      action: "user.create",
      entity: "user",
      entityId: created.id,
      // Le nom du rôle plutôt que le seul plancher : « caller » ne distingue
      // plus un téléphoniste d'un superviseur ni d'un rôle maison.
      detail: { email: created.email, role: role.nameFr, roleId: role.id, floor },
    });

    return NextResponse.json({
      user: toAdminUser({ ...created, role: floor }, undefined, role),
      tempPassword,
    });
  } catch (err) {
    if (isUniqueViolation(err, "users_email_unique")) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    throw err;
  }
}
