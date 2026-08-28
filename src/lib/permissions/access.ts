/**
 * La RÉSOLUTION des droits : des fonctions pures, sans base de données ni
 * traduction, qui répondent à trois questions et rien d'autre.
 *
 *   quel rôle a cette personne ?        → `roleForUser`
 *   a-t-elle ce droit ?                 → `can`
 *   et sur CETTE fiche-là ?             → `grantsOn`
 *
 * Tout est pur pour une raison précise : c'est le seul moyen de TESTER une
 * matrice de droits. Un test unitaire construit une configuration, pose la
 * question et lit la réponse — sans base, sans session, sans écran.
 */
import {
  type Bucket,
  type Grants,
  GRANT_CEILING,
  GRANT_KEYS,
  LOCKED_TO_ADMIN,
  type PermissionKey,
  allGrants,
  noGrants,
  roleBucket,
} from "./catalog";
import type { PermissionsConfig, Role } from "./types";

/** L'identité minimale dont la résolution a besoin — pas la rangée entière. */
export type Viewer = {
  id: string;
  /** Le plancher en base : `admin` a tout, quoi qu'on configure. */
  role: "admin" | "caller";
};

/** La fiche, réduite à ce qui décide de l'accès. */
export type ClientRef = {
  assignedToId: string | null;
  lastContactedAt?: Date | null;
  updatedAt?: Date | null;
};

// ── Rôles ────────────────────────────────────────────────────────────────────

export function roleById(cfg: PermissionsConfig, id: string | null | undefined): Role | null {
  if (!id) return null;
  return cfg.roles.find((r) => r.id === id) ?? null;
}

/** Le rôle administrateur — il existe toujours (le schéma le garantit). */
export function adminRole(cfg: PermissionsConfig): Role {
  return cfg.roles.find((r) => r.superAdmin) ?? cfg.roles[0];
}

/**
 * Le rôle EFFECTIF d'une personne.
 *
 * `users.role = "admin"` prime sur la table d'affectation : c'est le plancher
 * de la base de données, et un compte administrateur ne doit jamais pouvoir
 * être rétrogradé par une clé JSON mal formée. Dans l'autre sens, un compte
 * `caller` sans affectation retombe sur le rôle par défaut.
 */
export function roleForUser(cfg: PermissionsConfig, user: Viewer): Role {
  if (user.role === "admin") return adminRole(cfg);
  const assigned = roleById(cfg, cfg.userRoles[user.id]);
  if (assigned && !assigned.superAdmin) return assigned;
  return roleById(cfg, cfg.defaultRoleId) ?? cfg.roles.find((r) => !r.superAdmin) ?? adminRole(cfg);
}

/** Le rôle du DÉTENTEUR d'une fiche — ce qui décide du compartiment. */
export function roleOfUserId(
  cfg: PermissionsConfig,
  userId: string,
  isAdmin: boolean,
): Role {
  return roleForUser(cfg, { id: userId, role: isAdmin ? "admin" : "caller" });
}

// ── Droits ───────────────────────────────────────────────────────────────────

export function can(role: Role, key: PermissionKey): boolean {
  if (role.superAdmin) return true;
  if (LOCKED_TO_ADMIN.includes(key)) return false;
  return role.perms[key] === true;
}

/** Tous les droits d'un rôle, à plat — pour envoyer l'état à un écran. */
export function permsOf(role: Role, keys: readonly PermissionKey[]): Record<string, boolean> {
  return Object.fromEntries(keys.map((k) => [k, can(role, k)]));
}

// ── Relations ────────────────────────────────────────────────────────────────

/**
 * Dans quel compartiment tombe cette fiche pour ce regard ?
 *
 * `assigneeRole` est le rôle du détenteur, résolu par l'appelant (lui seul
 * sait qui est administrateur). Fiche à moi → `own`, à personne →
 * `unassigned`, à un autre → le compartiment de SON rôle.
 */
export function bucketFor(
  viewerId: string,
  client: ClientRef,
  assigneeRole: Role | null,
): Bucket {
  if (!client.assignedToId) return "unassigned";
  if (client.assignedToId === viewerId) return "own";
  return assigneeRole ? roleBucket(assigneeRole.id) : roleBucket("__unknown__");
}

