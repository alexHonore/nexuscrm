/**
 * Le CATALOGUE des droits : la liste fermée de ce qu'un rôle peut se voir
 * accorder, et la liste fermée de ce qu'une RELATION à une fiche peut ouvrir.
 *
 * Deux listes et pas une, parce que ce sont deux questions différentes :
 *
 *   « Ce téléphoniste a-t-il le droit de commenter ? »        → un DROIT
 *   « … de commenter CETTE fiche-là, prise par le patron ? »  → une RELATION
 *
 * Le droit est le PLAFOND, la relation le robinet : l'effet net est toujours
 * l'ET des deux (`can()` dans access.ts). Un droit retiré ne peut être rendu
 * par aucune relation — c'est ce qui rend la matrice sûre à configurer : on
 * peut ouvrir large côté relation sans jamais dépasser le rôle.
 *
 * Ce fichier ne contient AUCUN texte d'interface (les libellés vivent dans
 * docs.ts / docs.en.ts) et n'importe rien : il est lisible par le moteur SMS
 * comme par un écran, sans traîner next-intl derrière lui.
 */

// ── Droits (le plafond, par rôle) ────────────────────────────────────────────

/**
 * Groupes d'affichage. L'ordre est celui de l'écran d'administration : on
 * lit d'abord ce qui touche les fiches, ensuite les écrans d'administration.
 */
export const PERMISSION_GROUPS = ["clients", "conversations", "admin"] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export const PERMISSION_KEYS = [
  // ── Fiches ────────────────────────────────────────────────────────────────
  "clients.create",
  "clients.edit",
  "clients.delete",
  "clients.comment",
  "clients.call",
  "clients.sms",
  "clients.book",
  "clients.followup",
  /** Changer le statut de pipeline (y compris par une disposition d'appel). */
  "clients.category",
  /** Toucher à l'assignation — le détail (prendre, rendre, retirer) est réglé
   *  par les règles d'assignation du rôle, pas par ce seul interrupteur. */
  "clients.assign",
  "clients.bulk",
  "clients.export",
  "clients.import",
  /** Voir téléphone et courriel en clair. Sinon : masqués (•••-4512). */
  "clients.contact",
  "clients.recordings",
  /** Historique : appels, rendez-vous, journal de modifications de la fiche. */
  "clients.history",

  // ── Conversations SMS ─────────────────────────────────────────────────────
  "conversations.view",
  /** Écrire un SMS à la main dans un fil. */
  "conversations.reply",
  /** Reprendre / rendre un fil à l'assistant, l'assigner, l'archiver. */
  "conversations.control",

  // ── Administration ────────────────────────────────────────────────────────
  "admin.analytics",
  "admin.calls",
  "admin.pipeline",
  "admin.users",
  /** Gérer les rôles et cette matrice même. Voir `LOCKED_TO_ADMIN`. */
  "admin.roles",
  "admin.settings",
  "admin.assistants",
  "admin.campaigns",
  "admin.guardrails",
  "admin.deliverability",
  "admin.webhooks",
  "admin.audit",
  "admin.billing",
  "admin.docs",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

/** Le groupe d'un droit se lit dans son préfixe — une seule source. */
export function permissionGroup(key: PermissionKey): PermissionGroup {
  return key.split(".")[0] as PermissionGroup;
}

export function permissionsOfGroup(group: PermissionGroup): PermissionKey[] {
  return PERMISSION_KEYS.filter((k) => permissionGroup(k) === group);
}

/**
 * Droits que SEUL un administrateur détient, quoi qu'on coche.
 *
 * Sans ce verrou, la matrice se retourne contre elle-même : un rôle à qui on
 * confie « gérer les rôles » peut s'accorder tout le reste dans la minute, et
 * un rôle qui gère les utilisateurs peut se nommer administrateur. Ces deux
 * cases restent donc grisées pour les rôles non administrateurs — l'écran le
 * dit, et le serveur le REFUSE (voir `sanitizeRole` dans schema.ts).
 */
export const LOCKED_TO_ADMIN: readonly PermissionKey[] = ["admin.roles", "admin.users"];

// ── Relations (le robinet, par fiche) ────────────────────────────────────────

/**
 * Ce qu'une relation peut ouvrir sur UNE fiche. Sous-ensemble volontaire des
 * droits : ce qui n'a pas de sens fiche par fiche (importer, voir les
 * statistiques) n'y figure pas.
 */
export const GRANT_KEYS = [
  /** La fiche EXISTE pour ce regard. À false : absente des listes, de la
   *  recherche, du tableau de bord et de l'accès direct par URL. */
  "visible",
  /** Téléphone et courriel en clair (le droit `clients.contact` reste le plafond). */
  "contact",
  /** Historique d'appels, fil SMS, commentaires, journal de la fiche. */
  "history",
  "comment",
  "edit",
  "category",
  "call",
  "sms",
  "book",
  "followup",
  /** Prendre / rendre / réassigner CETTE fiche (les règles affinent). */
  "assign",
  "delete",
] as const;

export type GrantKey = (typeof GRANT_KEYS)[number];

export type Grants = Record<GrantKey, boolean>;

/**
 * Le droit qui PLAFONNE chaque case de relation. `visible` n'en a pas : QUI
 * voit QUOI se règle par la relation seule, et c'est délibéré — un seul
 * endroit à lire pour répondre à « pourquoi cette fiche lui échappe ».
 */
export const GRANT_CEILING: Record<GrantKey, PermissionKey | null> = {
  visible: null,
  contact: "clients.contact",
  history: "clients.history",
  comment: "clients.comment",
  edit: "clients.edit",
  category: "clients.category",
  call: "clients.call",
  sms: "clients.sms",
  book: "clients.book",
  followup: "clients.followup",
  assign: "clients.assign",
  delete: "clients.delete",
};

// ── Compartiments de relation ────────────────────────────────────────────────

/**
 * À qui la fiche est-elle ? Trois réponses possibles, dont une paramétrable :
 *
 *   `own`         — à moi
 *   `unassigned`  — à personne (le bassin)
 *   `role:<id>`   — à quelqu'un d'autre, et c'est SON RÔLE qui décide
 *
 * Le troisième compartiment est la demande d'origine : « quand une fiche est
 * assignée à l'administrateur, que garde un téléphoniste ? ». La réponse n'est
 * pas la même selon que la fiche est prise par le patron ou par un collègue —
 * donc le compartiment porte le rôle du détenteur, pas son nom.
 */
export const FIXED_BUCKETS = ["own", "unassigned"] as const;
export type FixedBucket = (typeof FIXED_BUCKETS)[number];
export type Bucket = FixedBucket | `role:${string}`;

export function roleBucket(roleId: string): Bucket {
  return `role:${roleId}`;
}

export function bucketRoleId(bucket: Bucket): string | null {
  return bucket.startsWith("role:") ? bucket.slice("role:".length) : null;
}

/** Toutes les cases à false — le socle sûr d'une relation non configurée. */
export function noGrants(): Grants {
  return Object.fromEntries(GRANT_KEYS.map((k) => [k, false])) as Grants;
}

/** Toutes les cases à true — ce que voit un rôle qui a tout. */
export function allGrants(): Grants {
  return Object.fromEntries(GRANT_KEYS.map((k) => [k, true])) as Grants;
}
