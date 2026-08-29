/**
 * En-tête d'autorisation VAPID (RFC 8292) — « Voluntary Application Server
 * Identification ».
 *
 * Ce que le service de push (FCM, APNs, Mozilla) vérifie : un JWT ES256 signé
 * par la clé privée dont il connaît déjà la publique, adressé À LUI
 * (`aud`), et pas éternel (`exp`). C'est une identité, pas un secret partagé :
 * la clé publique voyage en clair dans le même en-tête.
 *
 * Trois pièges méritent leur ligne de code.
 *
 * 1. `aud` est l'ORIGINE du point de terminaison, pas son URL. Le chemin
 *    contient l'identifiant de l'abonnement ; le mettre dans `aud` fabrique un
 *    JWT différent par abonné — impossible à mettre en cache, et refusé par
 *    certains services. Une origine, un jeton, tout le lot.
 *
 * 2. `exp` est plafonné à 24 h par la RFC. On signe pour 12 h : assez long pour
 *    qu'un envoi groupé réutilise le même jeton, assez court pour qu'une
 *    horloge de serveur en léger décalage ne fasse pas expirer le jeton avant
 *    qu'il n'arrive.
 *
 * 3. `nowMs` est un PARAMÈTRE. Une signature qui lit l'horloge en cachette ne
 *    se teste pas ; ici la fenêtre d'expiration s'affirme dans un test.
 */
import { SignJWT, importJWK, type JWK } from "jose";
import {
  PRIVATE_KEY_BYTES,
  PUBLIC_KEY_BYTES,
  fromBase64Url,
  toBase64Url,
  type VapidKeys,
} from "./keys";

/** Durée de vie signée. Confortable pour un lot, courte devant le plafond. */
export const VAPID_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** Plafond imposé par la RFC 8292 §2 : au-delà, le service de push refuse. */
export const VAPID_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Le point public non compressé (0x04 || X || Y) éclaté en JWK P-256.
 *
 * Écrit à la main plutôt que par un import de clé PKCS#8 : la seule forme dans
 * laquelle ces clés existent ici est celle des 65 octets bruts, et fabriquer
 * un DER autour pour le redéfaire aussitôt ajouterait un format de plus à se
 * tromper. X et Y sont des tranches à position FIXE — c'est aussi ce qui rend
 * la validation de longueur de `keys.ts` non négociable.
 */
export function vapidJwk(keys: Pick<VapidKeys, "publicKey" | "privateKey">): JWK {
  const point = fromBase64Url(keys.publicKey);
  if (point.length !== PUBLIC_KEY_BYTES || point[0] !== 0x04) {
    throw new Error("clé publique VAPID : point P-256 non compressé de 65 octets attendu");
  }
  // Le scalaire PRIVÉ est vérifié ici aussi, et pas seulement dans `keys.ts`.
  // La RFC 7518 §6.2.2.1 exige exactement 32 octets pour `d` sur P-256, et
  // `createECDH().getPrivateKey()` en rend moins environ 3 fois sur 1000 (Node
  // retire les zéros de tête). Sans ce garde, `vapidAuthorization` SIGNE en
  // silence un jeton qu'un service de push refusera par un 403 sans motif —
  // la panne la plus difficile à relier à sa cause de tout ce module. Le
  // chemin d'envoi passe déjà par `readVapidKeys`, qui refuse ; ceci protège
  // le prochain appelant, qui n'y passera peut-être pas.
  const scalar = fromBase64Url(keys.privateKey);
  if (scalar.length !== PRIVATE_KEY_BYTES) {
    throw new Error("clé privée VAPID : scalaire P-256 de 32 octets attendu");
  }
  return {
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
    x: toBase64Url(point.subarray(1, 33)),
    y: toBase64Url(point.subarray(33, 65)),
    d: toBase64Url(scalar),
  };
}

export type VapidAuthorizationInput = {
  /** Point de terminaison de l'abonnement — seule son ORIGINE entre dans `aud`. */
  endpoint: string;
  keys: VapidKeys;
  /** Injectable pour les tests ; l'horloge réelle par défaut. */
  nowMs?: number;
  lifetimeMs?: number;
};

/**
 * `Authorization: vapid t=<jwt>,k=<clé publique base64url>`.
 *
 * Forme exacte de la RFC 8292 §3.2 : une virgule, aucune espace — plusieurs
 * services de push analysent cet en-tête au caractère près.
 */
export async function vapidAuthorization({
  endpoint,
  keys,
  nowMs = Date.now(),
  lifetimeMs = VAPID_TOKEN_LIFETIME_MS,
}: VapidAuthorizationInput): Promise<string> {
  const audience = new URL(endpoint).origin;
  const lifetime = Math.min(Math.max(lifetimeMs, 0), VAPID_MAX_LIFETIME_MS);
  const expSeconds = Math.floor((nowMs + lifetime) / 1000);

  const key = await importJWK(vapidJwk(keys), "ES256");
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setAudience(audience)
    .setExpirationTime(expSeconds)
    .setSubject(keys.subject)
    .sign(key);

  return `vapid t=${token},k=${toBase64Url(fromBase64Url(keys.publicKey))}`;
}
