import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { appointments, calls, comments, followups, users } from "@/db/schema";
import { diffFields, logAudit, secretChange } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { isUniqueViolation } from "@/lib/db-errors";
import { encryptSecret } from "@/lib/crypto";
import { normalizePhone } from "@/lib/phone";
import { ROLE_ID_RE } from "@/lib/permissions/schema";
import {
  forgetUserRole,
  loadDirectory,
  roleForUser,
  setUserRole,
} from "@/lib/permissions/server";
import { releaseDidFromOthers } from "../../voipms/_assignments";
import { readJson, requestedRole, toAdminUser } from "../../_helpers";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.email().trim().toLowerCase().optional(),
  /** Le rôle configuré — écrit par `setUserRole`, jamais `users.role` à la main. */
  roleId: z.string().trim().regex(ROLE_ID_RE).optional(),
  /** Ancienne forme (le plancher de la base) — encore acceptée, traduite. */
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

/**
 * Combien de comptes ACTIFS porteraient encore le rôle super-administrateur si
 * ce changement était appliqué.
 *
 * Le garde-fou que le code n'a jamais eu : tant qu'il n'y avait que deux
 * rôles, se rétrograder soi-même était la seule façon de se fermer la porte, et
 * c'était déjà refusé. Avec des rôles configurables, « Superviseur » ressemble
 * à un rôle qui peut tout — il ne peut ni les comptes ni la matrice. Un CRM
 * sans un seul administrateur actif ne se rouvre plus depuis l'application.
 *
 * On simule au lieu de compter après coup : l'annuaire est celui d'AVANT le
 * changement (il est mis en cache pour la requête), donc on lui applique la
 * modification en mémoire.
 */
async function activeSuperAdminsAfter(change: {
  userId: string;
  superAdmin?: boolean;
  isActive?: boolean;
}): Promise<number> {
  const { rows, roleOf } = await loadDirectory();
  let count = 0;
  for (const row of rows) {
    const touched = row.id === change.userId;
    const superAdmin =
      touched && change.superAdmin !== undefined
        ? change.superAdmin
        : roleOf.get(row.id)?.superAdmin === true;
    const active = touched && change.isActive !== undefined ? change.isActive : row.isActive;
    if (superAdmin && active) count++;
  }
  return count;
}

