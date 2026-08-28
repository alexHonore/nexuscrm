import "server-only";
import type { Locale as DateFnsLocale } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { SECRET_MARKERS, type AuditValue } from "@/lib/audit";
import { formatPhone } from "@/lib/phone";

/**
 * Mise en forme du journal d'audit : transforme une ligne `audit_logs` (JSON
 * brut) en un objet 100 % sérialisable, déjà traduit et déjà résolu (id →
 * nom), que l'îlot client se contente d'afficher. Aucune requête ici : les
 * correspondances sont chargées EN LOT par la page (jamais de N+1).
 */

export const AUDIT_TZ = "America/Toronto";

/** Sous-ensemble du traducteur next-intl utilisé ici (namespace "admin"). */
export type AuditTranslator = {
  (key: string): string;
  has(key: string): boolean;
  raw(key: string): unknown;
};

/** Valeur prête à afficher : texte + pastille de couleur éventuelle. */
export type AuditValueView = { text: string; swatch?: string; empty?: boolean };

/** Un champ modifié, avec son libellé humain et ses deux états. */
export type AuditChangeView = {
  field: string;
  label: string;
  from: AuditValueView;
  to: AuditValueView;
};

/** Toute autre information du `detail` (entrées anciennes, contexte). */
export type AuditFactView = { key: string; label: string; value: AuditValueView };

/**
 * Famille de verbe d'une action — pilote la teinte du badge dans le journal
 * (création = émeraude, suppression = destructif, modification = primaire,
 * connexion/mots de passe = violet, import/export = ambre). Purement visuel.
 */
export type AuditActionFamily = "create" | "delete" | "update" | "auth" | "data" | "other";

export function actionFamily(action: string): AuditActionFamily {
  const a = action.toLowerCase();
  if (/(^|[._])(login|logout|auth|password)/.test(a)) return "auth";
  if (/(^|[._])(export|import)/.test(a)) return "data";
  // Un lead reçu par webhook crée une fiche : même famille qu'une création.
  if (a.includes("create") || a === "webhook.lead") return "create";
  if (a.includes("delete") || a.includes("cancel")) return "delete";
  if (
    /(update|reorder|resync|route|assign|disposition|reassign|transfer)/.test(a) ||
    a.startsWith("settings.") ||
    a === "client.category"
  ) {
    return "update";
  }
  return "other";
}

export type AuditEntryView = {
  id: number;
  action: string;
  actionLabel: string;
  /** Famille de verbe — uniquement pour teinter le badge d'action. */
  family: AuditActionFamily;
  dateLabel: string;
  dateIso: string;
  userLabel: string;
  isSystem: boolean;
  entityLabel: string | null;
  entityId: string | null;
  entityName: string | null;
  entityHref: string | null;
  /**
   * La FICHE de cette ligne n'a pas de nom pour ce regard — fermée par son
   * compartiment, ou supprimée depuis. L'écran la désigne alors par son
   * identifiant : une ligne d'audit doit toujours dire sur quoi elle porte.
   */
  clientHidden: boolean;
  ip: string | null;
  changes: AuditChangeView[];
  facts: AuditFactView[];
  rawJson: string | null;
};

/**
 * Correspondances id → nom, chargées en lot pour la page entière.
 *
 * `clients` ne contient que les fiches OUVERTES à celui qui lit le journal :
 * une fiche absente de cette table (fermée par son compartiment, ou supprimée)
 * n'a pas de nom ici, et sa ligne se désigne alors par son identifiant.
 */
export type AuditLookups = {
  users: Map<string, string>;
  categories: Map<number, string>;
  sources: Map<number, string>;
  clients: Map<string, string>;
  /**
   * Rôles CONFIGURÉS : identifiant → nom dans la langue de l'écran. Les rôles
   * ne sont plus deux valeurs figées ; un identifiant qui n'y figure plus
   * (rôle supprimé depuis) reste affiché tel quel — le journal ne réécrit pas
   * l'histoire.
   */
  roles?: Map<string, string>;
  /**
   * Les COORDONNÉES de cette fiche sont-elles ouvertes à ce regard ?
   * `null` : la ligne ne parle d'aucune fiche (un DID, un réglage). Prédicat
   * absent : aucune restriction connue (tests, appelant sans regard).
   */
  contactOpen?: (clientId: string | null) => boolean;
};

export type AuditLogRow = {
  id: number;
  action: string;
  entity: string | null;
  entityId: string | null;
  detail: unknown;
  ip: string | null;
  createdAt: Date;
};

