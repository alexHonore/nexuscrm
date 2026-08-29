/**
 * Chiffrement d'une notification poussée — RFC 8291 (« Message Encryption for
 * Web Push »), codage de contenu `aes128gcm` de la RFC 8188.
 *
 * Le principe : le navigateur a publié une clé P-256 (`p256dh`) et un secret
 * d'authentification (`auth`) que LUI SEUL et nous connaissons. Le service de
 * push, lui, ne voit passer que des octets — il ne peut pas lire la
 * notification qu'il relaie. Personne d'autre que l'abonné ne déchiffre.
 *
 * Écrit à la main, sans dépendance : tout tient dans `node:crypto` (ECDH,
 * HMAC-SHA-256, AES-128-GCM) et l'enchaînement est entièrement décrit par la
 * RFC. Ajouter une bibliothèque pour ces quatre-vingts lignes reviendrait à
 * confier la boîte aux lettres de l'exploitant à un paquet de plus à surveiller.
 *
 * Les paramètres `salt` et `serverKeys` n'existent QUE pour épingler le vecteur
 * de test de la RFC 8291 §5 : sans eux, le chiffrement est non déterministe et
 * aucun test ne peut affirmer que notre dérivation est la bonne. En production
 * ils restent vides, et sel comme paire éphémère sont tirés au hasard à chaque
 * message — un sel réutilisé avec la même clé briserait AES-GCM.
 */
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

const CURVE = "prime256v1";

/** Taille d'enregistrement annoncée dans l'en-tête (RFC 8188). */
export const RECORD_SIZE = 4096;
/** sel(16) + rs(4) + longueur d'identifiant(1) + clé publique du serveur(65). */
export const HEADER_BYTES = 86;
/** Délimiteur de dernier enregistrement (RFC 8188 §2) — 0x02, pas 0x01. */
const LAST_RECORD_DELIMITER = 0x02;
/** Étiquette d'authentification AES-GCM. */
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const AUTH_SECRET_BYTES = 16;
const PUBLIC_KEY_BYTES = 65;
const CEK_BYTES = 16;
const NONCE_BYTES = 12;

/**
 * Ce qui reste pour la charge utile une fois l'enveloppe payée : l'en-tête, le
 * délimiteur de fin et l'étiquette GCM. 3993 octets — et c'est un plafond DUR :
 * au-delà, le service de push répond 413 et la notification est perdue.
 */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - 1 - TAG_BYTES;

/**
 * Ce JSON tient-il dans une notification ?
 *
 * Mesure en OCTETS, jamais en caractères : « Rappel : préparer l'évaluation »
 * coûte plus que sa longueur affichée, et un titre de fiche accentué peut
 * faire passer un message qui « faisait 3990 caractères » au-dessus de la
 * limite. `Buffer.byteLength` est la seule mesure qui compte.
 */
export function fitsInPush(json: string): boolean {
  return Buffer.byteLength(json, "utf8") <= MAX_PAYLOAD_BYTES;
}

export type EncryptInput = {
  /** Charge utile en clair — le JSON que le service worker recevra. */
  payload: string | Uint8Array;
  /** `subscription.keys.p256dh` : point public de l'abonné, base64url. */
  p256dh: string | Uint8Array;
  /** `subscription.keys.auth` : secret d'authentification (16 octets), base64url. */
  auth: string | Uint8Array;
};

/**
 * Le sel et la paire éphémère ÉPINGLÉS — pour reproduire le vecteur de la RFC,
 * et pour rien d'autre.
 *
 * Ils vivent dans un type séparé, derrière une fonction au nom explicite,
 * parce que les fixer tous les deux reproduit exactement la faute que la RFC
 * 8188 §2.1 interdit : même sel + même clé éphémère ⇒ mêmes CEK et NONCE ⇒
 * réutilisation du flux AES-GCM. Le XOR de deux textes chiffrés devient alors
 * le XOR des deux clairs, et l'étiquette d'authentification se forge. Laissés
 * sur la signature de production, ces deux champs étaient une invitation
 * gardée par un simple commentaire — et un commentaire ne refuse rien.
 */
export type EncryptFixtures = EncryptInput & {
  salt: string | Uint8Array;
  serverKeys: { privateKey: string | Uint8Array; publicKey?: string | Uint8Array };
};

