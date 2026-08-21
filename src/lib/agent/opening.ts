/**
 * Consigne de tour quand l'assistant écrit EN PREMIER — module PUR, partagé
 * par la production (`runtime.ts`) et le bac à sable (`sandbox.ts`).
 *
 * Une seule copie, délibérément : l'ouverture qu'un admin approuve dans le bac
 * à sable doit être produite par la MÊME consigne que celle qui part en
 * production. Une version antérieure du bac à sable avait sa propre
 * formulation (« Ce contact vient d'arriver comme nouveau lead… ») et l'admin
 * réglait un ton sur un message que la production n'écrivait jamais.
 *
 * Les fournisseurs exigent au moins un message ; « écris l'ouverture » est
 * exactement ce que demande un barreau de campagne sans texte. Le nom et la
 * description de la campagne donnent au modèle le POURQUOI du message
 * (réactivation, nouveau lead…) — marqués « à ne pas citer » pour qu'il
 * n'écrive pas « dans le cadre de notre campagne ». La consigne n'est jamais
 * stockée comme message : le contact ne la voit pas et l'historique des tours
 * suivants ne la contient pas.
 */

export interface OutreachInstructionInput {
  /** Barreau de l'échelle : 0 = ouverture, n > 0 = n-ième relance. */
  step: number;
  /** Nombre de messages déjà présents dans le fil (entrants ET sortants). */
  historyLength: number;
  /** Nom de la campagne — vide ou absent = aucun contexte interne. */
  campaignName?: string | null;
  campaignDescription?: string | null;
  /**
   * Longueur de l'échelle de la campagne (ouverture comprise). Sert à dire au
   * modèle « relance 1 sur 3 » : il ne formule pas de la même façon une
   * dernière relance et une première. Absente, le total vaut le barreau
   * courant — c'est ce que fait la production quand la campagne est introuvable.
   */
  ladderLength?: number | null;
}

/** Le bloc « Contexte interne (à ne pas citer) : … » ou "" sans campagne. */
export function outreachContext(
  campaignName?: string | null,
  campaignDescription?: string | null,
): string {
  const name = campaignName?.trim() ?? "";
  if (name === "") return "";
  const description = campaignDescription?.trim() ?? "";
  return `Contexte interne (à ne pas citer) : ${name}${description ? ` — ${description}` : ""}.`;
}

/**
 * La consigne exacte, mot pour mot, que la production envoie comme tour
 * `user` quand il n'y a pas de message entrant.
 */
export function outreachInstructionText(input: OutreachInstructionInput): string {
  const context = outreachContext(input.campaignName, input.campaignDescription);

  if (input.step === 0) {
    return input.historyLength === 0
      ? `Tu écris en premier : ce contact n'a encore reçu aucun message de ta part. ${context} Écris le PREMIER message de la conversation.`.trim()
      : `Tu écris en premier dans ce fil : tiens compte des échanges précédents. ${context} Écris ton premier message.`.trim();
  }
  const ladderLength = input.ladderLength ?? 0;
  const total = Math.max(ladderLength - 1, input.step);
  return `Tu relances : le contact n'a pas répondu à ton dernier message (relance ${input.step} sur ${total}). ${context} Écris une relance courte qui ne répète pas le message précédent et laisse une porte de sortie.`.trim();
}
