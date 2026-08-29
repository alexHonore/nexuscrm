import { collapseTag, pushRule } from "./policy";
import type { PushUrgency } from "./send";

/**
 * Ce qui voyage jusqu'au téléphone. Volontairement plat et bête : c'est du JSON
 * chiffré lu par `public/sw.js`, un fichier qui ne partage aucun type avec
 * l'application et ne peut donc rien déduire.
 */
export type PushPayload = {
  title: string;
  body: string | null;
  /** Chemin RELATIF — le service worker le résout contre sa propre origine. */
  url: string;
  /** L'étiquette de fusion : deux notifications de même étiquette n'en font qu'une. */
  tag: string;
  type: string;
  /** Le nombre à peindre sur l'icône de l'application (iOS le sait faire, Android non). */
  badge?: number;
};

/**
 * Le plafond réel d'un message poussé.
 *
 * La RFC 8030 garantit 4096 OCTETS pour le corps chiffré, et l'enveloppe
 * aes128gcm en consomme une partie avant le premier caractère utile :
 * 86 octets d'en-tête (sel 16 + taille d'enregistrement 4 + longueur de clé 1 +
 * clé publique 65), 1 octet de délimiteur de remplissage, 16 octets
 * d'authentification GCM. Reste 3993.
 *
 * Le compte est en OCTETS et pas en caractères : « rendez-vous confirmé » coûte
 * deux octets par accent en UTF-8. Dépasser ne produit pas d'erreur visible —
 * le service de push répond 413 et la notification n'apparaît simplement
 * jamais.
 */
export const PUSH_ENVELOPE_BYTES = 86 + 1 + 16;
export const MAX_PUSH_BYTES = 4096 - PUSH_ENVELOPE_BYTES;

/** Ce qu'il reste au titre et au corps une fois l'ossature JSON déduite. */
const TEXT_BUDGET = 1500;

/**
 * Tronque en respectant les OCTETS, jamais au milieu d'un caractère : une
 * coupe à l'octet près scinde un « é » en deux et le téléphone affiche un
 * losange noir à la place du dernier mot.
 */
export function clampBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes - 3) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

export function buildPushPayload(row: {
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  badge?: number;
}): PushPayload {
  return {
    title: clampBytes(row.title, 200),
    // Un corps vide rend une notification réduite à son titre, que certains
    // lanceurs Android affichent de travers. Mieux vaut ne pas envoyer la clé.
    body: row.body ? clampBytes(row.body, TEXT_BUDGET) : null,
    // La cloche est la destination de repli : une notification dont le lien a
    // disparu doit tout de même MENER quelque part, sinon le geste n'a servi
    // à rien et le téléphoniste croit l'application cassée.
    url: row.link ?? "/notifications",
    tag: collapseTag(row.type, row.link),
    type: row.type,
    ...(row.badge !== undefined ? { badge: row.badge } : {}),
  };
}

/**
 * Sérialise en garantissant la tenue dans l'enveloppe. On rogne le corps plutôt
 * que d'échouer : une notification amputée reste une notification: reçue, elle
 * fait ouvrir l'application, et l'application a le texte entier.
 */
export function serializePushPayload(payload: PushPayload): string {
  let json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") <= MAX_PUSH_BYTES) return json;
  const overflow = Buffer.byteLength(json, "utf8") - MAX_PUSH_BYTES;
  const body = payload.body
    ? clampBytes(payload.body, Math.max(0, Buffer.byteLength(payload.body, "utf8") - overflow - 8))
    : null;
  json = JSON.stringify({ ...payload, body });
  if (Buffer.byteLength(json, "utf8") <= MAX_PUSH_BYTES) return json;
  // Dernier recours : le titre seul. Il tient toujours (borné à 200 octets).
  return JSON.stringify({ ...payload, body: null, title: clampBytes(payload.title, 200) });
}

/** Les options RFC 8030 qui accompagnent l'envoi, dérivées du type. */
export function pushOptionsFor(type: string): { ttl: number; urgency: PushUrgency } {
  const rule = pushRule(type);
  return { ttl: rule.ttl, urgency: rule.urgency };
}
