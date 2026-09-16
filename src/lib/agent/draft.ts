/**
 * Choix du texte qui PART au client, à partir de ce que le modèle a écrit.
 *
 * Pourquoi ce fichier existe — le 2026-08-25, une cliente a reçu un SMS dont
 * le corps était « { } ». Le modèle avait écrit ses arguments d'outil dans le
 * canal TEXTE avant sa vraie réponse :
 *
 *     { }
 *
 *     {"reason":"Projet de vente non actif; …"}
 *
 *     Je comprends, Jessica. Comme vous ne prévoyez pas vendre pour l'instant…
 *
 * La règle « un seul message par tour = le PREMIER paragraphe » a pris « { } »
 * au mot, l'a envoyé, et a jeté le vrai message. Le premier paragraphe est un
 * choix de POSITION ; ce qu'il faut, c'est un choix de NATURE : le premier
 * paragraphe qui est un MESSAGE. Un texte destiné à un humain contient des
 * lettres et ne commence pas par une accolade.
 *
 * Le contrôle ne peut pas vivre dans les garde-fous : ceux-ci sont des rangées
 * que l'administrateur peut éteindre une à une (§11.2.1), et un fil éteint
 * renverrait le CRM à l'état qui a produit « { } ». Il vit donc ici, avec la
 * garde « brouillon vide » — non négociable, comme elle.
 *
 * Module PUR (aucun réseau, aucune base, aucun next-intl) : la production
 * (`runtime.ts`) et le bac à sable (`sandbox.ts`) appellent la MÊME fonction,
 * pour que l'aperçu de l'administrateur montre toujours le texte qui partirait.
 */
import { isHumanReadable } from "@/lib/model-output";

/**
 * Ce paragraphe peut-il être un MESSAGE adressé à une personne ?
 *
 * La règle elle-même vit dans `@/lib/model-output` : c'est la MÊME porte que
 * celle des notes sur les fiches. Deux définitions du « bruit de machine »
 * finiraient par diverger, et c'est un chemin sans porte qui a livré « { } ».
 */
export function isMessageLike(paragraph: string): boolean {
  return isHumanReadable(paragraph);
}

export interface OutboundDraft {
  /** Le texte à envoyer — "" quand RIEN dans la réponse n'est un message. */
  draft: string;
  /** Les paragraphes-machine écartés AVANT le message (pour l'audit). */
  skipped: string[];
  /** Les paragraphes laissés APRÈS le message : un seul texto par tour. */
  dropped: number;
}

/**
 * Un seul message par tour : le premier paragraphe qui est un message part,
 * ce qui le précède est écarté comme du bruit de machine, ce qui le suit est
 * laissé (l'assistant reprendra au tour suivant s'il le faut).
 *
 * `draft` vide = le modèle n'a écrit aucun message : l'appelant escalade
 * (« l'assistant n'a rien écrit »), il n'envoie SURTOUT pas le bruit faute de
 * mieux — c'est exactement ce qui est arrivé à Jessica Dumont.
 */
export function pickOutboundDraft(text: string): OutboundDraft {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const index = paragraphs.findIndex(isMessageLike);
  if (index === -1) {
    return { draft: "", skipped: paragraphs, dropped: 0 };
  }
  return {
    draft: paragraphs[index],
    skipped: paragraphs.slice(0, index),
    dropped: paragraphs.length - index - 1,
  };
}