type EncryptInternal = EncryptInput & Partial<Pick<EncryptFixtures, "salt" | "serverKeys">>;

function bytes(value: string | Uint8Array): Buffer {
  return typeof value === "string" ? Buffer.from(value.trim(), "base64url") : Buffer.from(value);
}

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * HKDF de la RFC 5869 réduit à ce dont le Web Push a besoin : une seule
 * itération d'expansion. Toutes les sorties d'ici font au plus 32 octets, donc
 * le compteur reste à 0x01 — dérouler la boucle générale ne servirait qu'à
 * ajouter du code non exercé.
 */
function hkdfOne(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.from([0x01])])).subarray(0, length);
}

/** `label` || 0x00 — la forme d'`info` qu'imposent les RFC 8188 et 8291. */
function labelInfo(label: string, ...parts: Uint8Array[]): Buffer {
  return Buffer.concat([Buffer.from(`${label}\0`, "utf8"), ...parts]);
}

/**
 * Le corps `aes128gcm` complet, prêt à être POSTé tel quel.
 *
 * Un seul enregistrement : une notification tient dans 4 Ko par construction
 * (voir `MAX_PAYLOAD_BYTES`), donc le découpage en enregistrements multiples de
 * la RFC 8188 ne se présente jamais. Le refuser explicitement vaut mieux que de
 * produire un corps que l'abonné ne saura pas rassembler.
 */
export function encryptPayload(input: EncryptInput): Buffer {
  return encryptInternal(input);
}

/**
 * La variante DÉTERMINISTE, réservée aux tests. Son nom est long exprès : on ne
 * l'appelle pas par distraction, et une revue la repère à la lecture.
 */
export function encryptPayloadWithFixtures(input: EncryptFixtures): Buffer {
  return encryptInternal(input);
}

function encryptInternal({ payload, p256dh, auth, salt, serverKeys }: EncryptInternal): Buffer {
  const plaintextBytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  if (plaintextBytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`charge utile de ${plaintextBytes.length} octets : ${MAX_PAYLOAD_BYTES} au maximum`);
  }

  const uaPublic = bytes(p256dh);
  if (uaPublic.length !== PUBLIC_KEY_BYTES || uaPublic[0] !== 0x04) {
    throw new Error("p256dh : point P-256 non compressé de 65 octets attendu");
  }
  const authSecret = bytes(auth);
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(`auth : ${AUTH_SECRET_BYTES} octets attendus, ${authSecret.length} reçus`);
  }

  const saltBytes = salt === undefined ? randomBytes(SALT_BYTES) : bytes(salt);
  if (saltBytes.length !== SALT_BYTES) {
    throw new Error(`sel : ${SALT_BYTES} octets attendus, ${saltBytes.length} reçus`);
  }

  const ecdh = createECDH(CURVE);
  if (serverKeys) {
    ecdh.setPrivateKey(bytes(serverKeys.privateKey));
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey(null, "uncompressed");
  if (serverKeys?.publicKey && !bytes(serverKeys.publicKey).equals(asPublic)) {
    // Une paire dépareillée chiffrerait pour une identité que l'abonné ne
    // dérivera pas : autant le dire ici plutôt que d'expédier du bruit.
    throw new Error("serverKeys : la clé publique ne dérive pas de la privée");
  }

  const sharedSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3 : le secret d'authentification est le SEL de cette première
  // dérivation, et le matériau la clé partagée — l'ordre inverse de l'intuition.
  const prkKey = hmac(authSecret, sharedSecret);
  const ikm = hkdfOne(prkKey, labelInfo("WebPush: info", uaPublic, asPublic), 32);

  const prk = hmac(saltBytes, ikm);
  const cek = hkdfOne(prk, labelInfo("Content-Encoding: aes128gcm"), CEK_BYTES);
  const nonce = hkdfOne(prk, labelInfo("Content-Encoding: nonce"), NONCE_BYTES);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintextBytes, Buffer.from([LAST_RECORD_DELIMITER])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(HEADER_BYTES);
  saltBytes.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(PUBLIC_KEY_BYTES, SALT_BYTES + 4);
  asPublic.copy(header, SALT_BYTES + 5);

  return Buffer.concat([header, sealed]);
}
