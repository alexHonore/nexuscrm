"use client";

import { Command as CommandPrimitive } from "cmdk";
import {
  ArrowRight,
  EyeOff,
  History,
  LoaderCircle,
  PhoneOff,
  RotateCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Highlighted } from "@/components/search/highlighted";
import { SearchReason } from "@/components/search/match-line";
import {
  isTypingTarget,
  OPEN_SEARCH_EVENT,
  primeKeyboard,
  signalCommentAnchor,
  useShortcutPlatform,
  type OpenSearchDetail,
} from "@/components/search/open-search";
import {
  ALL_RECORDS,
  autoSelection,
  clientValue,
  isSelectableSuggestion,
  paletteEnterAction,
  pendingOpenTarget,
  RETRY,
  suggestionValue,
} from "@/components/search/palette-keys";
import { useRecentSearches } from "@/components/search/recent-searches";
import { ScopeChips } from "@/components/search/scope-chips";
import {
  resultHref,
  useClientSearch,
  type ClientSearchItem,
  type ClientSearchResult,
} from "@/components/search/use-client-search";
import { Command, CommandGroup, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { foldSearch } from "@/lib/clients-search/fold";
import { applyScopeToken, noResultSuggestions } from "@/lib/clients-search/palette";
import { parseSearchQuery, QUERY_MAX_LENGTH } from "@/lib/clients-search/query";
import type { MatchGroup } from "@/lib/clients-search/types";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

export type SearchDestination = {
  href: string;
  label: string;
  group: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
};

/** Une recherche démarre à 2 caractères ; en dessous, la palette propose l'historique et les pages. */
const MIN_TERM = 2;
/** Les touches qui déplacent la sélection : après elles, la ligne sélectionnée est un CHOIX. */
const NAV_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"];

/**
 * Un doigt plutôt qu'une souris — le critère est le POINTEUR, pas la largeur
 * de la fenêtre (même choix que `install-guide.tsx`). Sans requête média
 * exploitable : le comportement du bureau.
 */
function isCoarsePointer(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * Ctrl/⌘-K (ou « / ») — chercher une fiche ou ouvrir une page, de partout.
 *
 * Aucune donnée client n'est gardée : chaque frappe repasse par
 * `/api/clients/list`, qui applique la visibilité et les cases de la fiche
 * (coordonnées, historique) comme partout ailleurs. Le seul souvenir est
 * l'historique des REQUÊTES, dans ce navigateur, par personne
 * (`recent-searches.ts`).
 *
 * La coquille ne connaît que le déclencheur et les raccourcis globaux ; le
 * contenu (`PaletteBody`) naît à chaque ouverture et meurt à la fermeture —
 * aucune liste de la session précédente ne réapparaît grisée à la suivante.
 */
export function WorkspaceSearch({
  destinations,
  userId,
}: {
  destinations: SearchDestination[];
  /** Clé de l'historique des recherches — deux comptes sur un même poste ne se voient pas. */
  userId: string;
}) {
  const t = useTranslations("common.workspace");
  const ts = useTranslations("common.search");
  const platform = useShortcutPlatform();
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [seed, setSeed] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Qui reprend le focus à la fermeture — le bouton du tableau de bord, le champ quitté par « / »… */
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const show = useCallback((query = "", opener: HTMLElement | null = null) => {
    openerRef.current = opener;
    setSeed(query.slice(0, QUERY_MAX_LENGTH));
    setSession((n) => n + 1);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  // Raccourcis globaux. Une touche déjà traitée ailleurs (`defaultPrevented`),
  // tenue enfoncée (`repeat`) ou en pleine composition (accent mort, IME) ne
  // compte pas : ⌘K tenu ne fait pas clignoter la palette, et le « / » d'un
  // champ reste un « / ».
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (openRef.current) setOpen(false);
        else show("", active);
        return;
      }
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !openRef.current &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        show("", active);
      }
    }
    function onOpenRequest(event: Event) {
      const detail = (event as CustomEvent<OpenSearchDetail>).detail ?? {};
      show(typeof detail.query === "string" ? detail.query : "", detail.opener ?? null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpenRequest);
    };
  }, [show]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? show() : close())}>
      <DialogTrigger
        aria-label={t("search")}
        aria-keyshortcuts="Meta+K Control+K /"
        // Toucher « Rechercher » sur un iPhone doit ouvrir le clavier du même
        // geste : voir `primeKeyboard`.
        onClick={() => primeKeyboard()}
        className="flex h-11 min-w-11 items-center justify-center gap-2.5 rounded-xl border border-border/80 bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-72 md:justify-start lg:w-80"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="hidden flex-1 text-left md:block">{t("search")}</span>
        <span className="sr-only md:hidden">{t("search")}</span>
        {platform ? (
          <kbd aria-hidden className="hidden rounded-md border bg-background px-1.5 py-0.5 font-sans text-[10px] md:block">
            {platform === "mac" ? ts("shortcutMac") : ts("shortcutOther")}
          </kbd>
        ) : null}
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        initialFocus={inputRef}
        finalFocus={() => {
          const opener = openerRef.current;
          return opener && opener.isConnected ? opener : true;
        }}
        // Téléphone : plein écran. Une fenêtre à 12 % du haut laissait le bas
        // des résultats sous le clavier virtuel (iOS ne rétrécit pas `dvh`
        // pour lui) ; plein écran, la liste défile sous le champ, et l'encoche
        // est respectée. Dès `sm`, la palette flottante habituelle.
        className={cn(
          "flex translate-y-0 flex-col gap-0 overflow-hidden p-0",
          "max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none max-sm:pt-[env(safe-area-inset-top)] max-sm:pb-[env(safe-area-inset-bottom)] max-sm:ring-0",
          "sm:top-[12dvh] sm:max-h-[78dvh] sm:max-w-2xl",
        )}
      >
        <DialogTitle className="sr-only">{t("search")}</DialogTitle>
        <DialogDescription className="sr-only">{t("searchHelp")}</DialogDescription>
        {/* Monté avec la fenêtre, démonté avec elle (après le fondu) ; la clé
            garantit un état neuf même si l'on rouvre pendant le fondu. */}
        <PaletteBody
          key={session}
          initialQuery={seed}
          destinations={destinations}
          userId={userId}
          inputRef={inputRef}
          onClose={close}
        />
      </DialogContent>
    </Dialog>
  );
}

