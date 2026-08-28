import "server-only";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { cache } from "react";
import { db } from "@/db";
import { clients, users } from "@/db/schema";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/guards";
import { getSetting, setSetting } from "@/lib/settings";
import {
  type AssignVerdict,
  type ClientRef,
  type Scope,
  bucketFor,
  can,
  canAssignTo,
  canClaim,
  canRelease,
  grantsFor,
  readScope,
  roleById,
  roleForUser,
} from "./access";
import { type Bucket, type Grants, type PermissionKey, noGrants } from "./catalog";
import type { PermissionsConfig, Role } from "./types";

/**
 * Le CÔTÉ SERVEUR des droits : la configuration, l'annuaire des comptes, et
 * les gardes que les pages et les routes appellent.
 *
 * Tout est mis en cache par requête (`cache()` de React) : une page qui pose
 * dix fois la question ne fait qu'une lecture de la table `settings` et une du
 * répertoire des comptes. C'est ce qui rend acceptable d'interroger la matrice
 * partout plutôt que de la deviner une fois et de la trimballer en props.
 */

export const loadPermissions = cache(
  async (): Promise<PermissionsConfig> => getSetting("permissions"),
);

/** Identifiant → (rôle en base, rôle effectif). Quelques dizaines de lignes. */
export const loadDirectory = cache(async () => {
  const cfg = await loadPermissions();
  const rows = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive, name: users.name })
    .from(users);

  const roleOf = new Map<string, Role>();
  const usersByRole = new Map<string, string[]>();
  for (const row of rows) {
    const role = roleForUser(cfg, { id: row.id, role: row.role });
    roleOf.set(row.id, role);
    const list = usersByRole.get(role.id) ?? [];
    list.push(row.id);
    usersByRole.set(role.id, list);
  }
  return { cfg, rows, roleOf, usersByRole };
});

// ── L'acteur ─────────────────────────────────────────────────────────────────

export type Actor = {
  user: CurrentUser;
  cfg: PermissionsConfig;
  role: Role;
  /** A-t-il ce droit, tous compartiments confondus ? */
  can: (key: PermissionKey) => boolean;
};

export const currentActor = cache(async (): Promise<Actor | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const cfg = await loadPermissions();
  const role = roleForUser(cfg, user);
  return { user, cfg, role, can: (key) => can(role, key) };
});

/** Pour une page : renvoie vers /dashboard quand le droit manque. */
export async function requirePerm(key: PermissionKey): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  if (!actor.can(key)) redirect("/dashboard");
  return actor;
}

/** Pour une page qui exige seulement d'être connecté, mais veut le rôle. */
export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  return actor;
}

/**
 * Pour une route d'API.
 * Usage : `const a = await apiPerm("clients.edit"); if (a instanceof NextResponse) return a;`
 */
export async function apiPerm(key: PermissionKey): Promise<Actor | NextResponse> {
  const actor = await currentActor();
  if (!actor) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!actor.can(key)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return actor;
}

export async function apiActor(): Promise<Actor | NextResponse> {
  const actor = await currentActor();
  if (!actor) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return actor;
}

// ── Une fiche à la fois ──────────────────────────────────────────────────────

/** Le rôle du détenteur d'une fiche (null quand elle est au bassin). */
export async function assigneeRole(assignedToId: string | null): Promise<Role | null> {
  if (!assignedToId) return null;
  const { roleOf } = await loadDirectory();
  return roleOf.get(assignedToId) ?? null;
}

export async function bucketOf(actor: Actor, client: ClientRef): Promise<Bucket> {
  return bucketFor(actor.user.id, client, await assigneeRole(client.assignedToId));
}

/** Les cases ouvertes sur CETTE fiche — la question la plus posée du module. */
export async function grantsOnClient(actor: Actor, client: ClientRef): Promise<Grants> {
  return grantsFor(actor.cfg, actor.role, await bucketOf(actor, client));
}

/**
 * La fiche existe-t-elle pour lui ? À utiliser avant tout `notFound()` : une
 * fiche invisible se comporte comme une fiche absente, jamais comme un refus —
 * un « accès interdit » confirmerait justement ce qu'on cache.
 */
export async function canSeeClient(actor: Actor, client: ClientRef): Promise<boolean> {
  return (await grantsOnClient(actor, client)).visible;
}

/** Charge la fiche RÉDUITE aux colonnes qui décident de l'accès. */
export async function clientRef(clientId: string): Promise<(ClientRef & { id: string }) | null> {
  const row = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
    columns: { id: true, assignedToId: true, lastContactedAt: true, updatedAt: true },
  });
  return row ?? null;
}

/**
 * Garde d'action : charge la fiche, vérifie qu'elle est visible ET que la case
 * demandée est ouverte. Rend `null` dans tous les cas de refus — l'appelant
 * répond « introuvable » sans distinguer, ce qui ne renseigne personne.
 */
export async function guardClient(
  actor: Actor,
  clientId: string,
  grant: keyof Grants,
): Promise<{ ref: ClientRef & { id: string }; grants: Grants } | null> {
  const ref = await clientRef(clientId);
  if (!ref) return null;
  const grants = await grantsOnClient(actor, ref);
  if (!grants.visible || !grants[grant]) return null;
  return { ref, grants };
}

