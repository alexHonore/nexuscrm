"use client";

import { useEffect, useRef, useState } from "react";
import type { ClientListItem } from "@/components/clients/client-list-nav";
import type { SearchMeta } from "@/lib/clients-search/types";

/** Une ligne de résultat : la forme de la liste, plus le POURQUOI (`match`). */
export type ClientSearchItem = ClientListItem & {
  /** Le numéro n'est pas ouvert sur cette fiche : l'API ne l'a pas envoyé. */
  contactHidden?: boolean;
};

/** La réponse de `GET /api/clients/list` quand `q` porte au moins un terme. */
export type ClientSearchResponse = {
  items: ClientSearchItem[];
  total: number;
  page: number;
  pageSize: number;
  search?: SearchMeta;
};

/**
 * Où mène une ligne : le lien du serveur (`/clients/<id>#comment-<id>` quand
 * l'extrait est un commentaire), sinon la fiche. Le lien est REVÉRIFIÉ : seule
 * une adresse de fiche passe à `router.push` — jamais un `javascript:` ni un
 * autre domaine, même si une réponse était abîmée.
 */
export function resultHref(item: Pick<ClientSearchItem, "id" | "match">): string {
  const fallback = `/clients/${encodeURIComponent(item.id)}`;
  const href = item.match?.href;
  if (typeof href !== "string") return fallback;
  return href === fallback || href.startsWith(`${fallback}#comment-`) ? href : fallback;
}

export type ClientSearchResult = {
  /** Le terme EXACT qui a produit ce résultat — la garde contre les réponses périmées. */
  query: string;
  items: ClientSearchItem[];
  total: number;
  search: SearchMeta | null;
  failed: boolean;
};

/** Même attente que la palette d'avant : assez pour ne pas chercher « t », « tr », « tre ». */
export const SEARCH_DEBOUNCE_MS = 220;
/** Huit lignes : ce qui tient dans la palette sans défiler, sur un téléphone comme au bureau. */
export const PALETTE_PAGE_SIZE = 8;

/**
 * La recherche de la palette ⌘K : même route, mêmes gardes que le panneau
 * `/clients` (`match=all`, `sort=relevance`), huit lignes.
 *
 * - Attente de 220 ms, requête annulée dès que le terme change, `no-store` :
 *   rien n'est mis en cache — un résultat dépend de ce que CE regard a le droit
 *   de voir, maintenant.
 * - Le résultat précédent reste affiché pendant qu'un nouveau terme charge
 *   (`shown`), marqué périmé (`stale`) : la liste ne clignote pas à chaque
 *   lettre.
 * - `current` n'est rempli que si `result.query === term` : une réponse lente
 *   pour « trem » ne s'affiche jamais sous « tremblay ».
 * - `onResult` est appelé au moment où la réponse arrive — c'est LÀ que la
 *   palette choisit la ligne sélectionnée et honore un Entrée tapé trop tôt,
 *   plutôt que dans un effet qui rejouerait à chaque rendu.
 */
export function useClientSearch(
  term: string,
  {
    enabled,
    onResult,
    pageSize = PALETTE_PAGE_SIZE,
  }: {
    enabled: boolean;
    onResult?: (result: ClientSearchResult) => void;
    pageSize?: number;
  },
): {
  current: ClientSearchResult | null;
  shown: ClientSearchResult | null;
  loading: boolean;
  retry: () => void;
} {
  const [result, setResult] = useState<ClientSearchResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const params = new URLSearchParams({
        q: term,
        match: "all",
        sort: "relevance",
        pageSize: String(pageSize),
      });
      let next: ClientSearchResult;
      try {
        const response = await fetch(`/api/clients/list?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as ClientSearchResponse;
        next = {
          query: term,
          items: Array.isArray(data.items) ? data.items : [],
          total: typeof data.total === "number" ? data.total : 0,
          search: data.search ?? null,
          failed: false,
        };
      } catch {
        if (controller.signal.aborted) return;
        next = { query: term, items: [], total: 0, search: null, failed: true };
      }
      if (controller.signal.aborted) return;
      setResult(next);
      onResultRef.current?.(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, term, pageSize, attempt]);

  const current = enabled && result?.query === term ? result : null;
  return {
    current,
    shown: enabled ? result : null,
    loading: enabled && !current,
    // Même terme, nouvelle tentative : l'effet se relance, la réponse ratée
    // reste à l'écran (grisée) jusqu'à la suivante.
    retry: () => {
      setResult((r) => (r && r.query === term ? { ...r, query: "" } : r));
      setAttempt((n) => n + 1);
    },
  };
}
