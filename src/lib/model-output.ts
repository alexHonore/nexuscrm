/**
 * La porte unique entre ce qu'un MODÈLE écrit et ce qu'un HUMAIN lit.
 *
 * Pourquoi elle existe. Deux fois en trois semaines, une sortie de modèle
 * illisible a été prise pour une sortie valide et poussée vers un client :
 *
 *  · le 2026-08-25, un SMS au corps « { } » a été LIVRÉ à une cliente — le
 *    modèle avait écrit les arguments de ses outils dans le canal texte, et le
 *    code a pris le premier paragraphe pour le message ;
 *  · le 2026-09-15, huit fiches ont reçu un commentaire commençant par
 *    `{ "transcript": "Allô…` — le modèle avait raté son JSON, et le lecteur
 *    se repliait sur « tout le texte est la note ».
 *
 * Les deux chemins étaient corrects chacun de son côté ; c'est la RÈGLE
 * commune qui manquait. Elle vit donc ici, en un seul exemplaire, et chaque
 * frontière d'écriture l'appelle : note d'appel, note d'assistant, rappel,
 * corps de texto. Une porte par chemin finirait par en laisser un sans porte —
 * c'est exactement ce qui s'est produit.
 *
 * Ce n'est PAS un garde-fou au sens du moteur SMS : les garde-fous sont des
 * rangées que l'administrateur peut éteindre une à une (§11.2.1), et ils
 * étaient d'ailleurs inertes en production jusqu'au 2026-08-27. Cette porte-ci
 * ne s'éteint pas.
 *
 * Module PUR : aucun réseau, aucune base, aucun next-intl — il est appelé
 * aussi bien depuis `src/lib/agent` que depuis les jobs et les transcriptions.
 */

/** Une balise ouvrante en tête : <thinking>, <tool_call>, <|channel|>… */
const MARKUP_HEAD = /^<[|/a-z!]/i;

/**
 * Ce texte est-il du bruit de machine plutôt qu'un texte écrit pour une
 * personne ?
 *
 * Volontairement ÉTROIT. On écarte ce qu'un humain n'écrit jamais — un objet
 * ou un tableau JSON, un bloc de code, une balise, un fragment sans une seule
 * lettre. Tout le reste passe. Une règle plus fine (« ça ressemble à une
 * phrase ») finirait par refuser un vrai message, et un vrai message refusé
 * coûte une escalade à l'équipe : le faux négatif est plus cher ici que le
 * faux positif, parce que la sortie franchement cassée, elle, est grossière.
 *
 * Note : un message peut parfaitement CONTENIR une accolade (« votre code
 * {G1V 2M3} est noté ») — seul le DÉBUT est jugé.
 */
export function looksLikeMachineOutput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  // Sans une seule lettre, il n'y a rien à lire : « { } », « --- », « 1. 2. ».
  if (!/\p{L}/u.test(trimmed)) return true;
  // Arguments d'outil, brouillon structuré, objet recraché dans le texte —
  // refermé ou non : un message ne commence pas par une accolade.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
  if (trimmed.startsWith("```")) return true;
  if (MARKUP_HEAD.test(trimmed)) return true;
  return false;
}

/** L'inverse, pour les appelants qui lisent mieux à l'endroit. */
export function isHumanReadable(text: string): boolean {
  return !looksLikeMachineOutput(text);
}