// ── Une liste à la fois ──────────────────────────────────────────────────────

export async function scopeFor(actor: Actor): Promise<Scope> {
  const { usersByRole } = await loadDirectory();
  return readScope(actor.cfg, actor.role, actor.user.id, usersByRole);
}

/**
 * La portée traduite en condition SQL sur `clients.assigned_to_id`.
 * `undefined` = aucune restriction. Une portée vide rend `false` : la requête
 * s'exécute et ne trouve rien, plutôt que d'oublier le filtre.
 */
export function scopeCondition(scope: Scope, viewerId: string): SQL | undefined {
  if (scope.kind === "all") return undefined;
  if (scope.kind === "none") return sql`false`;
  const parts: SQL[] = [];
  if (scope.own) parts.push(eq(clients.assignedToId, viewerId));
  if (scope.unassigned) parts.push(isNull(clients.assignedToId));
  if (scope.userIds.length > 0) parts.push(inArray(clients.assignedToId, scope.userIds));
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? parts[0] : or(...parts)!;
}

/** Raccourci : la condition de visibilité de l'acteur courant. */
export async function visibilityCondition(actor: Actor): Promise<SQL | undefined> {
  return scopeCondition(await scopeFor(actor), actor.user.id);
}

/** `and()` d'une condition métier et de la visibilité — le motif courant. */
export async function withVisibility(
  actor: Actor,
  where: SQL | undefined,
): Promise<SQL | undefined> {
  const vis = await visibilityCondition(actor);
  if (!vis) return where;
  return where ? and(where, vis) : vis;
}

// ── Assignation ──────────────────────────────────────────────────────────────

/** Combien de fiches cette personne détient — pour le plafond du rôle. */
export async function ownedCount(userId: string): Promise<number> {
  return db.$count(clients, eq(clients.assignedToId, userId));
}

export async function verifyAssignment(
  actor: Actor,
  client: ClientRef,
  targetUserId: string | null,
  now = new Date(),
): Promise<AssignVerdict> {
  const holder = await assigneeRole(client.assignedToId);
  if (targetUserId === null) {
    return canRelease(actor.cfg, actor.role, actor.user.id, client, holder, now);
  }
  if (targetUserId === actor.user.id) {
    return canClaim(
      actor.cfg,
      actor.role,
      actor.user.id,
      client,
      holder,
      await ownedCount(actor.user.id),
      now,
    );
  }
  return canAssignTo(
    actor.cfg,
    actor.role,
    actor.user.id,
    client,
    holder,
    targetUserId,
    await ownedCount(targetUserId),
    now,
  );
}

// ── Écriture ─────────────────────────────────────────────────────────────────

/**
 * Enregistre la configuration. `setSetting` la fait passer par `repairConfig`,
 * donc ce qui est écrit est toujours cohérent, même envoyé par un onglet
 * ouvert depuis une heure.
 */
export async function saveConfig(next: PermissionsConfig): Promise<PermissionsConfig> {
  await setSetting("permissions", next);
  return getSetting("permissions");
}

/**
 * Donne un rôle à un compte, et remet le PLANCHER de base de données d'accord
 * avec lui.
 *
 * `users.role` ne peut valoir que « admin » ou « caller » (énumération figée du
 * schéma). On s'en sert donc pour ce qu'elle sait dire : administrateur, ou
 * pas. Tout le reste — superviseur, observateur, un rôle inventé ce matin —
 * vit dans la configuration. Les deux ne peuvent pas diverger : le rôle
 * administrateur, et lui seul, met le plancher à « admin ».
 *
 * Écrit les deux choses ; l'appelant journalise (`logAudit`) et revalide.
 */
export async function setUserRole(
  userId: string,
  roleId: string,
): Promise<{ role: Role; floor: "admin" | "caller" }> {
  const cfg = await getSetting("permissions");
  const role = roleById(cfg, roleId);
  if (!role) throw new Error(`unknown_role:${roleId}`);

  const next: PermissionsConfig = {
    ...cfg,
    userRoles: { ...cfg.userRoles, [userId]: role.id },
  };
  await setSetting("permissions", next);

  const floor = role.superAdmin ? "admin" : "caller";
  await db.update(users).set({ role: floor, updatedAt: new Date() }).where(eq(users.id, userId));
  return { role, floor };
}

/** Oublie l'affectation d'un compte supprimé — sinon elle traîne pour toujours. */
export async function forgetUserRole(userId: string): Promise<void> {
  const cfg = await getSetting("permissions");
  if (!(userId in cfg.userRoles)) return;
  const userRoles = { ...cfg.userRoles };
  delete userRoles[userId];
  await setSetting("permissions", { ...cfg, userRoles });
}

/** Combien de comptes portent chaque rôle — pour l'écran des rôles. */
export async function memberCounts(): Promise<Record<string, number>> {
  const { rows, roleOf } = await loadDirectory();
  const out: Record<string, number> = {};
  for (const row of rows) {
    const id = roleOf.get(row.id)?.id;
    if (id) out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

// ── Confort ──────────────────────────────────────────────────────────────────

export { can, grantsFor, noGrants, roleById, roleForUser };
export type { Grants, PermissionKey, PermissionsConfig, Role, Scope };
