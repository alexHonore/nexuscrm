import "server-only";
import { headers } from "next/headers";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";

// ── Détection de l'IP client ─────────────────────────────────────────────────

/**
 * Nettoie une valeur d'en-tête : enlève les crochets IPv6, un éventuel port,
 * et déplie les adresses IPv4 encapsulées en IPv6 ("::ffff:1.2.3.4").
 */
function cleanIpCandidate(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  // "[2001:db8::1]:443" → "2001:db8::1"
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1];
  // "1.2.3.4:5678" → "1.2.3.4" (un seul ':' ⇒ port, pas de l'IPv6)
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.indexOf(":"));

  // "::ffff:1.2.3.4" → "1.2.3.4"
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) value = mapped[1];

  return value || null;
}

/**
 * Vrai seulement pour une IP routable publiquement : on écarte le loopback et
 * les plages privées, qui ne distinguent pas les clients entre eux (en local
 * *tout le monde* est `::1` — un seul visiteur en échec bloquerait les autres).
 */
function isPublicIp(value: string): boolean {
  const ip = value.toLowerCase();
  if (!ip || ip === "unknown" || ip === "::" || ip === "::1") return false;

  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (octets.some((o) => Number.isNaN(o) || o > 255)) return false;
    const [a, b] = octets;
    if (a === 0 || a === 127) return false; // « ce réseau » / loopback
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 169 && b === 254) return false; // link-local
    return true;
  }

  // IPv6 : la forme doit être VALIDE, pas seulement « contenir un ":" », sinon
  // n'importe quelle chaîne (JSON, injection…) finirait dans audit_logs.ip et
  // comme clé du limiteur par IP.
  if (!isValidIpv6(ip)) return false;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return false; // fc00::/7 (unique local)
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return false; // fe80::/10 (link-local)
  return true;
}

/** Validation IPv6 stricte (avec « :: » compressé et suffixe IPv4 éventuel). */
function isValidIpv6(value: string): boolean {
  if (!value.includes(":")) return false;
  if (/[^0-9a-f:.]/.test(value)) return false;
  if ((value.match(/::/g) ?? []).length > 1) return false;

  const [head, tail = null] = value.split("::");
  const parse = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      // Un groupe IPv4 n'est permis qu'en dernière position (::ffff:1.2.3.4).
      if (g.includes(".")) {
        if (i !== groups.length - 1) return null;
        const v4 = g.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!v4 || v4.slice(1).some((o) => Number(o) > 255)) return null;
        out.push("0", "0"); // un IPv4 occupe deux groupes
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(g);
    }
    return out;
  };

  const left = parse(head);
  if (left === null) return false;
  if (tail === null) return left.length === 8; // pas de "::" → 8 groupes exacts
  const right = parse(tail);
  if (right === null) return false;
  return left.length + right.length <= 7; // "::" remplace ≥ 1 groupe nul
}

/** Première IP publique d'une liste "a, b, c" (format x-forwarded-for). */
function firstPublicOf(headerValue: string | null): string | null {
  if (!headerValue) return null;
  for (const part of headerValue.split(",")) {
    const candidate = cleanIpCandidate(part);
    if (candidate && isPublicIp(candidate)) return candidate;
  }
  return null;
}

/**
 * IP réelle du client d'après des en-têtes déjà lus, ou `null`.
 *
 * Ordre : `x-vercel-forwarded-for` (posé par Vercel, non falsifiable) →
 * `x-real-ip` → première entrée **publique** de `x-forwarded-for`.
 */
export function clientIpFromHeaders(h: Headers): string | null {
  const vercel = cleanIpCandidate(h.get("x-vercel-forwarded-for") ?? "");
  if (vercel && isPublicIp(vercel)) return vercel;

  const real = cleanIpCandidate(h.get("x-real-ip") ?? "");
  if (real && isPublicIp(real)) return real;

  return firstPublicOf(h.get("x-forwarded-for"));
}

/**
 * IP réelle du client de la requête en cours, ou `null` si rien d'exploitable.
 *
 * Renvoyer `null` est volontaire : hors contexte requête (cron, seed) ou en
 * local, mieux vaut aucune IP qu'une valeur partagée comme `::1` — les
 * limiteurs par IP doivent alors être ignorés plutôt que de mettre tous les
 * visiteurs sous une même clé.
 */
export async function getClientIp(): Promise<string | null> {
  try {
    return clientIpFromHeaders(await headers());
  } catch {
    return null; // hors contexte requête (cron, seed)
  }
}

// ── Différentiel « avant → après » ───────────────────────────────────────────

/** Valeur consignable dans `detail` : JSON pur (jamais un `Date`, jamais un secret). */
export type AuditValue =
  | string
  | number
  | boolean
  | null
  | AuditValue[]
  | { [key: string]: AuditValue };

/** Un champ modifié : sa valeur avant et après. */
export type AuditChange = { from: AuditValue; to: AuditValue };

/** Contenu de `detail.changes` — uniquement les champs réellement modifiés. */
export type AuditChanges = Record<string, AuditChange>;

/** Objet source d'un différentiel (ligne de base, corps de requête, réglages…). */
export type AuditSource = Record<string, unknown> | null | undefined;

