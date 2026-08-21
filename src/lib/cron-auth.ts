import { timingSafeEqual } from "crypto";

/**
 * Vérifie `Authorization: Bearer <CRON_SECRET>` en temps constant.
 *
 * Une comparaison `!==` court-circuite au premier octet différent : le temps
 * de réponse révèle combien de caractères sont justes. Pour un secret qui
 * ouvre le répartiteur, ça vaut les trois lignes.
 */
export function isCronAuthorized(authorizationHeader: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(authorizationHeader ?? "");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