type Ctx = {
  t: AuditTranslator;
  dateLocale: DateFnsLocale;
  lookups: AuditLookups;
  /** Entité de la ligne courante — désambiguïse `reassignTo` (catégorie/source). */
  entity: string | null;
  /** La fiche dont parle la ligne est-elle ouverte à ce regard ? */
  clientOpen: boolean;
  /** … et ses coordonnées ? (jamais vrai quand la fiche est fermée) */
  contact: boolean;
  /** Le mot qui remplace une valeur fermée. */
  mask: string;
};

/**
 * Ce que l'ÉCRAN fournit. Le reste du contexte (fiche ouverte ou non) se
 * déduit ligne par ligne : c'est la ligne qui dit de quelle fiche elle parle.
 */
export type AuditRenderContext = {
  t: AuditTranslator;
  dateLocale: DateFnsLocale;
  lookups: AuditLookups;
  /** « Masqué » (`clients.access.masked`), écrit une seule fois chez les fiches. */
  mask?: string;
};

const EMPTY = "—";
const MAX_TEXT = 600;
/** Horodatage ISO complet — assez strict pour ne pas attraper un nom ou un budget. */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_ID_FIELDS = new Set(["assignedToId", "createdById", "userId", "assignedTo"]);
const PHONE_FIELDS = new Set(["phone", "phoneAlt", "didNumber", "did", "number"]);
/** Ce que la case « coordonnées » couvre : le téléphone ET le courriel. */
const CONTACT_FIELDS = new Set([...PHONE_FIELDS, "email", "clientEmail", "previousEmail"]);
/** Le NOM de la fiche : rejouer le journal ne doit pas le rendre à qui la fiche échappe. */
const IDENTITY_FIELDS = new Set(["fullName", "clientName"]);
/** Les rôles ne sont plus « admin » ou « caller » : ce sont des identifiants configurés. */
const ROLE_FIELDS = new Set(["role", "roleId", "previousRoleId"]);
/** Repli quand l'écran n'a pas fourni son mot : trois points ne mentent dans aucune langue. */
const MASK = "•••";
const SECRET_TEXTS: Record<string, string> = {
  [SECRET_MARKERS.set]: "audit.secret.set",
  [SECRET_MARKERS.none]: "audit.secret.none",
  [SECRET_MARKERS.updated]: "audit.secret.updated",
};

/** Vrai UUID seulement — évite d'envoyer n'importe quoi à Postgres. */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function truncate(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Traduction avec repli : une clé absente ne doit jamais casser l'affichage. */
function label(t: AuditTranslator, key: string, fallback: string): string {
  if (!t.has(key)) return fallback;
  const raw = t.raw(key);
  return typeof raw === "string" ? t(key) : fallback;
}

/** Libellé humain d'un champ ("categoryId" → « Catégorie »). */
export function fieldLabel(t: AuditTranslator, field: string): string {
  return label(t, `audit.fields.${field}`, field);
}

/** Libellé d'une action ("client.update" → « Fiche client modifiée »). */
export function actionLabel(t: AuditTranslator, action: string): string {
  return label(t, `audit.actions.${action.replace(/\./g, "_")}`, action);
}

/** Libellé d'une entité ("client" → « Client »). */
export function entityLabel(t: AuditTranslator, entity: string): string {
  return label(t, `audit.entities.${entity}`, entity);
}

function numericId(value: string | number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : null;
}

/** Scalaire (texte ou nombre) → texte lisible, id résolus en noms. */
function renderScalar(field: string, value: string | number, ctx: Ctx): AuditValueView {
  const { t, lookups } = ctx;

  if (typeof value === "string" && SECRET_TEXTS[value]) {
    return { text: t(SECRET_TEXTS[value]) };
  }

  if (field === "categoryId" || (field === "reassignTo" && ctx.entity === "category")) {
    const id = numericId(value);
    const name = id !== null ? lookups.categories.get(id) : undefined;
    return { text: name ?? String(value) };
  }
  if (field === "sourceId" || (field === "reassignTo" && ctx.entity === "source")) {
    const id = numericId(value);
    const name = id !== null ? lookups.sources.get(id) : undefined;
    return { text: name ?? String(value) };
  }
  if (USER_ID_FIELDS.has(field) && typeof value === "string") {
    return { text: lookups.users.get(value) ?? String(value) };
  }
  if (field === "clientId" && typeof value === "string") {
    // Fiche fermée (ou supprimée) : son identifiant, jamais son nom.
    return { text: lookups.clients.get(value) ?? String(value) };
  }
  if (!ctx.clientOpen && IDENTITY_FIELDS.has(field)) return { text: ctx.mask };
  if (!ctx.contact && CONTACT_FIELDS.has(field)) return { text: ctx.mask };
  if (PHONE_FIELDS.has(field) && typeof value === "string") {
    return { text: formatPhone(value) || String(value) };
  }
  if ((field === "language" || field === "locale") && (value === "fr" || value === "en")) {
    return { text: t(value === "fr" ? "users.localeFr" : "users.localeEn") };
  }
  if (ROLE_FIELDS.has(field) && typeof value === "string") {
    // Les rôles sont un RÉGLAGE : « admin » et « caller » n'étaient que les
    // deux premiers. On lit le nom dans la configuration courante, et un rôle
    // disparu depuis reste écrit tel qu'il a été journalisé — une entrée
    // ancienne portant le nom du rôle (« Superviseur ») s'affiche aussi telle
    // quelle, faute d'identifiant à résoudre.
    return { text: lookups.roles?.get(value) ?? truncate(String(value)) };
  }
  if (field === "days") {
    const day = numericId(value);
    if (day !== null && day >= 0 && day <= 6) return { text: t(`settings.booking.day${day}`) };
  }
  if (typeof value === "string" && HEX_COLOR_RE.test(value)) {
    return { text: value.toLowerCase(), swatch: value };
  }
  if (typeof value === "string" && ISO_DATETIME_RE.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return {
        text: formatInTimeZone(date, AUDIT_TZ, "d MMM yyyy, HH:mm", { locale: ctx.dateLocale }),
      };
    }
  }
  return { text: truncate(String(value)) };
}