/**
 * Marqueurs consignés À LA PLACE d'un secret (mot de passe SIP, hash, jeton).
 * Le journal doit dire « ça a changé », jamais « voici la valeur ».
 * L'écran /admin/audit les traduit ; ils restent lisibles en JSON brut.
 */
export const SECRET_MARKERS = {
  set: "(défini)",
  none: "(aucun)",
  updated: "(modifié)",
} as const;

const SECRET_FIELD_RE =
  /password|passwd|secret|token|hash|apikey|api[_-]?key|credential|private[_-]?key|enc$/i;

/**
 * Vrai si le nom de champ peut transporter un secret. Filet de sécurité : même
 * si un appelant passe une ligne complète (`passwordHash`, `sipPasswordEnc`…),
 * la valeur n'atteint jamais `audit_logs`.
 */
export function isSecretField(field: string): boolean {
  return SECRET_FIELD_RE.test(field);
}

/** Changement d'un secret : présence avant/après, jamais la valeur. */
export function secretChange(hadBefore: boolean, hasAfter = true): AuditChange {
  return {
    from: hadBefore ? SECRET_MARKERS.set : SECRET_MARKERS.none,
    to: hasAfter ? SECRET_MARKERS.updated : SECRET_MARKERS.none,
  };
}

/**
 * Normalise une valeur pour la comparaison ET pour le stockage :
 * `Date` → ISO, `undefined`/chaîne vide → `null`, secrets imbriqués masqués.
 */
function normaliseValue(value: unknown): AuditValue {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (typeof value === "object") {
    const out: Record<string, AuditValue> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const normalised = normaliseValue(nested);
      out[key] =
        isSecretField(key) && normalised !== null ? SECRET_MARKERS.set : normalised;
    }
    return out;
  }
  return null; // fonction, symbole…
}

/** Égalité profonde sur des valeurs déjà normalisées (ordre des clés ignoré). */
function deepEqual(a: AuditValue, b: AuditValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => key in b && deepEqual(a[key], b[key]));
}

/**
 * Différentiel des champs demandés entre deux états.
 *
 * - ne retient QUE les champs modifiés (comparaison profonde) ;
 * - `null` en entrée = création (`from: null`) ou suppression (`to: null`) ;
 * - les champs sensibles sont réduits à un marqueur (`SECRET_MARKERS`).
 *
 * Renvoie `null` si rien n'a changé — l'appelant n'écrit alors pas `changes`.
 */
export function diffFields(
  before: AuditSource,
  after: AuditSource,
  fields: readonly string[],
): AuditChanges | null {
  const changes: AuditChanges = {};
  for (const field of fields) {
    const from = normaliseValue(before?.[field]);
    const to = normaliseValue(after?.[field]);
    if (deepEqual(from, to)) continue;
    changes[field] = isSecretField(field)
      ? secretChange(from !== null, to !== null)
      : { from, to };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

// ── Filet de sécurité : aucun secret dans `detail` ───────────────────────────

const MARKER_VALUES = new Set<string>(Object.values(SECRET_MARKERS));

function isMarker(value: unknown): boolean {
  return value === null || (typeof value === "string" && MARKER_VALUES.has(value));
}

/** Valeur sous une clé sensible : on garde les marqueurs et les booléens, rien d'autre. */
function maskSecret(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean" || isMarker(value)) return value;
  // { from: "(défini)", to: "(modifié)" } produit par `diffFields` : déjà sûr.
  if (typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    const onlyChange = keys.length > 0 && keys.every((k) => k === "from" || k === "to");
    if (onlyChange && Object.values(value as Record<string, unknown>).every(isMarker)) return value;
  }
  return SECRET_MARKERS.set;
}

/** Masque les paramètres sensibles d'une URL (clé d'API voip.ms, jeton signé…). */
function redactUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    let touched = false;
    for (const key of [...url.searchParams.keys()]) {
      if (!isSecretField(key)) continue;
      url.searchParams.set(key, SECRET_MARKERS.set);
      touched = true;
    }
    return touched ? url.toString() : value;
  } catch {
    return value;
  }
}

/**
 * Dernier rempart avant l'écriture : quel que soit l'appelant, une valeur
 * sensible (clé nommée `*password*`, `*token*`, URL avec identifiants…) ne doit
 * jamais atterrir dans `audit_logs`. Tout le reste est conservé tel quel.
 */
function sanitiseDetail(value: unknown, depth = 0): unknown {
  if (depth > 8) return null; // profondeur absurde : on coupe plutôt que de boucler
  if (typeof value === "string") return redactUrl(value);
  if (Array.isArray(value)) return value.map((item) => sanitiseDetail(item, depth + 1));
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretField(key) ? maskSecret(nested) : sanitiseDetail(nested, depth + 1);
    }
    return out;
  }
  return value;
}

// ── Journal d'audit ──────────────────────────────────────────────────────────

export async function logAudit(entry: {
  userId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  detail?: unknown;
}): Promise<void> {
  try {
    const ip = await getClientIp();
    await db.insert(auditLogs).values({
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity ?? null,
      entityId: entry.entityId ?? null,
      detail: entry.detail == null ? null : sanitiseDetail(entry.detail),
      ip,
    });
  } catch (err) {
    // L'audit ne doit jamais faire échouer l'action principale.
    console.error("audit log failed", err);
  }
}
