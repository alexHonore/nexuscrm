/**
 * Les rôles LIVRÉS avec l'application.
 *
 * Ce ne sont pas des constantes verrouillées mais un point de départ : chaque
 * case ci-dessous est modifiable dans « Rôles et droits », et l'administrateur
 * peut créer les siens. Ce fichier répond à une seule question — que voit une
 * installation le jour où elle ouvre l'écran pour la première fois ?
 *
 * Les quatre rôles reproduisent l'organisation réelle du bureau :
 *
 *   Administrateur — le courtier. Tout, tout le temps.
 *   Superviseur    — mène l'équipe : voit et redistribue tout, ne configure rien.
 *   Téléphoniste   — appelle. Ses fiches, plus le bassin où il se sert.
 *   Observateur    — regarde. Ne touche à rien.
 *
 * Le choix le plus lourd est celui du compartiment `role:admin` chez les
 * autres : une fiche que le courtier a prise DISPARAÎT pour l'équipe. Ni en
 * liste, ni en recherche, ni par l'URL. C'est la règle demandée par
 * l'exploitant (2026-08-28) et le défaut le plus strict de la matrice — il
 * s'assouplit d'une case si l'on veut la laisser visible en lecture.
 */
import { GRANT_KEYS, type Grants, type PermissionKey, allGrants, noGrants } from "./catalog";
import type { AssignmentRules, PermissionsConfig, Role } from "./types";

export const ADMIN_ROLE_ID = "admin";
export const SUPERVISOR_ROLE_ID = "supervisor";
export const CALLER_ROLE_ID = "caller";
export const OBSERVER_ROLE_ID = "observer";

/** Raccourci de lecture : la liste des cases ouvertes, le reste fermé. */
function grants(...open: Array<keyof Grants>): Grants {
  const g = noGrants();
  for (const key of open) g[key] = true;
  return g;
}

function perms(...keys: PermissionKey[]): Partial<Record<PermissionKey, boolean>> {
  return Object.fromEntries(keys.map((k) => [k, true]));
}

const NO_ASSIGNMENT: AssignmentRules = {
  claimPool: false,
  release: false,
  assignToOthers: false,
  takeFromOthers: false,
  maxOwned: 0,
};

/** Une fiche tenue par l'administrateur : rien ne filtre, pas même son nom. */
const INVISIBLE = noGrants();

/** Prise par un collègue : on la VOIT (donc on ne la rappelle pas) et c'est tout. */
const TAKEN_BY_SOMEONE_ELSE = grants("visible");

const READ_ONLY = grants("visible", "contact", "history");

const FULL_MINUS_DELETE = (() => {
  const g = allGrants();
  g.delete = false;
  return g;
})();