/** Valeur JSON quelconque → valeur affichable (jamais vide, jamais brute). */
export function renderValue(field: string, value: AuditValue, ctx: Ctx): AuditValueView {
  if (value === null || value === "") return { text: EMPTY, empty: true };
  if (typeof value === "boolean") return { text: ctx.t(value ? "audit.yes" : "audit.no") };
  if (Array.isArray(value)) {
    if (value.length === 0) return { text: EMPTY, empty: true };
    return { text: truncate(value.map((item) => renderValue(field, item, ctx).text).join(", ")) };
  }
  if (typeof value === "object") {
    // Objets « personne » ({id, name, email}) : le nom suffit.
    const named = (value as Record<string, AuditValue>).name;
    if (typeof named === "string" && named) return { text: named };
    return { text: truncate(JSON.stringify(value)) };
  }
  return renderScalar(field, value, ctx);
}

/**
 * Anciennes entrées `{ from, to }` à la racine : à quel champ elles se
 * rapportent, d'après l'action. Sans cela, l'admin lit « 3 → 5 ».
 */
const LEGACY_FROM_TO: Record<string, string | undefined> = {
  "client.category": "categoryId",
  "client.assign": "assignedToId",
};

/** `changed: ["didNumber", "email"]` → « Numéro (DID), Courriel ». */
function renderFieldNames(t: AuditTranslator, value: AuditValue): AuditValueView {
  const list = Array.isArray(value) ? value : [value];
  const names = list.filter((item): item is string => typeof item === "string" && item !== "");
  if (names.length === 0) return { text: EMPTY, empty: true };
  return { text: names.map((name) => fieldLabel(t, name)).join(", ") };
}

function asRecord(value: unknown): Record<string, AuditValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, AuditValue>)
    : null;
}

function hrefFor(entity: string | null, entityId: string | null, lookups: AuditLookups): string | null {
  if (!entity) return null;
  // Une fiche supprimée n'a plus de page : on ne propose pas un lien mort.
  if (entity === "client") return entityId && lookups.clients.has(entityId) ? `/clients/${entityId}` : null;
  if (entity === "user") return "/admin/users";
  if (entity === "category" || entity === "source") return "/admin/pipeline";
  if (entity === "settings") return "/admin/settings";
  return null;
}

function entityName(entity: string | null, entityId: string | null, lookups: AuditLookups): string | null {
  if (!entity || !entityId) return null;
  if (entity === "client") return lookups.clients.get(entityId) ?? null;
  if (entity === "user") return lookups.users.get(entityId) ?? null;
  const id = numericId(entityId);
  if (id === null) return null;
  if (entity === "category") return lookups.categories.get(id) ?? null;
  if (entity === "source") return lookups.sources.get(id) ?? null;
  return null;
}

/**
 * De quelle FICHE cette ligne parle-t-elle ? De l'entité elle-même quand c'en
 * est une, sinon de celle que le détail nomme : un appel, un rendez-vous ou un
 * suivi portent un `clientId` et rejouent, eux aussi, des coordonnées.
 */
function clientOfRow(log: AuditLogRow, detail: Record<string, AuditValue> | null): string | null {
  if (log.entity === "client" && isUuid(log.entityId)) return log.entityId;
  const cited = detail?.clientId;
  return typeof cited === "string" && isUuid(cited) ? cited : null;
}

