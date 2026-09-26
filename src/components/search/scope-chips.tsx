"use client";

import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { lookTint, SEARCH_GROUP_LOOK } from "@/components/look";
import type { MatchGroup, SearchMeta } from "@/lib/clients-search/types";
import { cn } from "@/lib/utils";

type Facets = NonNullable<SearchMeta["facets"]>;

const SCOPES: readonly (MatchGroup | null)[] = [null, "contact", "profile", "notes"];

/**
 * Les puces de portée — « Tout / Nom et coordonnées / Lieu et projet / Notes
 * et commentaires » — avec le nombre de fiches que chacune trouverait.
 *
 * Choisir une puce ne change pas un état caché : l'appelant RÉÉCRIT la requête
 * (`applyScopeToken` → `dans:notes`), et c'est elle qui part au serveur. Une
 * recherche rouverte depuis l'historique ou partagée dit donc exactement ce
 * qu'elle cherche.
 *
 * Un groupe de boutons radio : une seule portée à la fois, ← → pour passer de
 * l'une à l'autre (tabulation itinérante). ↑ ↓ et Entrée ne sont PAS pris ici —
 * dans la palette, ils continuent de parcourir et d'ouvrir les résultats.
 *
 * Une puce à zéro est désactivée (sauf si c'est la portée choisie : on doit
 * toujours pouvoir la voir, et en sortir par « Tout »).
 */
export function ScopeChips({
  facets,
  scope,
  onPick,
  label,
  labelledBy,
  className,
}: {
  /** Comptes par portée ; `null` tant qu'aucune réponse ne les a donnés (puces sans nombre). */
  facets: Facets | null;
  scope: MatchGroup | null;
  /**
   * `viaMouse` : la puce a été cliquée à la souris — l'appelant peut rendre le
   * focus à son champ. Au toucher ou au clavier, le focus reste où il est.
   */
  onPick: (scope: MatchGroup | null, viaMouse: boolean) => void;
  /** Nom accessible du groupe, quand aucun libellé visible ne le porte. */
  label?: string;
  /** Identifiant d'un libellé visible (« Trouvé dans : »). */
  labelledBy?: string;
  className?: string;
}) {
  const t = useTranslations("common.search");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Le type du dernier appui (`mouse`, `touch`, `pen`) — un `click` ne le dit pas partout. */
  const lastPointer = useRef<string | null>(null);

  const countOf = (s: MatchGroup | null): number | null =>
    facets ? (s === null ? facets.all : facets[s]) : null;
  const enabled = (s: MatchGroup | null) => s === scope || s === null || countOf(s) !== 0;

  const move = (from: number, step: 1 | -1) => {
    for (let i = 1; i <= SCOPES.length; i++) {
      const at = (from + step * i + SCOPES.length) % SCOPES.length;
      if (enabled(SCOPES[at])) {
        refs.current[at]?.focus();
        if (SCOPES[at] !== scope) onPick(SCOPES[at], false);
        return;
      }
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : (label ?? t("scope.label"))}
      aria-labelledby={labelledBy}
      className={cn(
        "-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {SCOPES.map((s, i) => {
        const checked = s === scope;
        const count = countOf(s);
        const name = t(s === null ? "scope.all" : `scope.${s}`);
        const look = s ? SEARCH_GROUP_LOOK[s] : null;
        return (
          <button
            key={s ?? "all"}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!enabled(s)}
            tabIndex={checked ? 0 : -1}
            onPointerDown={(e) => {
              lastPointer.current = e.pointerType;
            }}
            onClick={(e) => {
              const viaMouse = e.detail > 0 && lastPointer.current === "mouse";
              lastPointer.current = null;
              if (!checked) onPick(s, viaMouse);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                e.stopPropagation();
                move(i, e.key === "ArrowRight" ? 1 : -1);
              }
            }}
            className={cn(
              "inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors md:h-7",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
              !checked && "border-border text-muted-foreground hover:bg-muted",
              checked && !look && "border-primary/40 bg-primary/10 text-primary",
            )}
            style={checked && look ? lookTint(look) : undefined}
          >
            {look ? <look.Icon aria-hidden className="size-3.5 shrink-0" /> : null}
            <span>{count === null ? name : t("scope.count", { label: name, count })}</span>
            {checked ? <CheckIcon aria-hidden className="size-3 shrink-0" /> : null}
          </button>
        );
      })}
    </div>
  );
}