export function defaultRoles(): Role[] {
  return [
    {
      id: ADMIN_ROLE_ID,
      nameFr: "Administrateur",
      nameEn: "Administrator",
      builtin: true,
      superAdmin: true,
      look: "admin",
      // Vide à dessein : `can()` et `grantsFor()` rendent tout vrai pour le
      // rôle administrateur. Cocher 34 cases qui ne sont jamais lues, c'est
      // deux vérités à tenir d'accord — il n'y en a qu'une.
      perms: {},
      relations: {},
      assignment: {
        claimPool: true,
        release: true,
        assignToOthers: true,
        takeFromOthers: true,
        maxOwned: 0,
      },
      sortOrder: 0,
    },
    {
      id: SUPERVISOR_ROLE_ID,
      nameFr: "Superviseur",
      nameEn: "Supervisor",
      builtin: true,
      superAdmin: false,
      look: "supervisor",
      perms: perms(
        "clients.create",
        "clients.edit",
        "clients.comment",
        "clients.call",
        "clients.sms",
        "clients.book",
        "clients.followup",
        "clients.category",
        "clients.assign",
        "clients.bulk",
        "clients.contact",
        "clients.recordings",
        "clients.history",
        "conversations.view",
        "conversations.reply",
        "conversations.control",
        "conversations.assistant",
        // Lire ce que le robot dit à SES clients relève de son métier ; le
        // réécrire relève de celui du courtier.
        "admin.assistants",
        "admin.analytics",
        "admin.calls",
      ),
      relations: {
        own: FULL_MINUS_DELETE,
        unassigned: FULL_MINUS_DELETE,
        [`role:${ADMIN_ROLE_ID}`]: FULL_MINUS_DELETE,
        [`role:${SUPERVISOR_ROLE_ID}`]: FULL_MINUS_DELETE,
        [`role:${CALLER_ROLE_ID}`]: FULL_MINUS_DELETE,
        [`role:${OBSERVER_ROLE_ID}`]: FULL_MINUS_DELETE,
      },
      assignment: {
        claimPool: true,
        release: true,
        assignToOthers: true,
        // Redistribuer, y compris ce qui est déjà pris : c'est le métier.
        takeFromOthers: true,
        maxOwned: 0,
      },
      sortOrder: 1,
    },
    {
      id: CALLER_ROLE_ID,
      nameFr: "Téléphoniste",
      nameEn: "Caller",
      builtin: true,
      superAdmin: false,
      look: "caller",
      perms: perms(
        "clients.edit",
        "clients.comment",
        "clients.call",
        "clients.sms",
        "clients.book",
        "clients.followup",
        "clients.category",
        "clients.assign",
        "clients.contact",
        "clients.history",
        "conversations.view",
        "conversations.reply",
        // Reprendre un fil est le métier même du téléphoniste : l'assistant
        // lui PASSE la main, et sans ce droit la passe tombe par terre.
        "conversations.control",
        // Et la passe dans l'autre sens : rendre le fil au robot quand il n'a
        // plus rien à y faire lui-même.
        "conversations.assistant",
      ),
      relations: {
        own: grants(
          "visible",
          "contact",
          "history",
          "comment",
          "edit",
          "category",
          "call",
          "sms",
          "book",
          "followup",
          "assign",
          "assistant",
        ),
        unassigned: grants(
          "visible",
          "contact",
          "history",
          "comment",
          "edit",
          "category",
          "call",
          "sms",
          "book",
          "followup",
          "assign",
          "assistant",
        ),
        [`role:${ADMIN_ROLE_ID}`]: INVISIBLE,
        [`role:${SUPERVISOR_ROLE_ID}`]: TAKEN_BY_SOMEONE_ELSE,
        [`role:${CALLER_ROLE_ID}`]: TAKEN_BY_SOMEONE_ELSE,
        [`role:${OBSERVER_ROLE_ID}`]: TAKEN_BY_SOMEONE_ELSE,
      },
      assignment: {
        claimPool: true,
        release: true,
        assignToOthers: false,
        takeFromOthers: false,
        /** 50 fiches ouvertes : on se sert dans le bassin, on ne le vide pas. */
        maxOwned: 50,
      },
      sortOrder: 2,
    },
    {
      id: OBSERVER_ROLE_ID,
      nameFr: "Observateur",
      nameEn: "Observer",
      builtin: true,
      superAdmin: false,
      look: "observer",
      perms: perms("clients.contact", "clients.history", "conversations.view"),
      relations: {
        own: READ_ONLY,
        unassigned: READ_ONLY,
        [`role:${ADMIN_ROLE_ID}`]: INVISIBLE,
        [`role:${SUPERVISOR_ROLE_ID}`]: READ_ONLY,
        [`role:${CALLER_ROLE_ID}`]: READ_ONLY,
        [`role:${OBSERVER_ROLE_ID}`]: READ_ONLY,
      },
      assignment: NO_ASSIGNMENT,
      sortOrder: 3,
    },
  ];
}

export function defaultPermissionsConfig(): PermissionsConfig {
  return {
    roles: defaultRoles(),
    userRoles: {},
    defaultRoleId: CALLER_ROLE_ID,
    assignment: {
      /** 14 jours sans contact et le verrou saute — le lead retourne au jeu. */
      staleDays: 14,
      claimOnCall: true,
      notifyAssignee: true,
      notifyPreviousOwner: true,
    },
  };
}

/** Les cases d'une relation, dans l'ordre du catalogue — pour l'écran. */
export const RELATION_ORDER = GRANT_KEYS;
