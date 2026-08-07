import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { appointments, calls, followups, users } from "@/db/schema";
import { diffFields, logAudit, secretChange } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { isUniqueViolation } from "@/lib/db-errors";
import { encryptSecret } from "@/lib/crypto";
import { normalizePhone } from "@/lib/phone";
import { releaseDidFromOthers } from "../../voipms/_assignments";
import { readJson, toAdminUser } from "../../_helpers";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.email().trim().toLowerCase().optional(),
  role: z.enum(["admin", "caller"]).optional(),
  locale: z.enum(["fr", "en"]).optional(),
  isActive: z.boolean().optional(),
  sipUsername: z.string().trim().max(64).nullable().optional(),
  /** Écriture seule — jamais renvoyé. Chaîne vide = ne pas changer. */
  sipPassword: z.string().max(128).optional(),
  didNumber: z.string().trim().max(32).nullable().optional(),
});

type Ctx = { params: Promise<{ id: string }> };

/**
 * Champs du compte suivis par le journal d'audit (avant → après).
 * Le mot de passe SIP en est absent : il est consigné à part, sous forme de
 * marqueur — un secret ne doit JAMAIS atterrir dans `audit_logs`.
 */
const USER_AUDIT_FIELDS = [
  "name",
  "email",
  "role",
  "locale",
  "isActive",
  "didNumber",
  "sipUsername",
] as const;

export async function PATCH(req: Request, ctx: Ctx) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const target = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Garde-fous : un admin ne peut ni se désactiver ni se rétrograder lui-même.
  if (id === admin.id && body.isActive === false) {
    return NextResponse.json({ error: "cannot_deactivate_self" }, { status: 400 });
  }
  if (id === admin.id && body.role === "caller") {
    return NextResponse.json({ error: "cannot_demote_self" }, { status: 400 });
  }

  const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  const changed: string[] = [];

  if (body.name !== undefined && body.name !== target.name) {
    set.name = body.name;
    changed.push("name");
  }
  if (body.email !== undefined && body.email !== target.email) {
    set.email = body.email;
    changed.push("email");
  }
  if (body.role !== undefined && body.role !== target.role) {
    set.role = body.role;
    changed.push("role");
  }
  if (body.locale !== undefined && body.locale !== target.locale) {
    set.locale = body.locale;
    changed.push("locale");
  }
  if (body.sipUsername !== undefined) {
    set.sipUsername = body.sipUsername || null;
    if ((body.sipUsername || null) !== target.sipUsername) changed.push("sipUsername");
  }
  if (body.sipPassword !== undefined && body.sipPassword !== "") {
    set.sipPasswordEnc = encryptSecret(body.sipPassword);
    changed.push("sipPassword");
  }
  if (body.didNumber !== undefined) {
    if (body.didNumber) {
      const normalized = normalizePhone(body.didNumber);
      if (!normalized) return NextResponse.json({ error: "invalid_did" }, { status: 422 });
      set.didNumber = normalized;
    } else {
      set.didNumber = null;
    }
    if ((set.didNumber ?? null) !== target.didNumber) changed.push("didNumber");
  }
  if (body.isActive !== undefined && body.isActive !== target.isActive) {
    set.isActive = body.isActive;
    changed.push(body.isActive ? "activate" : "deactivate");
    // Désactivation → invalider toutes les sessions existantes.
    if (!body.isActive) set.tokenVersion = sql`${users.tokenVersion} + 1` as unknown as number;
  }

  try {
    // Assignation d'un DID : on le retire de son détenteur précédent dans la
    // MÊME transaction — deux comptes ne peuvent jamais partager un numéro.
    const { updated, released } = await db.transaction(async (tx) => {
      const freed = set.didNumber ? await releaseDidFromOthers(tx, set.didNumber, id) : [];
      const [row] = await tx.update(users).set(set).where(eq(users.id, id)).returning();
      return { updated: row, released: freed };
    });

    if (changed.length > 0) {
      const changes = diffFields(target, updated, USER_AUDIT_FIELDS) ?? {};
      // Mot de passe SIP : présence avant/après seulement, jamais la valeur.
      if (changed.includes("sipPassword")) {
        changes.sipPassword = secretChange(Boolean(target.sipPasswordEnc));
      }
      await logAudit({
        userId: admin.id,
        action: "user.update",
        entity: "user",
        entityId: id,
        detail: {
          changed,
          email: updated.email,
          ...(changed.includes("email") ? { previousEmail: target.email } : {}),
          ...(released.length > 0 ? { didReleasedFrom: released } : {}),
          ...(Object.keys(changes).length > 0 ? { changes } : {}),
        },
      });
    }

    return NextResponse.json({ user: toAdminUser(updated), released });
  } catch (err) {
    if (isUniqueViolation(err, "users_email_unique")) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;

  if (id === admin.id) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }
  const target = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Refus si l'utilisateur a un historique : les FK en cascade détruiraient ses
  // appels, rendez-vous et relances (KPI, RDV à venir). Désactiver plutôt.
  const [callCount, appointmentCount, followupCount] = await Promise.all([
    db.$count(calls, eq(calls.userId, id)),
    db.$count(appointments, eq(appointments.userId, id)),
    db.$count(followups, eq(followups.assignedToId, id)),
  ]);
  if (callCount + appointmentCount + followupCount > 0) {
    return NextResponse.json({ error: "has_activity" }, { status: 409 });
  }

  // Les clients assignés sont automatiquement désassignés (FK ON DELETE SET NULL).
  await db.delete(users).where(eq(users.id, id));

  // Instantané du compte supprimé (« valeur → rien »), secrets exclus.
  const changes = diffFields(target, null, USER_AUDIT_FIELDS);
  await logAudit({
    userId: admin.id,
    action: "user.delete",
    entity: "user",
    entityId: id,
    detail: { email: target.email, name: target.name, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ ok: true });
}
