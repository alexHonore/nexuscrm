import { asc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { type AuditValue, diffFields, logAudit } from "@/lib/audit";
import { PERMISSION_KEYS } from "@/lib/permissions/catalog";
import {
  apiPerm,
  loadDirectory,
  memberCounts,
  roleForUser,
  saveConfig,
} from "@/lib/permissions/server";
import type { PermissionsConfig, Role } from "@/lib/permissions/types";
import { getSetting } from "@/lib/settings";
import { readJson } from "../_helpers";

/**
 * L'écran « Rôles et droits » — la matrice entière, lue et réécrite EN BLOC.
 *
 * Une matrice ne se rustine pas : décocher un droit, supprimer un rôle et
 * changer le rôle par défaut sont un SEUL geste, et le résultat doit rester
 * cohérent entre les trois. Le formulaire renvoie donc la configuration
 * complète, et `saveConfig` la fait passer par le schéma puis par
 * `repairConfig` — c'est là, et nulle part ici, que tiennent les invariants
 * (un seul super-administrateur, `admin.roles`/`admin.users` hors d'atteinte
 * des autres rôles, rôle par défaut non administrateur). Un corps hostile ne
 * peut donc pas s'inventer les clés de la maison : il sera réparé avant
 * d'atteindre la base.
 */

// ── Lecture ──────────────────────────────────────────────────────────────────

export async function GET() {
  const actor = await apiPerm("admin.roles");
  if (actor instanceof NextResponse) return actor;

  const [config, members, directory] = await Promise.all([
    getSetting("permissions"),
    memberCounts(),
    loadDirectory(),
  ]);

  // Colonnes énumérées une à une : le hachage du mot de passe, le secret SIP
  // et le compteur de sessions ne sortent jamais d'ici, même si la table
  // gagne des colonnes demain.
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
    })
    .from(users)
    .orderBy(asc(users.name));

  return NextResponse.json({
    config,
    members,
    users: rows.map((u) => ({
      ...u,
      /** Le rôle EFFECTIF : affectation, plancher `users.role`, ou défaut. */
      roleId: directory.roleOf.get(u.id)?.id ?? config.defaultRoleId,
    })),
  });
}

// ── Écriture ─────────────────────────────────────────────────────────────────

/**
 * Enveloppe minimale : on vérifie qu'on tient bien une configuration entière,
 * pas un morceau. Le reste passe tel quel au schéma des réglages.
 *
 * `roles` non vide est la seule exigence de forme, et elle vaut son pesant :
 * un corps tronqué (onglet fermé en plein envoi, mauvais appel) donnerait un
 * tableau vide, que `repairConfig` accepterait poliment en réinstallant les
 * rôles livrés — la matrice remise à neuf en silence, sans que personne l'ait
 * demandé.
 */
const envelopeSchema = z.looseObject({ roles: z.array(z.unknown()).min(1) });

/** Les droits COCHÉS d'un rôle, dans l'ordre du catalogue. */
function permKeysOf(role: Role): string[] {
  return PERMISSION_KEYS.filter((k) => role.perms[k] === true);
}

const GLOBAL_FIELDS = [
  "staleDays",
  "claimOnCall",
  "notifyAssignee",
  "notifyPreviousOwner",
] as const;

/**
 * Ce qui a changé, en petit : le journal doit se lire d'un coup d'œil dans
 * /admin/audit. On y consigne les identifiants touchés et les droits ajoutés
 * ou retirés — jamais la configuration entière, qui rendrait la ligne
 * illisible et ferait grossir `audit_logs` sans rien apprendre.
 */
