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
      detail: entry.detail ?? null,
      ip,
    });
  } catch (err) {
    // L'audit ne doit jamais faire échouer l'action principale.
    console.error("audit log failed", err);
  }
}
