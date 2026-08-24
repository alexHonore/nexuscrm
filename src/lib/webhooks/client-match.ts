import { asc, eq, like, or, sql, type SQL } from "drizzle-orm";
import { clients } from "@/db/schema";
import { phoneMatchKey } from "@/lib/phone";

/**
 * Rattachement d'un numéro ENTRANT (lead, SMS) à une fiche client — une seule
 * définition pour que les webhooks se comportent pareil.
 *
 * 1. L'E.164 exact l'emporte toujours (principal ou secondaire).
 * 2. Sinon, les 10 DERNIERS chiffres — et jamais une clé plus courte :
 *    `phoneMatchKey` renvoie `null` sous 10 chiffres, et l'on se rabat alors
 *    sur l'égalité exacte. Sans ce garde-fou, un lead « 476-1542 » (7 chiffres,
 *    gardé tel quel par `normalizePhone`) faisait `LIKE '%4761542'` et se
 *    fondait dans la fiche de n'importe qui dont le numéro finit ainsi.
 *
 * `orderBy` rend le choix déterministe quand plusieurs fiches partagent les 10
 * derniers chiffres : l'exact d'abord, puis la plus ancienne.
 */
export function clientPhoneMatch(e164: string): { where: SQL; orderBy: SQL[] } {
  const matchKey = phoneMatchKey(e164);
  const where = matchKey
    ? or(like(clients.phone, `%${matchKey}`), like(clients.phoneAlt, `%${matchKey}`))!
    : or(eq(clients.phone, e164), eq(clients.phoneAlt, e164))!;
  const orderBy = [
    // CASE plutôt qu'un booléen trié : `phone_alt = x` vaut NULL quand
    // phone_alt est NULL, et NULL passerait devant en DESC.
    asc(sql`case when ${clients.phone} = ${e164} or ${clients.phoneAlt} = ${e164} then 0 else 1 end`),
    asc(clients.createdAt),
  ];
  return { where, orderBy };
}
