/**
 * Le schéma du réglage `permissions` — et surtout ses RÉPARATIONS.
 *
 * Ce schéma est délibérément indulgent, et même TOTAL : quoi qu'il y ait dans
 * la colonne — un objet à moitié écrit, une chaîne, un nombre, un tableau,
 * `null` —, l'analyse rend une configuration au lieu d'échouer.
 *
 * Ce n'est pas de la coquetterie. `getSetting` remplace une analyse ratée par
 * `schema.parse({})`, c'est-à-dire par les rôles LIVRÉS avec `userRoles` VIDE :
 * chaque superviseur et chaque observateur redeviendrait téléphoniste en
 * silence, sur une virgule mal placée. Un magasin d'autorisations n'a pas le
 * droit d'échouer OUVERT. On accepte donc largement, on répare, on jette au
 * plus près (un rôle illisible tombe seul, il n'emporte pas les autres) — et
 * `.catch()` remplace partout `.default()`, qui ne rattrape que l'ABSENCE.
 *
 * Les invariants tenus quoi qu'il arrive :
 *   1. le rôle administrateur existe, il est le seul `superAdmin`, il est indélébile ;
 *   2. aucun rôle non administrateur ne porte `admin.roles` / `admin.users` ;
 *   3. le rôle par défaut existe et n'est pas le rôle administrateur ;
 *   4. une affectation vers un rôle disparu est oubliée, pas héritée ;
 *   5. TOUS les compartiments de relation existent, écrits noir sur blanc.
 */
import { z } from "zod";
import {
  FIXED_BUCKETS,
  GRANT_KEYS,
  type Grants,
  LOCKED_TO_ADMIN,
  PERMISSION_KEYS,
  type PermissionKey,
  noGrants,
  roleBucket,
} from "./catalog";
import {
  ADMIN_ROLE_ID,
  CALLER_ROLE_ID,
  defaultPermissionsConfig,
  defaultRoles,
} from "./defaults";
import type { PermissionsConfig, Role } from "./types";

/** Slug d'identifiant de rôle : ce qui tient dans une clé JSON et dans une URL. */
export const ROLE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Nombre maximum de rôles — un bureau n'en tient pas trente. */
const MAX_ROLES = 30;

/**
 * Ce qui n'est pas un objet JSON ne dit rien : on repart de `{}` et chaque
 * champ reprend sa valeur de repli. C'est la pièce qui rend le schéma total —
 * `z.object()` refuse une chaîne ou un tableau, et ce refus-là coûterait la
 * table des affectations.
 */
const objectish = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}),
    schema,
  );

const boolMap = <T extends string>(keys: readonly T[]) =>
  objectish(z.record(z.string(), z.unknown())).transform((raw) => {
    const known = new Set<string>(keys);
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw)) if (known.has(k) && v === true) out[k] = true;
    return out;
  });

const assignmentRulesSchema = objectish(
  z.object({
    claimPool: z.boolean().catch(false),
    release: z.boolean().catch(false),
    assignToOthers: z.boolean().catch(false),
    takeFromOthers: z.boolean().catch(false),
    maxOwned: z.number().int().min(0).max(100_000).catch(0),
  }),
);

const roleSchema = z.object({
  // Ces trois-là n'ont pas de repli : un rôle sans identifiant utilisable ni
  // sans nom n'est pas réparable, il est JETÉ (voir `rolesSchema`). Les rôles
  // livrés, eux, sont réinstallés plus bas quoi qu'il arrive.
  id: z.string().regex(ROLE_ID_RE),
  nameFr: z.string().trim().min(1).max(60),
  nameEn: z.string().trim().min(1).max(60),
  builtin: z.boolean().catch(false),
  superAdmin: z.boolean().catch(false),
  look: z.string().trim().min(1).max(40).catch("caller"),
  perms: boolMap(PERMISSION_KEYS),
  relations: objectish(z.record(z.string(), boolMap(GRANT_KEYS))),
  assignment: assignmentRulesSchema,
  sortOrder: z.number().int().min(0).max(999).catch(50),
});

/**
 * Un rôle illisible tombe SEUL. `z.array(roleSchema)` ferait échouer toute la
 * configuration pour un seul rôle abîmé — et cet échec-là rendrait la
 * configuration entière aux valeurs livrées.
 *
 * Même forme que `objectish` (un `preprocess` et non un `z.unknown()`) : dans
 * un `z.object`, une clé ABSENTE ne traverse pas un `z.unknown().transform()`,
 * elle y échoue. Or la clé absente est justement le cas courant.
 */
