import { createHmac, timingSafeEqual } from "crypto";

/**
 * Validation de signature Twilio pour les webhooks Messaging :
 * base64(HMAC-SHA1(url complète + params POST triés, authToken)) — même spec
 * que la validation voix déjà en place dans /api/telephony/twiml.
 *
 * Fonction pure (l'URL et le jeton sont injectés) pour être testable sans
 * requête Next. Le comportement sans jeton copie le précédent voix : on laisse
 * passer hors production seulement — en production, absence de jeton = refus.
 */
export function isValidTwilioSignature(input: {
  /** URL publique complète telle que configurée chez Twilio (query incluse). */
  url: string;
  /** Corps POST application/x-www-form-urlencoded, déjà parsé. */
  params: URLSearchParams;
  /** Header X-Twilio-Signature (null si absent). */
  signature: string | null;
  authToken: string | undefined;
  isProduction: boolean;
}): boolean {
  const { url, params, signature, authToken, isProduction } = input;
  if (!authToken) return !isProduction;
  if (!signature) return false;

  const data =
    url +
    [...params.keys()]
      .sort()
      .map((k) => k + (params.get(k) ?? ""))
      .join("");

  const expected = createHmac("sha1", authToken).update(data, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** URL publique d'un webhook, reconstruite comme la config Twilio la connaît. */
export function publicWebhookUrl(path: string, search = ""): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  return `${base ?? ""}${path}${search}`;
}

/**
 * Validation multi-URL : vraie si la signature valide pour AU MOINS UNE des
 * URL candidates. Twilio signe l'URL exactement telle qu'elle est configurée
 * chez lui — que NOUS ne connaissons pas avec certitude. On essaie donc
 * l'URL reconstruite de NEXT_PUBLIC_APP_URL ET celle que porte la requête
 * (x-forwarded-host) : une divergence de domaine ou de protocole entre les
 * deux réglages ne doit plus jeter chaque réponse de client en silence.
 * Sans candidate, le comportement suit la règle du jeton absent : fermé en
 * production.
 */
export function isValidTwilioSignatureAnyUrl(input: {
  urls: string[];
  params: URLSearchParams;
  signature: string | null;
  authToken: string | undefined;
  isProduction: boolean;
}): boolean {
  const { urls, params, signature, authToken, isProduction } = input;
  if (!authToken) return !isProduction;
  if (urls.length === 0) return false;
  return urls.some((url) => isValidTwilioSignature({ url, params, signature, authToken, isProduction }));
}

/**
 * URL candidates d'un webhook, dans l'ordre de confiance : la reconstruction
 * depuis NEXT_PUBLIC_APP_URL (la config déclarée), puis l'adresse réellement
 * appelée d'après les en-têtes du mandataire (x-forwarded-*). Dédoublonnées —
 * quand tout est bien configuré, les deux coïncident.
 */
export function webhookUrlCandidates(input: {
  path: string;
  search?: string;
  headers: { get(name: string): string | null };
}): string[] {
  const { path, headers } = input;
  const search = input.search ?? "";
  const urls = new Set<string>();
  const envBase = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (envBase) urls.add(`${envBase}${path}${search}`);
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (host) {
    const proto = headers.get("x-forwarded-proto") ?? "https";
    urls.add(`${proto}://${host}${path}${search}`);
  }
  return [...urls];
}
