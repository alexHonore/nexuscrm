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

export type AuditEntryView = {
  id: number;
  action: string;
  actionLabel: string;
  dateLabel: string;
  dateIso: string;
  userLabel: string;
  isSystem: boolean;
  entityLabel: string | null;
  entityId: string | null;
  entityName: string | null;
  entityHref: string | null;
  ip: string | null;
  changes: AuditChangeView[];
  facts: AuditFactView[];
  rawJson: string | null;
};

/** Correspondances id → nom, chargées en lot pour la page entière. */
export type AuditLookups = {
  users: Map<string, string>;
  categories: Map<number, string>;
  sources: Map<number, string>;
  clients: Map<string, string>;
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
};

const EMPTY = "—";
const MAX_TEXT = 600;
/** Horodatage ISO complet — assez strict pour ne pas attraper un nom ou un budget. */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_ID_FIELDS = new Set(["assignedToId", "createdById", "userId", "assignedTo"]);
const PHONE_FIELDS = new Set(["phone", "phoneAlt", "didNumber", "did", "number"]);
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
    return { text: lookups.clients.get(value) ?? String(value) };
  }
  if (PHONE_FIELDS.has(field) && typeof value === "string") {
    return { text: formatPhone(value) || String(value) };
  }
  if ((field === "language" || field === "locale") && (value === "fr" || value === "en")) {
    return { text: t(value === "fr" ? "users.localeFr" : "users.localeEn") };
  }
  if (field === "role" && (value === "admin" || value === "caller")) {
    return { text: t(value === "admin" ? "users.roleAdmin" : "users.roleCaller") };
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

/** Une ligne d'audit → tout ce que l'écran doit montrer, déjà mis en forme. */
export function buildAuditEntry(
  log: AuditLogRow,
  userName: string | null,
  base: Omit<Ctx, "entity">,
): AuditEntryView {
  const ctx: Ctx = { ...base, entity: log.entity };
  const { t } = base;
  const detail = asRecord(log.detail);

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
    ip: log.ip,
    changes,
    facts,
    rawJson: log.detail != null ? JSON.stringify(log.detail, null, 2) : null,
  };
}
