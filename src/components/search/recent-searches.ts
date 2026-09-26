"use client";

import { useCallback, useSyncExternalStore } from "react";
import { pushRecent, RECENT_MAX } from "@/lib/clients-search/palette";
import { QUERY_MAX_LENGTH } from "@/lib/clients-search/query";

/**
 * Les recherches récentes de la palette ⌘K — dans CE navigateur, par personne.
 *
 * Ce qu'on garde : des CHAÎNES DE REQUÊTE (« tremblay lévis », « dans:notes
 * piscine »), jamais un nom de fiche ni un identifiant. Un nom rangé ici
 * survivrait à un retrait de droit : la fiche redevenue invisible se
 * montrerait encore dans la liste, ce que la règle « une fiche qu'on ne voit
 * pas se comporte comme une fiche absente » interdit. Une requête, elle, est
 * rejouée contre le serveur, qui refiltre tout.
 *
 * La clé porte l'identifiant de la personne : deux comptes sur le même poste
 * (un cellulaire prêté, un ordinateur de bureau partagé) ne voient pas les
 * recherches l'un de l'autre.
 *
 * Écrite SEULEMENT quand une recherche aboutit (fiche ouverte, « tous les
 * résultats ») : les frappes intermédiaires (« tre », « trem ») n'y entrent
 * jamais.
 *
 * `localStorage` peut manquer (navigation privée, stockage bloqué) : chaque
 * accès est protégé et un relais mémoire prend la suite pour la session.
 */

const KEY_PREFIX = "nexus.search.recent.v1:";

const EMPTY: readonly string[] = Object.freeze([]);
const memory = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();
/** Dernière lecture par clé — `useSyncExternalStore` exige une référence stable. */
const cache = new Map<string, { raw: string | null; list: readonly string[] }>();

export function recentKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/** Données d'un autre âge ou trafiquées : seulement des chaînes, bornées. */
function sanitize(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return EMPTY;
  return value
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.slice(0, QUERY_MAX_LENGTH))
    .slice(0, RECENT_MAX);
}

function read(key: string): readonly string[] {
  // Relais mémoire rempli = la dernière écriture a échoué (quota, navigation
  // privée) : la mémoire fait foi pour la session. AVANT le stockage, qu'il
  // soit vide OU qu'il garde une liste plus ancienne — un quota atteint par
  // d'autres clés laisse la vieille liste en place, et la relire effaçait en
  // silence chaque recherche retenue depuis. `write` vide ce relais dès qu'une
  // écriture repasse.
  if (memory.has(key)) return memory.get(key) ?? EMPTY;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return EMPTY;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.list;
  let list: readonly string[] = EMPTY;
  try {
    list = raw ? sanitize(JSON.parse(raw)) : EMPTY;
  } catch {
    list = EMPTY;
  }
  cache.set(key, { raw, list });
  return list;
}

function write(key: string, list: readonly string[]): void {
  const clean = sanitize(list);
  let stored = false;
  try {
    if (clean.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(clean));
    stored = true;
  } catch {
    // Stockage indisponible : le relais mémoire suffit pour la session.
  }
  if (stored) memory.delete(key);
  else memory.set(key, clean);
  cache.delete(key);
  for (const notify of listeners) notify();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Un autre onglet a écrit : on relit (le cache compare la chaîne brute).
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(KEY_PREFIX)) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

const serverSnapshot = () => EMPTY;

/** Les recherches récentes de `userId`, les plus récentes d'abord. */
export function readRecentSearches(userId: string): readonly string[] {
  return read(recentKey(userId));
}

/** Range une recherche VALIDÉE en tête (sans doublon au pliage près, 8 au plus). */
export function rememberSearch(userId: string, query: string): void {
  const q = query.trim().slice(0, QUERY_MAX_LENGTH);
  if (!q) return;
  const key = recentKey(userId);
  write(key, pushRecent(read(key), q, RECENT_MAX));
}

/** « Effacer l'historique de recherche ». */
export function clearRecentSearches(userId: string): void {
  write(recentKey(userId), EMPTY);
}

/**
 * Les recherches récentes de `userId` et les deux gestes qui les modifient.
 * Vide au rendu serveur, puis relu une fois monté.
 */
export function useRecentSearches(userId: string): {
  recent: readonly string[];
  remember: (query: string) => void;
  clear: () => void;
} {
  const recent = useSyncExternalStore(
    subscribe,
    () => readRecentSearches(userId),
    serverSnapshot,
  );
  const remember = useCallback((query: string) => rememberSearch(userId, query), [userId]);
  const clear = useCallback(() => clearRecentSearches(userId), [userId]);
  return { recent, remember, clear };
}