export async function PATCH(req: Request, ctx: Ctx) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const { id } = await ctx.params;
  // Colonne uuid : un identifiant mal formé ferait lever Postgres (500).
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const target = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { cfg } = await loadDirectory();
  const asked = requestedRole(cfg, body);
  if (asked instanceof NextResponse) return asked;
  const previousRole = roleForUser(cfg, target);
  const nextRole = asked && asked.id !== previousRole.id ? asked : null;

  // Garde-fous : un admin ne peut ni se désactiver ni se rétrograder lui-même.
  if (id === admin.id && body.isActive === false) {
    return NextResponse.json({ error: "cannot_deactivate_self" }, { status: 400 });
  }
  // La question n'est plus « est-ce “caller” ? » : avec des rôles configurables,
  // tout ce qui n'est pas LE rôle super-administrateur est une rétrogradation —
  // « Superviseur » compris, qui ne peut ni les comptes ni la matrice.
  if (id === admin.id && asked && !asked.superAdmin) {
    return NextResponse.json({ error: "cannot_demote_self" }, { status: 400 });
  }
  // Et le refus qui vaut pour tous : ne jamais laisser le CRM sans un seul
  // compte actif capable de rouvrir les portes (voir `activeSuperAdminsAfter`).
  if ((nextRole && !nextRole.superAdmin) || body.isActive === false) {
    const remaining = await activeSuperAdminsAfter({
      userId: id,
      ...(nextRole ? { superAdmin: nextRole.superAdmin } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    });
    if (remaining === 0) return NextResponse.json({ error: "last_admin" }, { status: 409 });
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
  // `set.role` reste vide : le plancher de la base se pose avec l'affectation,
  // par `setUserRole`, une fois le reste enregistré.
  if (nextRole) changed.push("role");
  if (body.locale !== undefined && body.locale !== target.locale) {
    set.locale = body.locale;
    changed.push("locale");
  }
  if (body.sipUsername !== undefined) {
    set.sipUsername = body.sipUsername || null;
    if ((body.sipUsername || null) !== target.sipUsername) {
      changed.push("sipUsername");
      // Le mot de passe stocké appartenait à l'ANCIEN sous-compte : le garder
      // produirait une ligne qui paraît configurée mais ne peut pas
      // s'enregistrer. On l'efface (sauf si l'admin en fournit un nouveau
      // ci-dessous) pour que « Vérifier la ligne » signale password_missing
      // et propose « Resynchroniser ».
      set.sipPasswordEnc = null;
    }
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

    // Le rôle EN DERNIER : `setUserRole` écrit la matrice et le plancher
    // ensemble, et un courriel refusé (409) plus haut ne doit pas laisser
    // derrière lui un compte déjà promu.
    const floor = nextRole ? (await setUserRole(id, nextRole.id)).floor : updated.role;
    const saved = { ...updated, role: floor };

    if (changed.length > 0) {
      const changes = diffFields(target, saved, USER_AUDIT_FIELDS) ?? {};
      // Le journal doit dire « Téléphoniste → Superviseur ». Le plancher, lui,
      // ne distingue plus rien : trois rôles sur quatre valent « caller ».
      if (nextRole) {
        changes.role = { from: previousRole.nameFr, to: nextRole.nameFr };
      }
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

    return NextResponse.json({
      user: toAdminUser(saved, undefined, nextRole ?? previousRole),
      released,
    });
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
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  if (id === admin.id) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }
  const target = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Supprimer le dernier administrateur actif ferme le CRM à clé, de l'extérieur.
  if ((await activeSuperAdminsAfter({ userId: id, superAdmin: false })) === 0) {
    return NextResponse.json({ error: "last_admin" }, { status: 409 });
  }

  const { cfg } = await loadDirectory();
  const deletedRole = roleForUser(cfg, target);

  // Refus si l'utilisateur a un historique : les FK en cascade détruiraient ses
  // appels, rendez-vous, relances (KPI, RDV à venir) et les commentaires qu'il
  // a laissés sur les fiches clients (historique du dossier). Désactiver plutôt.
  const [callCount, appointmentCount, followupCount, commentCount] = await Promise.all([
    db.$count(calls, eq(calls.userId, id)),
    db.$count(appointments, eq(appointments.userId, id)),
    db.$count(followups, eq(followups.assignedToId, id)),
    db.$count(comments, eq(comments.userId, id)),
  ]);
  if (callCount + appointmentCount + followupCount + commentCount > 0) {
    return NextResponse.json({ error: "has_activity" }, { status: 409 });
  }

  // Les clients assignés sont automatiquement désassignés (FK ON DELETE SET NULL).
  await db.delete(users).where(eq(users.id, id));

  // L'affectation ne survit pas au compte : sans ça, la matrice garde pour
  // toujours un identifiant qui ne désigne plus personne — et le jour où
  // Postgres réattribue cet UUID, il hérite du rôle d'un disparu.
  await forgetUserRole(id);

  // Instantané du compte supprimé (« valeur → rien »), secrets exclus.
  const changes = diffFields(target, null, USER_AUDIT_FIELDS);
  await logAudit({
    userId: admin.id,
    action: "user.delete",
    entity: "user",
    entityId: id,
    detail: {
      email: target.email,
      name: target.name,
      // Le rôle disparaît avec le compte : le journal est le seul endroit qui
      // dira encore ce que cette personne avait le droit de faire.
      role: deletedRole.nameFr,
      roleId: deletedRole.id,
      ...(changes ? { changes } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
