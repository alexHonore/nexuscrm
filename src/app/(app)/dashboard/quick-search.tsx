"use client";

import { SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { openWorkspaceSearch, primeKeyboard, useShortcutPlatform } from "@/components/search/open-search";

/**
 * La recherche du tableau de bord — un BOUTON qui ouvre la palette ⌘K.
 *
 * C'était un second champ, avec son propre formulaire vers `/clients?q=` : deux
 * recherches qui ne cherchaient pas la même chose et ne se souvenaient pas des
 * mêmes requêtes. Il n'en reste qu'une ; ce bouton en a l'allure (même hauteur
 * que l'ancien champ) et ouvre la palette, clavier compris sur iPhone
 * (`primeKeyboard` dans le geste même).
 *
 * Nom accessible : le libellé « Recherche rapide » PUIS le texte visible, pour
 * que la commande vocale (« toucher Rechercher un client… ») le trouve.
 */
export function QuickSearch() {
  const t = useTranslations("dashboard");
  const ts = useTranslations("common.search");
  const platform = useShortcutPlatform();

  return (
    <button
      type="button"
      aria-keyshortcuts="Meta+K Control+K /"
      onClick={(event) => {
        primeKeyboard();
        openWorkspaceSearch({ opener: event.currentTarget });
      }}
      className="flex h-11 w-full items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm text-muted-foreground shadow-xs transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <SearchIcon aria-hidden className="size-4 shrink-0" />
      <span className="sr-only">{t("search.label")}</span>
      <span className="min-w-0 flex-1 truncate">{t("search.placeholder")}</span>
      {platform ? (
        <kbd aria-hidden className="hidden shrink-0 rounded-md border bg-background px-1.5 py-0.5 font-sans text-[10px] md:block">
          {platform === "mac" ? ts("shortcutMac") : ts("shortcutOther")}
        </kbd>
      ) : null}
    </button>
  );
}