function summarize(
  before: PermissionsConfig,
  after: PermissionsConfig,
): Record<string, AuditValue> {
  const beforeById = new Map(before.roles.map((r) => [r.id, r]));
  const afterById = new Map(after.roles.map((r) => [r.id, r]));

  const rolesAdded = [...afterById.keys()].filter((id) => !beforeById.has(id));
  const rolesRemoved = [...beforeById.keys()].filter((id) => !afterById.has(id));

  const perms: Record<string, AuditValue> = {};
  const renamed: string[] = [];
  const relations: string[] = [];
  const assignment: string[] = [];

  for (const [id, next] of afterById) {
    const prev = beforeById.get(id);
    // Un rôle neuf est déjà annoncé par `rolesAdded` : détailler ses 34 cases
    // n'apprendrait rien de plus.
    if (!prev) continue;

    const was = new Set(permKeysOf(prev));
    const now = new Set(permKeysOf(next));
    const added = [...now].filter((k) => !was.has(k));
    const removed = [...was].filter((k) => !now.has(k));
    if (added.length > 0 || removed.length > 0) {
      perms[id] = {
        ...(added.length > 0 ? { added } : {}),
        ...(removed.length > 0 ? { removed } : {}),
      };
    }

    // `diffFields` compare en profondeur et ignore l'ordre des clés — on ne
    // garde que sa réponse « ça a bougé », le détail vit dans l'écran.
    if (diffFields(prev, next, ["relations"])) relations.push(id);
    if (diffFields(prev, next, ["assignment"])) assignment.push(id);
    if (diffFields(prev, next, ["nameFr", "nameEn", "look", "sortOrder"])) renamed.push(id);
  }

  const global = diffFields(before.assignment, after.assignment, GLOBAL_FIELDS);

  // Supprimer un rôle DÉPLACE des comptes : leurs affectations sont oubliées
  // et ils retombent sur le rôle par défaut. « rôle supprimé » tout seul ne
  // raconte pas que trois personnes ont changé de droits dans la foulée.
  const usersMoved = Object.keys(before.userRoles).filter(
    (userId) => !(userId in after.userRoles),
  ).length;

  const detail: Record<string, AuditValue> = {
    ...(rolesAdded.length > 0 ? { rolesAdded } : {}),
    ...(rolesRemoved.length > 0 ? { rolesRemoved } : {}),
    ...(Object.keys(perms).length > 0 ? { perms } : {}),
    ...(relations.length > 0 ? { relations } : {}),
    ...(assignment.length > 0 ? { assignment } : {}),
    ...(renamed.length > 0 ? { renamed } : {}),
    ...(usersMoved > 0 ? { usersMoved } : {}),
    ...(before.defaultRoleId !== after.defaultRoleId
      ? { defaultRoleId: { from: before.defaultRoleId, to: after.defaultRoleId } }
      : {}),
    ...(global ? { global } : {}),
  };

  // Un enregistrement sans effet reste consigné : savoir QUI a ouvert la
  // matrice et l'a réenregistrée telle quelle vaut mieux qu'un trou.
  return Object.keys(detail).length > 0 ? detail : { unchanged: true };
}

/**
 * Combien de comptes portent chaque rôle, D'APRÈS une configuration donnée.
 *
 * `memberCounts()` ne convient pas après une écriture : son annuaire est mis
 * en cache pour la durée de la requête, donc il compterait encore avec la
 * matrice d'AVANT — un rôle supprimé garderait ses membres à l'écran.
 */
