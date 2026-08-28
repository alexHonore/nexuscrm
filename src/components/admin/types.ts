/** DTO sérialisables passés des pages serveur aux îlots clients (jamais de secrets). */

/**
 * Diagnostic « ce poste peut-il appeler ? » — calculé côté serveur
 * (`computePhoneStatus`), transmis en booléens seulement.
 *
 * - `ready` : SIP complet + numéro (DID) + passerelle configurée
 * - `no_did` : peut appeler, ne peut pas recevoir
 * - `not_configured` : aucun identifiant SIP
 * - `no_gateway` : passerelle SIP-WSS absente — affecte TOUT le monde
 */
export type PhoneStatusDto = {
  code: "ready" | "no_did" | "not_configured" | "no_gateway";
  hasSipUsername: boolean;
  hasSipPassword: boolean;
  hasDid: boolean;
  hasGateway: boolean;
};

/**
 * Un rôle CONFIGURÉ (src/lib/permissions), réduit à ce qu'un sélecteur affiche.
 * Les droits eux-mêmes ne descendent pas jusqu'ici : cet écran choisit un rôle,
 * il ne le modifie pas — c'est /admin/roles qui ouvre la matrice.
 */
export type RoleOptionDto = {
  id: string;
  nameFr: string;
  nameEn: string;
  /** Clé de `ROLE_LOOK` (src/components/look.tsx). */
  look: string;
  /** Le rôle administrateur — le seul qui met `users.role` à « admin ». */
  superAdmin: boolean;
};

export type AdminUserDto = {
  id: string;
  name: string;
  email: string;
  /** Plancher de la base : administrateur, ou pas. Le rôle réel est `roleId`. */
  role: "admin" | "caller";
  /**
   * Le rôle configuré de ce compte — celui qui décide vraiment de ses droits.
   * `null` quand la réponse vient d'une route qui ne lit pas la matrice (les
   * routes voip.ms) : la ligne garde alors le rôle qu'elle affichait déjà.
   */
  roleId: string | null;
  roleNameFr: string | null;
  roleNameEn: string | null;
  /** Clé de `ROLE_LOOK` — la pastille se peint sans relire la matrice. */
  roleLook: string | null;
  locale: "fr" | "en";
  isActive: boolean;
  sipUsername: string | null;
  hasSipPassword: boolean;
  didNumber: string | null;
  /** État du téléphone (badge + info-bulle dans /admin/users). */
  phone: PhoneStatusDto;
  lastLoginAt: string | null;
  createdAt: string;
};

export type CategoryDto = {
  id: number;
  key: string | null;
  nameFr: string;
  nameEn: string;
  color: string;
  sortOrder: number;
  isSystem: boolean;
  clientCount: number;
};

export type SourceDto = {
  id: number;
  name: string;
  color: string;
  clientCount: number;
};

export type WebhookDefaults = {
  categoryId?: number | null;
  sourceId?: number | null;
  assignedToId?: string | null;
};

export type WebhookKeyDto = {
  id: number;
  name: string;
  keyLast4: string;
  defaults: WebhookDefaults;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
};

export type OptionDto = { value: string; label: string };

/** Palette de 12 couleurs prédéfinies (catégories / sources). */
export const COLOR_PALETTE = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#16a34a",
  "#14b8a6",
  "#0ea5e9",
  "#3b82f6",
  "#8b5cf6",
  "#d946ef",
  "#64748b",
] as const;
