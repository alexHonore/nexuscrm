import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { generateTempPassword, readJson, toAdminUser } from "../_helpers";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().trim().toLowerCase(),
  role: z.enum(["admin", "caller"]),
  locale: z.enum(["fr", "en"]),
});

/** Crée un utilisateur avec un mot de passe temporaire retourné UNE seule fois. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  const tempPassword = generateTempPassword();
  try {
    const [created] = await db
      .insert(users)
      .values({
        name: body.name,
        email: body.email,
        role: body.role,
        locale: body.locale,
        passwordHash: await hashPassword(tempPassword),
      })
      .returning();

    await logAudit({
      userId: admin.id,
      action: "user.create",
      entity: "user",
      entityId: created.id,
      detail: { email: created.email, role: created.role },
    });

    return NextResponse.json({ user: toAdminUser(created), tempPassword });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("users_email_unique") || message.includes("duplicate key")) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    throw err;
  }
}
