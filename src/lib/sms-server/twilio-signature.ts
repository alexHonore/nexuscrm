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