async function countMembers(cfg: PermissionsConfig): Promise<Record<string, number>> {
  const rows = await db.select({ id: users.id, role: users.role }).from(users);
  const out: Record<string, number> = {};
  for (const row of rows) {
    const id = roleForUser(cfg, row).id;
    out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

/**
 * Les identifiants de rôle que le corps envoyé CONSERVE.
 *
 * Lus à la main : à ce stade le corps n'est validé qu'en surface (le schéma
 * des réglages tranche plus loin). Ce qui n'a pas d'identifiant lisible ne
 * compte pas comme conservé — au pire on est indulgent sur un envoi qui sera
 * réparé de toute façon.
 */
function sentRoleIds(roles: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const role of roles) {
    if (role === null || typeof role !== "object") continue;
    const id = (role as { id?: unknown }).id;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * La table d'affectation envoyée dit-elle la MÊME chose que celle en base ?
 *
 * « La même chose » tolère un seul écart : une entrée retirée parce que SON
 * RÔLE disparaît dans le même envoi. C'est exactement la suppression d'un rôle
 * occupé — l'écran l'annonce (« les comptes retombent sur le rôle par défaut »)
 * et `repairConfig` l'exécute. Refuser cet écart-là rendait la suppression d'un
 * rôle qui a des membres IMPOSSIBLE, et sans jamais dire pourquoi.
 *
 * L'indulgence ne coûte rien : on réécrit `before.userRoles` quoi qu'il arrive,
 * donc une entrée « acceptée comme retirée » n'est réellement oubliée que si
 * `repairConfig` constate lui-même que son rôle a disparu.
 *
 * Tout le reste — une affectation ajoutée, changée, ou retirée alors que son
 * rôle demeure — reste un 409 : `users.role` et `cfg.userRoles` s'écrivent
 * ensemble dans /api/admin/users, ou ils divergent.
 */
function userRolesUnchanged(
  stored: Record<string, string>,
  sent: unknown,
  keptRoleIds: ReadonlySet<string>,
): boolean {
  if (sent === null || typeof sent !== "object" || Array.isArray(sent)) return false;
  const other = sent as Record<string, unknown>;
  // Rien d'ajouté ni de changé : chaque entrée envoyée existe en base, à l'identique.
  for (const [userId, roleId] of Object.entries(other)) {
    if (stored[userId] !== roleId) return false;
  }
  // Rien de retiré, sauf ce que la suppression d'un rôle emporte avec elle.
  for (const [userId, roleId] of Object.entries(stored)) {
    if (userId in other) continue;
    if (keptRoleIds.has(roleId)) return false;
  }
  return true;
}

export async function PUT(req: Request) {
  const actor = await apiPerm("admin.roles");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, envelopeSchema);
  if (body instanceof NextResponse) return body;

  const before = await getSetting("permissions");

  /**
   * Le rôle d'un COMPTE ne se change pas ici.
   *
   * `users.role` (le plancher « admin » de la base) et `cfg.userRoles` doivent
   * dire la même chose : c'est `setUserRole`, appelé par /api/admin/users, qui
   * écrit les deux ensemble. Laisser cet écran réécrire `userRoles` ferait
   * diverger les deux à la première main mal assurée — un compte
   * administrateur en base rétrogradé dans la configuration, ou l'inverse.
   * On refuse donc l'écart au lieu de l'appliquer, et on force la table
   * enregistrée dans ce qu'on écrit : un corps qui l'omet ne l'efface pas.
   *
   * Une seule exception, et elle n'écrit rien : les entrées dont le RÔLE
   * disparaît dans le même envoi (suppression d'un rôle occupé). Voir
   * `userRolesUnchanged` — c'est `repairConfig` qui les oublie, pas ce corps.
   */
  const sentUserRoles = (body as Record<string, unknown>).userRoles;
  if (
    sentUserRoles !== undefined &&
    !userRolesUnchanged(before.userRoles, sentUserRoles, sentRoleIds(body.roles))
  ) {
    return NextResponse.json({ error: "user_roles_readonly" }, { status: 409 });
  }

  let after: PermissionsConfig;
  try {
    const next = { ...body, userRoles: before.userRoles } as unknown as PermissionsConfig;
    after = await saveConfig(next);
  } catch (err) {
    // Le schéma des réglages est la validation : ce qu'il refuse n'a aucune
    // chance d'être réparé ici (identifiant de rôle illégal, nom vide…).
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid", issues: err.issues }, { status: 422 });
    }
    throw err;
  }

  await logAudit({
    userId: actor.user.id,
    action: "permissions.update",
    entity: "settings",
    entityId: "permissions",
    detail: summarize(before, after),
  });

  // Les droits décident de la NAVIGATION : un menu rendu avant l'écriture
  // montrerait encore des écrans devenus interdits (le serveur les refuserait,
  // mais le lien resterait). On périme donc la coquille de l'application et
  // les écrans dont le contenu dépend de la portée de lecture.
  revalidatePath("/(app)", "layout");
  revalidatePath("/dashboard");
  revalidatePath("/clients");
  revalidatePath("/admin/roles");

  return NextResponse.json({ config: after, members: await countMembers(after) });
}
