"use client";

import { useEffect, useRef } from "react";

/**
 * « Live » sans WebSocket ni Realtime.
 *
 * La base n'est jointe que par du code serveur (RLS fermée) : le navigateur ne
 * s'abonne à rien. On combine donc deux mécanismes très bon marché :
 *
 * 1. `emitDataChange()` — un bus pub/sub local (window CustomEvent) : dès qu'une
 *    mutation réussit dans CET onglet, tous les écrans montés se rafraîchissent
 *    immédiatement (panneau clients, tableau pipeline, pastille notifications).
 * 2. `useVisiblePolling()` — un sondage court, actif SEULEMENT quand l'onglet est
 *    visible ET fenêtre au premier plan, pour voir les changements des AUTRES
 *    utilisateurs (ou des leads entrants par webhook). En arrière-plan le
 *    sondage est coupé : zéro invocation Vercel gaspillée.
 */

export type LiveScope =
  | "clients"
  | "followups"
  | "notifications"
  | "calls"
  | "appointments"
  /** Fil SMS : un entrant peut arriver d'un webhook, sans action dans cet onglet. */
  | "sms";

type LiveDetail = { scope: LiveScope };

const EVENT_NAME = "nexus:data";

/** Signale que `scope` vient de changer (à appeler APRÈS le succès d'une mutation). */
export function emitDataChange(scope: LiveScope): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<LiveDetail>(EVENT_NAME, { detail: { scope } }));
}

/**
 * Exécute `handler` quand l'un des `scopes` change dans cet onglet.
 * `scopes` peut être un littéral en ligne : seule sa valeur compte, pas son identité.
 */
export function useDataChange(scopes: readonly LiveScope[], handler: () => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  // Clé stable : évite de réabonner à chaque rendu pour un tableau recréé.
  const key = scopes.join("|");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const wanted = new Set(key.split("|"));
    const onData = (event: Event) => {
      const detail = (event as CustomEvent<LiveDetail>).detail;
      if (!detail || !wanted.has(detail.scope)) return;
      handlerRef.current();
    };
    window.addEventListener(EVENT_NAME, onData);
    return () => window.removeEventListener(EVENT_NAME, onData);
  }, [key]);
}

/**
 * Appelle `handler` toutes les `intervalMs` ms, uniquement quand l'onglet est
 * visible et au premier plan. Le sondage est suspendu dès que l'onglet passe en
 * arrière-plan et redémarre — avec un appel immédiat — au retour.
 * Aucun appel au montage (les données viennent d'être rendues).
 */
export function useVisiblePolling(intervalMs: number, handler: () => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (typeof window === "undefined" || intervalMs <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    // On suit les évènements focus/blur plutôt que `document.hasFocus()` :
    // sur mobile, hasFocus() renvoie false dans plusieurs cas légitimes
    // (clavier virtuel, barre d'adresse) alors que l'utilisateur travaille.
    let blurred = false;
    const isActive = () => document.visibilityState === "visible" && !blurred;

    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const start = (immediate: boolean) => {
      if (timer !== null) return;
      if (immediate) handlerRef.current();
      timer = setInterval(() => {
        if (isActive()) handlerRef.current();
        else stop();
      }, intervalMs);
    };

    // Au montage : on démarre le minuteur sans déclencher d'appel immédiat.
    if (isActive()) start(false);

    // Retour au premier plan : un appel immédiat, puis reprise du minuteur.
    const resume = () => {
      blurred = false;
      if (isActive()) start(true);
      else stop();
    };
    // Onglet caché / fenêtre en arrière-plan : plus aucune invocation.
    const onBlur = () => {
      blurred = true;
      stop();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") resume();
      else stop();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", resume);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pageshow", resume);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", resume);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pageshow", resume);
    };
  }, [intervalMs]);
}