/**
 * Les cases OUVERTES d'un compartiment, plafonnées par les droits du rôle.
 *
 * Un compartiment absent est FERMÉ. Ce repli ne se déclenche plus dans la vie
 * courante : `repairConfig` (schema.ts) MATÉRIALISE le compartiment de chaque
 * rôle chez chaque rôle, donc l'entrée existe toujours dans une configuration
 * chargée. Ce qui peut encore manquer ici n'est qu'un compartiment inventé —
 * `role:__unknown__`, une fiche tenue par un compte disparu de l'annuaire — et
 * une fiche dont on ne sait plus à qui elle est ne s'ouvre à personne.
 *
 * Le repli d'avant (« prendre le compartiment du rôle par défaut ») ouvrait
 * ces fiches au niveau téléphoniste pendant que l'écran des rôles montrait les
 * mêmes cases FERMÉES : le moteur et l'écran se contredisaient, ce qui est le
 * pire résultat possible pour une matrice qu'on règle à la main. La graine est
 * désormais posée une fois pour toutes à la réparation, en clair.
 */
export function grantsFor(cfg: PermissionsConfig, role: Role, bucket: Bucket): Grants {
  if (role.superAdmin) return allGrants();
  const raw = role.relations[bucket] ?? {};
  const out = noGrants();
  for (const key of GRANT_KEYS) {
    if (raw[key] !== true) continue;
    const ceiling = GRANT_CEILING[key];
    out[key] = ceiling === null || can(role, ceiling);
  }
  return out;
}

/** Raccourci : le compartiment ET les cases, en une fois. */
export function grantsOn(
  cfg: PermissionsConfig,
  role: Role,
  viewerId: string,
  client: ClientRef,
  assigneeRole: Role | null,
): Grants {
  return grantsFor(cfg, role, bucketFor(viewerId, client, assigneeRole));
}

/** La fiche existe-t-elle pour ce regard ? (la question posée le plus souvent) */
export function sees(grants: Grants): boolean {
  return grants.visible;
}

// ── Portée de lecture (pour filtrer une LISTE) ───────────────────────────────

/**
 * De quoi bâtir un `where` : plutôt que d'interroger la matrice fiche par
 * fiche (impossible en SQL), on la réduit une fois à « quels détenteurs sont
 * visibles ».
 */
export type Scope =
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "some"; own: boolean; unassigned: boolean; userIds: string[] };

/**
 * La portée de LECTURE — quelles fiches EXISTENT pour ce regard.
 *
 * @param usersByRole rôle → identifiants des comptes qui le portent
 *
 * La même mécanique saurait répondre pour une AUTRE case (« sur quelles fiches
 * ai-je droit aux COORDONNÉES », ce qu'il faut savoir pour qu'une recherche par
 * numéro ne devienne pas un oracle). Elle l'a su, sous le nom `grantScope`, et
 * personne ne l'appelait : les deux écrans concernés — la liste des fiches et
 * le journal des appels — résolvent le compartiment UNE FOIS PAR DÉTENTEUR à
 * partir de `loadDirectory()` et `grantsFor()`, ce qui leur donne en prime le
 * masquage ligne à ligne qu'une portée SQL ne sait pas faire. Une portée
 * générique sans appelant est une API qu'on finit par employer de travers :
 * elle est retirée, pas gardée « au cas où ».
 */
export function readScope(
  cfg: PermissionsConfig,
  role: Role,
  viewerId: string,
  usersByRole: Map<string, string[]>,
): Scope {
  if (role.superAdmin) return { kind: "all" };

  const own = grantsFor(cfg, role, "own").visible;
  const unassigned = grantsFor(cfg, role, "unassigned").visible;
  const userIds: string[] = [];
  let everyRoleOpen = true;

  for (const other of cfg.roles) {
    if (!grantsFor(cfg, role, roleBucket(other.id)).visible) {
      everyRoleOpen = false;
      continue;
    }
    for (const id of usersByRole.get(other.id) ?? []) {
      if (id !== viewerId) userIds.push(id);
    }
  }

  if (own && unassigned && everyRoleOpen) return { kind: "all" };
  if (!own && !unassigned && userIds.length === 0) return { kind: "none" };
  return { kind: "some", own, unassigned, userIds };
}

// ── Assignation ──────────────────────────────────────────────────────────────

export type AssignRefusal =
  | "no_right"
  /** La fiche est prise par quelqu'un d'autre et son verrou tient encore. */
  | "locked"
  /** Plafond de fiches détenues atteint. */
  | "cap_reached"
  /** Le compartiment de cette fiche ne lui ouvre pas l'assignation. */
  | "not_allowed_here";

export type AssignVerdict = { ok: true } | { ok: false; reason: AssignRefusal };

const OK: AssignVerdict = { ok: true };
const refuse = (reason: AssignRefusal): AssignVerdict => ({ ok: false, reason });

/**
 * Le VERROU a-t-il expiré ? « N jours sans contact » se lit sur le dernier
 * contact, et à défaut (fiche jamais contactée) sur sa dernière modification —
 * sinon une fiche prise et jamais appelée serait verrouillée pour l'éternité.
 */
