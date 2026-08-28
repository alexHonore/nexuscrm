/**
 * La forme d'un RÔLE et des règles d'assignation. Types purs, sans dépendance :
 * le moteur SMS, un test unitaire et un écran lisent les mêmes.
 */
import type { Bucket, GrantKey, Grants, PermissionKey } from "./catalog";

export type { Bucket, GrantKey, Grants, PermissionKey };

/**
 * Ce qu'un rôle a le droit de FAIRE avec l'assignation elle-même.
 *
 * Séparé des droits parce que la question n'est pas « peut-il assigner » mais
 * « à qui, et à qui peut-il PRENDRE » : c'est là que se joue le vol de leads.
 */
export type AssignmentRules = {
  /** Prendre une fiche du bassin (non assignée). */
  claimPool: boolean;
  /** Rendre au bassin une fiche qu'il détient. */
  release: boolean;
  /** Donner une fiche à quelqu'un d'autre. */
  assignToOthers: boolean;
  /**
   * RETIRER une fiche à son détenteur. C'est le verrou anti-vol : à false, une
   * fiche déjà prise ne change de main que par un rôle qui a ce droit — ou
   * quand son verrou a expiré (`staleDays`).
   */
  takeFromOthers: boolean;
  /**
   * Plafond de fiches détenues au-delà duquel il ne peut plus SE servir dans
   * le bassin. 0 = pas de plafond. Ne s'applique jamais à une fiche DONNÉE par
   * quelqu'un d'autre : le plafond règle l'appétit, pas la distribution.
   */
  maxOwned: number;
};

export type Role = {
  /** Identifiant stable (slug). Ne change jamais, même si le nom change. */
  id: string;
  nameFr: string;
  nameEn: string;
  /** Livré avec l'application : renommable et reconfigurable, jamais supprimable. */
  builtin: boolean;
  /**
   * Le rôle ADMINISTRATEUR — il a tout, tout le temps, et c'est le seul dont
   * les membres portent `users.role = "admin"` en base. Un seul rôle peut
   * l'être ; il ne se supprime ni ne se vide.
   */
  superAdmin: boolean;
  /** Clé de pictogramme+couleur dans ROLE_LOOK (src/components/look.tsx). */
  look: string;
  perms: Partial<Record<PermissionKey, boolean>>;
  /** Compartiment → cases ouvertes. Un compartiment absent = tout fermé. */
  relations: Record<string, Partial<Grants>>;
  assignment: AssignmentRules;
  sortOrder: number;
};

/**
 * Règles d'assignation VALABLES POUR TOUT LE MONDE — elles ne dépendent pas
 * du rôle de celui qui regarde, mais de l'entreprise.
 */
export type GlobalAssignmentRules = {
  /**
   * Jours sans contact au bout desquels le VERROU d'une fiche expire : elle
   * redevient prenable par un autre, sans changer de main d'elle-même. 0 =
   * jamais (le verrou tient tant que l'admin ne tranche pas).
   *
   * Le verrou expire, la fiche NE se libère PAS toute seule : rien ne se passe
   * dans le dos du détenteur tant que personne ne la réclame, et il n'y a
   * aucune tâche de fond à surveiller.
   */
  staleDays: number;
  /**
   * Appeler une fiche du bassin la prend. C'est ce qui rend le verrou vivable :
   * sans ça, deux téléphonistes appellent le même lead à trois minutes
   * d'intervalle et personne n'a rien volé.
   */
  claimOnCall: boolean;
  /** Prévenir celui à qui on assigne une fiche (cloche + notification). */
  notifyAssignee: boolean;
  /** Prévenir l'ancien détenteur quand on lui retire une fiche. */
  notifyPreviousOwner: boolean;
};

export type PermissionsConfig = {
  roles: Role[];
  /** userId → roleId. Absent = rôle par défaut (ou administrateur si `users.role` l'est). */
  userRoles: Record<string, string>;
  /** Rôle donné à un compte qui n'en a pas encore (création, ancien compte). */
  defaultRoleId: string;
  assignment: GlobalAssignmentRules;
};
