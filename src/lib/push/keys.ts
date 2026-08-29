/**
 * Clés VAPID (RFC 8292) — lecture de l'environnement, validation, génération.
 *
 * Pur au sens du module `src/lib/sms` : aucun import Next.js, aucune base de
 * données. L'environnement s'injecte (`env`) pour que les tests décrivent une
 * configuration sans toucher au process.
 *
 * Deux décisions valent d'être expliquées.
 *
 * 1. `loadVapidKeys` ne LÈVE JAMAIS. Une notification poussée est un confort,
 *    pas le produit : une clé absente ou bancale doit dégrader l'écran en
 *    « push non configuré », jamais faire tomber une page qui, elle, affiche
 *    des fiches clients. Le diagnostic reste disponible (`readVapidKeys`) pour
 *    que l'écran d'administration dise POURQUOI.
 *
 * 2. La longueur des clés se vérifie à l'octet près. `createECDH().getPrivateKey()`
 *    rend le scalaire en gros-boutiste SANS ses zéros de tête : environ une clé
 *    sur trois cents sort sur 31 octets ou moins. Une telle clé s'enregistre
 *    sans broncher, signe des JWT que jose accepte… et se fait refuser par FCM
 *    ou APNs en 403 des semaines plus tard, quand plus personne ne fait le lien
 *    avec la génération. D'où `padTo32` à la génération, ET le refus au
 *    chargement : une clé courte en base est une bombe à retardement, pas une
 *    clé qu'on rattrape en la complétant en silence.
 */
import { createECDH } from "node:crypto";

/** Scalaire privé P-256 : 32 octets, zéros de tête compris. */
export const PRIVATE_KEY_BYTES = 32;
/** Point public P-256 non compressé : 0x04 || X(32) || Y(32). */
export const PUBLIC_KEY_BYTES = 65;
/** Préfixe du point non compressé — le seul que les services de push acceptent. */
const UNCOMPRESSED_TAG = 0x04;

const CURVE = "prime256v1";

export type VapidKeys = {
  /** Point public non compressé (65 octets), base64url. C'est le `k=` de l'en-tête. */
  publicKey: string;
  /** Scalaire privé (32 octets), base64url. */
  privateKey: string;
  /** Contact joignable par le service de push : `mailto:…` ou `https://…`. */
  subject: string;
};

/**
 * Pourquoi la configuration est refusée. Codes MACHINE (pas des libellés) :
 * l'écran qui les affiche les traduit dans son propre namespace.
 */
export type VapidKeyProblem =
  | "missing"
  | "private_length"
  | "public_length"
  | "public_format"
  | "mismatched_pair"
  | "subject";

export type VapidKeyRead = { ok: true; keys: VapidKeys } | { ok: false; problem: VapidKeyProblem };

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Décodage tolérant : une clé collée depuis une console arrive parfois en
 * base64 standard (`+`, `/`, `=`). Le décodeur base64url de Node lit les deux
 * alphabets ; c'est la LONGUEUR obtenue qui tranche, jamais la forme du texte.
 */
export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.trim(), "base64url");
}

/**
 * Complète un scalaire privé à 32 octets par la gauche.
 *
 * Un scalaire est un ENTIER : lui ajouter des zéros de tête ne le change pas,
 * le tronquer le détruirait — d'où le refus net au-delà de 32 octets plutôt
 * qu'une coupe silencieuse qui produirait une clé « presque bonne ».
 */
export function padTo32(bytes: Uint8Array): Buffer {
  if (bytes.length > PRIVATE_KEY_BYTES) {
    throw new Error(`clé privée de ${bytes.length} octets : P-256 n'en compte que ${PRIVATE_KEY_BYTES}`);
  }
  const padded = Buffer.alloc(PRIVATE_KEY_BYTES);
  Buffer.from(bytes).copy(padded, PRIVATE_KEY_BYTES - bytes.length);
  return padded;
}

/** Point public dérivé du scalaire, ou null si le scalaire est hors courbe. */
function publicPointFor(privateKey: Buffer): Buffer | null {
  try {
    const ecdh = createECDH(CURVE);
    ecdh.setPrivateKey(privateKey);
    return ecdh.getPublicKey(null, "uncompressed");
  } catch {
    return null;
  }
}

/** Le contact VAPID : seuls `mailto:` et `https:` ont un sens pour un service de push. */
function validSubject(subject: string): boolean {
  return /^mailto:.+@.+/.test(subject) || /^https:\/\/.+/.test(subject);
}

/**
 * Lecture DIAGNOSTIQUE : dit ce qui manque au lieu de se contenter d'un null.
 *
 * La paire est vérifiée pour de vrai (le point public est recalculé depuis le
 * privé) : deux clés qui ne vont pas ensemble — un copier-coller à moitié
 * rafraîchi dans Vercel — signeraient des JWT parfaitement valides sous une
 * identité que le service de push ne reconnaît pas. Ce 403-là est illisible
 * en production ; ici il coûte une multiplication de courbe.
 */
export function readVapidKeys(env: Record<string, string | undefined> = process.env): VapidKeyRead {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return { ok: false, problem: "missing" };

  const priv = fromBase64Url(privateKey);
  if (priv.length !== PRIVATE_KEY_BYTES) return { ok: false, problem: "private_length" };

  const pub = fromBase64Url(publicKey);
  if (pub.length !== PUBLIC_KEY_BYTES) return { ok: false, problem: "public_length" };
  if (pub[0] !== UNCOMPRESSED_TAG) return { ok: false, problem: "public_format" };

  const derived = publicPointFor(priv);
  if (!derived || !derived.equals(pub)) return { ok: false, problem: "mismatched_pair" };

  if (!validSubject(subject)) return { ok: false, problem: "subject" };

  // Ré-encodage : ce qui sort d'ici est en base64url canonique, quelle que
  // soit la forme collée dans l'environnement.
  return {
    ok: true,
    keys: { publicKey: toBase64Url(pub), privateKey: toBase64Url(priv), subject },
  };
}

/** Les clés utilisables, ou null si la poussée n'est pas configurée. Ne lève jamais. */
export function loadVapidKeys(env: Record<string, string | undefined> = process.env): VapidKeys | null {
  try {
    const read = readVapidKeys(env);
    return read.ok ? read.keys : null;
  } catch {
    // Même une entrée grotesque (base64 illisible) reste « non configuré » :
    // c'est le seul état que l'application sait afficher.
    return null;
  }
}

/**
 * Une paire VAPID neuve, en base64url, privée complétée à 32 octets.
 *
 * Le seul générateur autorisé du dépôt — voir l'en-tête pour les 31 octets qui
 * ne se voient qu'en production.
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: toBase64Url(ecdh.getPublicKey(null, "uncompressed")),
    privateKey: toBase64Url(padTo32(ecdh.getPrivateKey())),
  };
}