export function lockExpired(
  client: ClientRef,
  staleDays: number,
  now: Date,
): boolean {
  if (staleDays <= 0) return false;
  const since = client.lastContactedAt ?? client.updatedAt ?? null;
  if (!since) return true;
  return now.getTime() - since.getTime() > staleDays * 86_400_000;
}

/**
 * Peut-il PRENDRE cette fiche (se l'attribuer) ?
 *
 * @param ownedCount fiches qu'il détient déjà — sert au plafond.
 */
export function canClaim(
  cfg: PermissionsConfig,
  role: Role,
  viewerId: string,
  client: ClientRef,
  assigneeRole: Role | null,
  ownedCount: number,
  now: Date,
): AssignVerdict {
  if (role.superAdmin) return OK;
  const bucket = bucketFor(viewerId, client, assigneeRole);
  // La case du compartiment se pose EN PREMIER, y compris sur ses propres
  // fiches : fermer « assign » sur `own` doit fermer l'assignation sur `own`,
  // sinon la case ment. Le cas est certes sans effet (la fiche est déjà à lui)
  // mais l'écran lit ce verdict pour afficher le bouton — répondre « oui » là
  // où le rôle n'a aucun droit d'assignation ferait apparaître un bouton que
  // le serveur refuserait ensuite.
  if (!grantsFor(cfg, role, bucket).assign) return refuse("not_allowed_here");
  if (bucket === "own") return OK; // déjà à lui : il n'y a rien à prendre

  if (bucket === "unassigned") {
    if (!role.assignment.claimPool) return refuse("no_right");
  } else if (!role.assignment.takeFromOthers && !lockExpired(client, cfg.assignment.staleDays, now)) {
    // Une fiche déjà prise : soit il a le droit de la retirer, soit le verrou
    // a expiré. C'est TOUT le dispositif anti-vol.
    return refuse("locked");
  }

  const cap = role.assignment.maxOwned;
  if (cap > 0 && ownedCount >= cap) return refuse("cap_reached");
  return OK;
}

/** Peut-il DONNER cette fiche à quelqu'un d'autre ? */
export function canAssignTo(
  cfg: PermissionsConfig,
  role: Role,
  viewerId: string,
  client: ClientRef,
  assigneeRole: Role | null,
  targetUserId: string,
  ownedCount: number,
  now: Date,
): AssignVerdict {
  if (role.superAdmin) return OK;
  // Se donner la fiche à soi-même, c'est la PRENDRE — plafond compris.
  if (targetUserId === viewerId) {
    return canClaim(cfg, role, viewerId, client, assigneeRole, ownedCount, now);
  }
  if (!role.assignment.assignToOthers) return refuse("no_right");
  const bucket = bucketFor(viewerId, client, assigneeRole);
  if (!grantsFor(cfg, role, bucket).assign) return refuse("not_allowed_here");
  if (
    bucket !== "own" &&
    bucket !== "unassigned" &&
    !role.assignment.takeFromOthers &&
    !lockExpired(client, cfg.assignment.staleDays, now)
  ) {
    return refuse("locked");
  }
  return OK;
}

/** Peut-il RENDRE cette fiche au bassin ? */
export function canRelease(
  cfg: PermissionsConfig,
  role: Role,
  viewerId: string,
  client: ClientRef,
  assigneeRole: Role | null,
  now: Date,
): AssignVerdict {
  if (role.superAdmin) return OK;
  const bucket = bucketFor(viewerId, client, assigneeRole);
  if (bucket === "unassigned") return OK;
  if (bucket === "own") {
    // Les DEUX doivent être d'accord, comme dans toutes les autres branches :
    // le règlement du rôle (« il a le droit de rendre ») ET la case du
    // compartiment (« l'assignation est ouverte sur ses propres fiches »).
    // Sans la seconde, fermer l'assignation sur `own` ne fermait rien : le
    // rôle continuait de renvoyer ses fiches au bassin, c'est-à-dire de s'en
    // défaire — exactement ce que la case prétendait interdire.
    if (!grantsFor(cfg, role, bucket).assign) return refuse("not_allowed_here");
    return role.assignment.release ? OK : refuse("no_right");
  }
  // La fiche est à quelqu'un d'autre : la rendre au bassin, c'est la lui
  // retirer — même verrou que pour se la prendre.
  if (!grantsFor(cfg, role, bucket).assign) return refuse("not_allowed_here");
  if (!role.assignment.takeFromOthers) {
    return lockExpired(client, cfg.assignment.staleDays, now) ? OK : refuse("locked");
  }
  return OK;
}