const rolesSchema = z
  .preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown()))
  .transform((raw) => {
    const out: z.infer<typeof roleSchema>[] = [];
    for (const item of raw) {
      if (out.length >= MAX_ROLES) break;
      const parsed = roleSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  });

/** Même principe : une affectation illisible est oubliée, les autres tiennent. */
const userRolesSchema = objectish(z.record(z.string(), z.unknown())).transform((raw) => {
  const out: Record<string, string> = {};
  for (const [userId, roleId] of Object.entries(raw)) {
    if (typeof roleId === "string" && roleId !== "") out[userId] = roleId;
  }
  return out;
});

const rawSchema = objectish(
  z.object({
    roles: rolesSchema,
    userRoles: userRolesSchema,
    defaultRoleId: z.string().catch(CALLER_ROLE_ID),
    assignment: objectish(
      z.object({
        staleDays: z.number().int().min(0).max(3650).catch(14),
        claimOnCall: z.boolean().catch(true),
        notifyAssignee: z.boolean().catch(true),
        notifyPreviousOwner: z.boolean().catch(true),
      }),
    ),
  }),
);

/**
 * Remet la configuration d'aplomb. Appelée à l'écriture comme à la lecture :
 * une base modifiée à la main, une migration à moitié faite ou un rôle
 * supprimé pendant qu'un onglet était ouvert donnent tous une configuration
 * utilisable plutôt qu'un écran vide.
 */
export function repairConfig(input: z.infer<typeof rawSchema>): PermissionsConfig {
  const builtins = defaultRoles();
  const byId = new Map<string, Role>();

  for (const role of input.roles) {
    if (byId.has(role.id)) continue; // doublon d'identifiant : le premier gagne
    byId.set(role.id, {
      ...role,
      perms: role.perms as Partial<Record<PermissionKey, boolean>>,
      relations: role.relations,
    });
  }

  // 1. Les rôles livrés existent toujours — on conserve la version modifiée
  //    quand elle est là, on réinjecte l'originale sinon.
  for (const builtin of builtins) {
    const existing = byId.get(builtin.id);
    if (!existing) byId.set(builtin.id, builtin);
    else byId.set(builtin.id, { ...existing, builtin: true });
  }

  // 2. Un seul administrateur, et c'est celui-là.
  for (const [id, role] of byId) {
    byId.set(id, { ...role, superAdmin: id === ADMIN_ROLE_ID });
  }

  // 3. Personne d'autre ne s'accorde les clés de la maison.
  for (const [id, role] of byId) {
    if (id === ADMIN_ROLE_ID) continue;
    const perms = { ...role.perms };
    for (const locked of LOCKED_TO_ADMIN) delete perms[locked];
    byId.set(id, { ...role, perms });
  }

  const roles = [...byId.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );
  const ids = new Set(roles.map((r) => r.id));

  // 4. Le rôle par défaut existe et n'est pas l'administrateur — sinon tout
  //    compte sans affectation deviendrait administrateur au prochain
  //    chargement, ce qui est exactement l'accident à ne pas avoir.
  let defaultRoleId = input.defaultRoleId;
  if (!ids.has(defaultRoleId) || defaultRoleId === ADMIN_ROLE_ID) {
    defaultRoleId = ids.has(CALLER_ROLE_ID)
      ? CALLER_ROLE_ID
      : (roles.find((r) => !r.superAdmin)?.id ?? ADMIN_ROLE_ID);
  }

  // 5. TOUS les compartiments existent, écrits noir sur blanc.
  //
  //    Le moteur lisait un compartiment absent comme « celui du rôle par
  //    défaut ». Créer un rôle ouvrait donc d'un coup les fiches de ses membres
  //    au niveau téléphoniste, pendant que l'écran des rôles montrait ces mêmes
  //    cases FERMÉES : l'écran et le moteur disaient le contraire l'un de
  //    l'autre, ce qu'on ne peut pas laisser à une matrice qu'on règle à la
  //    main. On matérialise donc ici, une fois, ce que le moteur devinait —
  //    et `grantsFor` peut refermer son repli (voir access.ts).
  //
  //    Le repli d'hier devient la GRAINE d'aujourd'hui : un compartiment de
  //    rôle manquant reprend ce que le rôle ouvre déjà sur le rôle par défaut.
  //    Une configuration existante ne change donc pas de comportement, elle
  //    devient seulement LISIBLE ; à défaut de graine, tout est fermé.
  //
  //    Le rôle administrateur est laissé tel quel : ses relations ne sont
  //    jamais lues (`grantsFor` lui rend tout), les matérialiser n'écrirait que
  //    du bruit à tenir d'accord avec le reste.
  const seedBucket = roleBucket(defaultRoleId);
  const materialised = roles.map((role) => {
    if (role.superAdmin) return role;
    const seed = role.relations[seedBucket];
    const relations: Record<string, Partial<Grants>> = { ...role.relations };
    // `own` et `unassigned` n'ont pas de graine : personne ne peut deviner ce
    // qu'un rôle veut sur SES propres fiches à partir d'un autre compartiment.
    for (const fixed of FIXED_BUCKETS) relations[fixed] ??= noGrants();
    for (const other of roles) {
      const bucket = roleBucket(other.id);
      if (bucket in relations) continue;
      relations[bucket] = seed ? { ...seed } : noGrants();
    }
    return { ...role, relations };
  });

  // 6. Les affectations vers un rôle disparu sont oubliées : la personne
  //    retombe sur le rôle par défaut, jamais sur un rôle fantôme.
  const userRoles: Record<string, string> = {};
  for (const [userId, roleId] of Object.entries(input.userRoles)) {
    if (ids.has(roleId)) userRoles[userId] = roleId;
  }

  return { roles: materialised, userRoles, defaultRoleId, assignment: input.assignment };
}

export const permissionsSettingsSchema = rawSchema.transform(repairConfig);

/** Ce que `getSetting("permissions")` rend quand la clé n'a jamais été écrite. */
export function emptyPermissionsConfig(): PermissionsConfig {
  return defaultPermissionsConfig();
}