/**
 * Les fiches que ces lignes CITENT, dédoublonnées — de quoi charger noms et
 * compartiments en une requête plutôt qu'une par ligne. Même règle que
 * `clientOfRow` : c'est la seule définition de « la fiche de cette ligne ».
 */
export function citedClientIds(logs: readonly AuditLogRow[]): string[] {
  const ids = new Set<string>();
  for (const log of logs) {
    const id = clientOfRow(log, asRecord(log.detail));
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Une ligne d'audit → tout ce que l'écran doit montrer, déjà mis en forme. */
export function buildAuditEntry(
  log: AuditLogRow,
  userName: string | null,
  base: AuditRenderContext,
): AuditEntryView {
  const { t } = base;
  const detail = asRecord(log.detail);

  // Le journal ne rouvre pas ce que la matrice ferme : une ligne qui porte sur
  // une fiche hors de portée en garde l'action, la date et l'auteur, mais rien
  // de ce qui NOMME la fiche — ni nom, ni coordonnées, ni JSON brut, qui les
  // rendrait toutes d'un coup.
  const clientId = clientOfRow(log, detail);
  const clientOpen = clientId === null || base.lookups.clients.has(clientId);
  const contact = clientOpen && (base.lookups.contactOpen?.(clientId) ?? true);
  const ctx: Ctx = {
    ...base,
    entity: log.entity,
    clientOpen,
    contact,
    mask: base.mask ?? MASK,
  };

  const changes: AuditChangeView[] = [];
  const rawChanges = detail ? asRecord(detail.changes) : null;
  if (rawChanges) {
    for (const [field, change] of Object.entries(rawChanges)) {
      const record = asRecord(change);
      if (!record) continue;
      changes.push({
        field,
        label: fieldLabel(t, field),
        from: renderValue(field, record.from ?? null, ctx),
        to: renderValue(field, record.to ?? null, ctx),
      });
    }
  }

  // Entrées écrites AVANT `detail.changes` (elles sont déjà en production) :
  // `{ from, to }` à la racine. On les remonte au même niveau de lisibilité.
  const legacyField = LEGACY_FROM_TO[log.action];
  if (legacyField && changes.length === 0 && detail && ("from" in detail || "to" in detail)) {
    changes.push({
      field: legacyField,
      label: fieldLabel(t, legacyField),
      from: renderValue(legacyField, detail.from ?? null, ctx),
      to: renderValue(legacyField, detail.to ?? null, ctx),
    });
  }

  // Tout le reste du detail : les entrées d'avant le suivi avant/après doivent
  // rester lisibles (« ce qui EST connu »), jamais un écran vide. Ce qui figure
  // déjà en avant → après n'est pas répété.
  const shown = new Set(changes.map((c) => c.field));
  const facts: AuditFactView[] = [];
  if (detail) {
    for (const [key, value] of Object.entries(detail)) {
      if (key === "changes" && rawChanges) continue;
      if (shown.has(key)) continue;
      if (legacyField && (key === "from" || key === "to")) continue;
      facts.push({
        key,
        label: fieldLabel(t, key),
        value: key === "changed" ? renderFieldNames(t, value) : renderValue(key, value, ctx),
      });
    }
  } else if (log.detail !== null && log.detail !== undefined) {
    facts.push({
      key: "detail",
      label: t("audit.detail"),
      value: renderValue("detail", log.detail as AuditValue, ctx),
    });
  }

  return {
    id: log.id,
    action: log.action,
    actionLabel: actionLabel(t, log.action),
    family: actionFamily(log.action),
    dateLabel: formatInTimeZone(log.createdAt, AUDIT_TZ, "d MMM yyyy, HH:mm:ss", {
      locale: base.dateLocale,
    }),
    dateIso: log.createdAt.toISOString(),
    userLabel: userName ?? t("audit.system"),
    isSystem: userName === null,
    entityLabel: log.entity ? entityLabel(t, log.entity) : null,
    entityId: log.entityId,
    entityName: entityName(log.entity, log.entityId, base.lookups),
    entityHref: hrefFor(log.entity, log.entityId, base.lookups),
    clientHidden:
      log.entity === "client" && isUuid(log.entityId) && !base.lookups.clients.has(log.entityId),
    ip: log.ip,
    changes,
    facts,
    // Le JSON brut rend TOUT le détail d'un coup : il ne part que lorsque la
    // fiche et ses coordonnées sont ouvertes, sinon masquer les champs un à un
    // ne serait qu'un rideau devant une porte ouverte.
    rawJson: log.detail != null && contact ? JSON.stringify(log.detail, null, 2) : null,
  };
}
