import type { CampaignVariant } from "./schema";

/**
 * Tirage A/B — DÉTERMINISTE, à partir de (campagne, client).
 *
 * Pas de hasard : la même paire donne toujours la même variante. Trois raisons,
 * toutes vécues ailleurs :
 *
 *  · Une inscription rejouée (job repris, double déclencheur) ne peut pas
 *    basculer la personne d'une variante à l'autre au milieu de l'échelle.
 *  · Le résultat du test reste attribuable : personne ne reçoit A puis B.
 *  · Les tests n'ont pas besoin d'injecter une horloge ou un générateur.
 *
 * Les poids sont respectés en agrégat, pas individuellement — c'est ce qu'on
 * veut : un poids 90/10 met environ 9 personnes sur 10 dans A, sans jamais
 * dépendre de l'ordre d'arrivée.
 */

/** FNV-1a 32 bits — court, stable, sans dépendance. Aucun usage cryptographique. */
export function hashKey(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Multiplication FNV en 32 bits non signés.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Choisit la variante d'un client. Retourne "" quand la campagne n'en a aucune
 * — une campagne sans test A/B n'est pas un cas limite, c'est le cas courant.
 */
export function pickVariant(
  variants: CampaignVariant[],
  campaignId: string,
  clientId: string,
): string {
  const eligible = variants.filter((v) => v.weight > 0);
  if (eligible.length === 0) return "";
  if (eligible.length === 1) return eligible[0].key;

  const total = eligible.reduce((sum, v) => sum + v.weight, 0);
  // Le tirage porte sur la paire, jamais sur l'ordre : deux campagnes
  // différentes répartissent les mêmes personnes différemment.
  const point = hashKey(`${campaignId}:${clientId}`) % total;

  let cursor = 0;
  for (const variant of eligible) {
    cursor += variant.weight;
    if (point < cursor) return variant.key;
  }
  // Inatteignable (point < total), mais un repli explicite vaut mieux qu'un
  // `undefined` qui s'écrirait en base comme variante.
  return eligible[eligible.length - 1].key;
}

/** Le corps d'ouverture d'une variante, ou null si elle n'en impose pas. */
export function variantBody(variants: CampaignVariant[], key: string): string | null {
  const found = variants.find((v) => v.key === key);
  if (!found) return null;
  return found.body.trim() === "" ? null : found.body;
}
