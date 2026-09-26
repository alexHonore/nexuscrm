"use client";

import { useSyncExternalStore } from "react";

/**
 * Ouvrir la palette ⌘K depuis N'IMPORTE OÙ — le bouton du tableau de bord, un
 * lien d'aide — sans remonter son état.
 *
 * La palette est montée une seule fois, dans la barre de la coquille, et son
 * `open` est un état interne. Même patron que le bus `nexus:data` de
 * `src/lib/live.ts` : un `CustomEvent` sur `window`, que la palette écoute.
 */
export const OPEN_SEARCH_EVENT = "nexus:open-search";

export type OpenSearchDetail = {
  /** Requête à préremplir (sinon la palette s'ouvre vide). */
  query?: string;
  /** Élément qui reprend le focus à la fermeture (sinon : comportement par défaut). */
  opener?: HTMLElement | null;
};

export function openWorkspaceSearch(detail: OpenSearchDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenSearchDetail>(OPEN_SEARCH_EVENT, { detail }));
}

// ── Ancre de commentaire sur la fiche DÉJÀ ouverte ───────────────────────────
// Un résultat trouvé dans un commentaire mène à `/clients/<id>#comment-<id>`.
// Quand cette fiche est déjà à l'écran (le panneau reste à côté d'elle), Next
// ne fait qu'un `pushState` — qui n'émet pas `hashchange` — et le fil de
// commentaires, déjà monté, ne saurait pas qu'il doit entourer le commentaire
// visé. L'appelant le lui dit par cet événement ; une autre fiche, elle,
// s'ouvre et lit son ancre au montage.

export const COMMENT_ANCHOR_EVENT = "nexus:comment-anchor";
export const COMMENT_ANCHOR_PREFIX = "comment-";

export type CommentAnchorDetail = { id: string };

export function signalCommentAnchor(href: string): void {
  if (typeof window === "undefined") return;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return;
  const hash = url.hash.slice(1);
  if (!hash.startsWith(COMMENT_ANCHOR_PREFIX)) return;
  const id = hash.slice(COMMENT_ANCHOR_PREFIX.length);
  if (!id) return;
  window.dispatchEvent(new CustomEvent<CommentAnchorDetail>(COMMENT_ANCHOR_EVENT, { detail: { id } }));
}

// ── Clavier iOS ───────────────────────────────────────────────────────────────
// Safari n'ouvre le clavier virtuel que pour un `focus()` fait PENDANT le geste
// de l'utilisateur. Or la palette s'ouvre après un rendu : le vrai champ
// n'existe pas encore au moment du toucher, et un focus posé plus tard laisse
// le clavier fermé — on touche « Rechercher », rien ne se passe au clavier, il
// faut toucher une seconde fois dans le champ.
//
// Le contournement connu : focaliser SYNCHRONEMENT, dans le gestionnaire du
// toucher, un champ invisible de 16 px (sous 16 px, iOS zoome la page). Le
// clavier s'ouvre sur lui ; quand la palette pose ensuite son `initialFocus`
// sur le vrai champ, le clavier reste ouvert et passe simplement au suivant.
// Le leurre disparaît dès qu'il perd le focus, et au plus tard après 1,5 s si
// la palette ne s'est pas ouverte.

const PRIME_ID = "nexus-search-keyboard-prime";

export function primeKeyboard(): void {
  if (typeof document === "undefined") return;
  document.getElementById(PRIME_ID)?.remove();
  const input = document.createElement("input");
  input.id = PRIME_ID;
  input.type = "text";
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.setAttribute("autocomplete", "off");
  input.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;padding:0;border:0;pointer-events:none;";
  const cleanup = () => {
    window.clearTimeout(timer);
    input.removeEventListener("blur", cleanup);
    input.remove();
  };
  const timer = window.setTimeout(() => {
    if (document.activeElement === input) input.blur();
    cleanup();
  }, 1500);
  input.addEventListener("blur", cleanup);
  document.body.appendChild(input);
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
}

// ── Raccourci affiché : ⌘ K sur Apple, Ctrl K ailleurs ───────────────────────
// La plateforme n'existe qu'au navigateur : rendu au serveur, on n'affiche
// rien (`null`), puis la bonne touche une fois monté — jamais un écart
// d'hydratation.

export type ShortcutPlatform = "mac" | "other";

const noSubscribe = () => () => {};

function detectPlatform(): ShortcutPlatform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "mac" : "other";
}

export function useShortcutPlatform(): ShortcutPlatform | null {
  return useSyncExternalStore(noSubscribe, detectPlatform, () => null);
}

/** Vrai quand la touche vise un champ de saisie — `/` doit alors s'écrire, pas ouvrir la palette. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