/** « AB » pour l'avatar — teinté de la couleur de catégorie, comme dans le panneau. */
function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/** Entrée sur un bouton de la ligne de saisie : c'est CE bouton, pas le résultat sélectionné. */
function keepFromCommand(event: React.KeyboardEvent) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

function PaletteBody({
  initialQuery,
  destinations,
  userId,
  inputRef,
  onClose,
}: {
  initialQuery: string;
  destinations: SearchDestination[];
  userId: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const t = useTranslations("common.workspace");
  const ts = useTranslations("common.search");
  const locale = useLocale();
  const router = useRouter();
  const { recent, remember, clear } = useRecentSearches(userId);

  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState("");
  /** ↑ ↓ utilisés depuis la dernière frappe : on ne leur reprend plus la sélection. */
  const userMovedRef = useRef(false);
  /**
   * Entrée tapé au clavier avant l'arrivée des résultats de CE terme : à
   * l'arrivée, seule l'unique fiche exacte s'ouvre (`pendingOpenTarget`) —
   * jamais une fiche que la personne n'a pas vue.
   */
  const pendingOpenRef = useRef<string | null>(null);

  const term = query.trim().slice(0, QUERY_MAX_LENGTH);
  const parsed = useMemo(() => parseSearchQuery(term), [term]);
  const searching = term.length >= MIN_TERM;
  // Seulement des exclusions (« -condo ») : aucune requête ne part — il n'y a
  // rien à trouver, seulement à retirer.
  const onlyExclusions = searching && parsed.onlyExclusions;
  const canFetch = searching && parsed.positive.length > 0;

  const navigate = (href: string) => {
    onClose();
    router.push(href);
  };
  const allHref = `/clients?q=${encodeURIComponent(term)}`;
  const openAll = () => {
    if (!term) return;
    remember(term);
    navigate(allHref);
  };
  const openClient = (item: ClientSearchItem) => {
    const href = resultHref(item);
    remember(term);
    navigate(href);
    signalCommentAnchor(href);
  };

  const onResult = (result: ClientSearchResult) => {
    if (result.query !== term) return;
    const waited = pendingOpenRef.current === result.query;
    pendingOpenRef.current = null;
    const only = waited ? pendingOpenTarget(result) : null;
    if (only) {
      openClient(only);
      return;
    }
    // À chaque réponse (un « Réessayer » en amène une seconde pour le même
    // terme), jamais après ↑ ↓ : cmdk garderait sinon la sélection sur
    // « Voir tous les résultats », monté avant les fiches, et Entrée ouvrirait
    // la liste au lieu du meilleur résultat.
    if (!userMovedRef.current) {
      const empty = !result.failed && result.total === 0;
      setSelected(autoSelection(result, empty ? noResultSuggestions(parsed) : []));
    }
  };

  const { current, shown, loading, retry } = useClientSearch(term, { enabled: canFetch, onResult });
  /**
   * « Réessayer » repart de zéro pour le terme : la sélection d'office reprend.
   * Sans cela, la réponse réussie laissait la sélection sur « Voir tous », où
   * cmdk s'était rabattu quand « Réessayer » a disparu — Entrée ouvrait la
   * liste au lieu du meilleur résultat.
   */
  const retryNow = () => {
    userMovedRef.current = false;
    retry();
  };
  const stale = canFetch && loading;
  const display = canFetch ? (current ?? shown) : null;
  const firstLoad = stale && !shown;
  const meta = display?.search ?? null;

  const changeQuery = (value: string) => {
    userMovedRef.current = false;
    pendingOpenRef.current = null;
    setQuery(value.slice(0, QUERY_MAX_LENGTH));
  };
  const pickScope = (scope: MatchGroup | null, pointer: boolean) => {
    changeQuery(applyScopeToken(query, scope, locale));
    // À la souris, on rend la main au champ ; au toucher, on ne rouvre pas le
    // clavier par-dessus les résultats qu'on voulait regarder.
    if (pointer) inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (NAV_KEYS.includes(event.key)) {
      // On choisit soi-même : un Entrée retenu plus tôt n'a plus cours.
      userMovedRef.current = true;
      pendingOpenRef.current = null;
      return;
    }
    if (event.key !== "Enter") return;
    if (event.shiftKey) {
      if (canFetch) {
        event.preventDefault();
        openAll();
      }
      return;
    }
    // La règle entière est dans `palette-keys.ts` : Entrée n'ouvre jamais une
    // fiche que la personne n'a pas vue.
    const action = paletteEnterAction({
      moved: userMovedRef.current,
      touch: isCoarsePointer(),
      awaiting: canFetch && loading,
    });
    if (action === "select") return;
    event.preventDefault();
    if (action === "dismiss") inputRef.current?.blur();
    else pendingOpenRef.current = term;
  };

  const needle = foldSearch(term);
  const matching = destinations.filter((item) => foldSearch(`${item.label} ${item.group}`).includes(needle));
  const groups = [...new Set(matching.map((item) => item.group))];
  const suggestions = current && !current.failed && current.total === 0 ? noResultSuggestions(parsed) : [];
  const notices = [
    meta?.approximate ? ts("approximate") : null,
    meta?.degraded ? ts(`degraded.${meta.degraded}`) : null,
    meta && meta.ignored.length > 0 ? ts("ignored", { terms: meta.ignored.join(" · ") }) : null,
  ].filter((n): n is string => n !== null);

  return (
    <Command
      shouldFilter={false}
      vimBindings={false}
      loop
      value={selected}
      onValueChange={setSelected}
      onKeyDown={onKeyDown}
      label={t("search")}
      className="h-auto min-h-0 flex-1 rounded-none! p-0"
    >
      <div className="flex shrink-0 items-center gap-1 border-b pr-1.5 pl-4 sm:pl-5">
        <Search aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <CommandPrimitive.Input
          ref={inputRef}
          aria-label={t("search")}
          placeholder={t("searchPlaceholder")}
          value={query}
          onValueChange={changeQuery}
          maxLength={QUERY_MAX_LENGTH}
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-14 min-w-0 flex-1 bg-transparent pl-2 text-base outline-none placeholder:text-muted-foreground sm:h-16"
        />
        {stale && shown ? <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        {query ? (
          <button
            type="button"
            aria-label={ts("clear")}
            onKeyDown={keepFromCommand}
            onClick={() => {
              changeQuery("");
              inputRef.current?.focus();
            }}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          onKeyDown={keepFromCommand}
          onClick={onClose}
          className="min-h-11 min-w-11 shrink-0 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("closeSearch")}
        </button>
      </div>

      {searching ? (
        <div className={cn("shrink-0 border-b px-3 pt-2 pb-1 sm:px-4", stale && "opacity-60")} aria-busy={stale || undefined}>
          <ScopeChips
            facets={meta?.facets ?? null}
            scope={parsed.scope}
            onPick={pickScope}
          />
        </div>
      ) : null}

      <CommandList className="max-h-none min-h-0 flex-1 overscroll-contain p-2">
        {searching ? (
          <CommandGroup heading={t("records")} aria-busy={stale || undefined}>
            <div role="status" aria-live="polite" className="px-2 text-sm text-muted-foreground">
              {onlyExclusions ? <p className="py-3">{ts("onlyExclusions")}</p> : null}
              {firstLoad ? <span className="sr-only">{t("searching")}</span> : null}
              {current && !current.failed ? <span className="sr-only">{ts("announce", { count: current.total })}</span> : null}
              {current?.failed ? <p className="py-3">{t("searchError")}</p> : null}
              {current && !current.failed && current.total === 0 ? (
                <p className="py-3 font-medium text-foreground">{ts("empty.title", { query: term })}</p>
              ) : null}
              {notices.map((notice) => (
                <p key={notice} className="py-1 text-xs">{notice}</p>
              ))}
            </div>

            {firstLoad ? (
              <div aria-hidden className="space-y-1 px-1 py-1">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="flex min-h-14 items-center gap-3 px-2">
                    <Skeleton className="size-9 shrink-0 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-1/2 rounded" />
                      <Skeleton className="h-3 w-1/3 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className={cn(stale && "opacity-60 transition-opacity")}>
              {display?.items.map((item) => (
                <ResultRow key={item.id} item={item} onOpen={() => openClient(item)} />
              ))}
            </div>

            {current?.failed ? (
              <CommandItem value={RETRY} onSelect={retryNow} className="min-h-11 cursor-pointer gap-3 px-3">
                <RotateCw aria-hidden className="size-4" />
                {ts("retry")}
                <CommandShortcut><ArrowRight aria-hidden className="size-4" /></CommandShortcut>
              </CommandItem>
            ) : null}

            {suggestions.map((suggestion, i) =>
              !isSelectableSuggestion(suggestion) ? (
                <p key={suggestion.kind} className="px-3 py-2 text-xs text-muted-foreground">
                  {ts(`empty.${suggestion.kind}`)}
                </p>
              ) : (
                <CommandItem
                  key={`${suggestion.kind}-${i}`}
                  value={suggestionValue(i)}
                  onSelect={() => changeQuery(suggestion.query)}
                  className="min-h-11 cursor-pointer gap-3 px-3"
                >
                  <Search aria-hidden className="size-4" />
                  <span className="truncate">
                    {suggestion.kind === "only"
                      ? ts("empty.only", { term: suggestion.term })
                      : ts(`empty.${suggestion.kind}`)}
                  </span>
                  <CommandShortcut><ArrowRight aria-hidden className="size-4" /></CommandShortcut>
                </CommandItem>
              ),
            )}

            {canFetch ? (
              <CommandItem value={ALL_RECORDS} onSelect={openAll} className="min-h-11 cursor-pointer gap-3 px-3 text-primary">
                <Search aria-hidden className="size-4" />
                {current && !current.failed ? t("allResults", { count: current.total }) : t("openDirectory")}
                <CommandShortcut><ArrowRight aria-hidden className="size-4" /></CommandShortcut>
              </CommandItem>
            ) : null}
          </CommandGroup>
        ) : (
          <>
            {query.trim() === "" && recent.length > 0 ? (
              <CommandGroup heading={ts("recent.title")}>
                {recent.map((entry, i) => (
                  <CommandItem
                    key={`${i}-${entry}`}
                    value={`recent-${i}`}
                    onSelect={() => changeQuery(entry)}
                    className="min-h-11 cursor-pointer gap-3 rounded-lg px-3"
                  >
                    <History aria-hidden className="size-4 text-muted-foreground" />
                    <span className="truncate">{entry}</span>
                    <CommandShortcut><ArrowRight aria-hidden className="size-3.5" /></CommandShortcut>
                  </CommandItem>
                ))}
                <CommandItem
                  value="recent-clear"
                  onSelect={clear}
                  className="min-h-11 cursor-pointer gap-3 rounded-lg px-3 text-muted-foreground"
                >
                  <Trash2 aria-hidden className="size-4" />
                  {ts("recent.clear")}
                  <CommandShortcut />
                </CommandItem>
              </CommandGroup>
            ) : null}
            <p className="px-3 pt-3 pb-1 text-xs text-muted-foreground">{t("searchHint")}</p>
            <p className="hidden px-3 pb-3 text-xs text-muted-foreground md:block">{ts("tips")}</p>
          </>
        )}
        {groups.map((group) => (
          <CommandGroup key={group} heading={group}>
            {matching.filter((item) => item.group === group).map(({ href, label, icon: Icon }) => (
              <CommandItem key={href} value={href} onSelect={() => navigate(href)} className="min-h-11 cursor-pointer gap-3 rounded-lg px-3">
                <Icon aria-hidden className="size-4 text-muted-foreground" />{label}
                <CommandShortcut><ArrowRight aria-hidden className="size-3.5" /></CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="hidden shrink-0 border-t bg-muted/30 px-5 py-3 text-[11px] text-muted-foreground md:block">
        {t("keyboardHint")}
      </div>
    </Command>
  );
}

/**
 * Une fiche trouvée : avatar teinté de sa catégorie, nom surligné, marque
 * « ne pas appeler », ville · numéro (ou « Masqué »), puis le pourquoi.
 */
function ResultRow({ item, onOpen }: { item: ClientSearchItem; onOpen: () => void }) {
  const ts = useTranslations("common.search");
  const match = item.match;
  const color = item.categoryColor;
  return (
    <CommandItem
      value={clientValue(item.id)}
      onSelect={onOpen}
      className="min-h-14 cursor-pointer items-start gap-3 rounded-lg px-3 py-2"
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
          !color && "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
        )}
        // Couleur de catégorie venue de la base : la seule teinte en ligne permise.
        style={color ? { color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}
      >
        {initials(item.fullName)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <Highlighted text={item.fullName} ranges={match?.nameRanges} className="truncate font-medium" />
          {item.doNotCall ? (
            <PhoneOff aria-label={ts("doNotCall")} className="size-3.5 shrink-0 text-destructive" />
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {item.city ? <Highlighted text={item.city} ranges={match?.cityRanges} className="truncate" /> : null}
          {item.city && (item.contactHidden || item.phone) ? <span aria-hidden>·</span> : null}
          {item.contactHidden ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <EyeOff aria-hidden className="size-3" />
              {ts("masked")}
            </span>
          ) : item.phone ? (
            <span className="shrink-0 tabular-nums">{formatPhone(item.phone)}</span>
          ) : null}
        </span>
        <SearchReason match={match} maxChips={2} snippetClassName="line-clamp-2 md:line-clamp-1" />
      </span>
      <CommandShortcut className="mt-2.5"><ArrowRight aria-hidden className="size-4" /></CommandShortcut>
    </CommandItem>
  );
}
