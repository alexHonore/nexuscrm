"use client";

import { format as formatDate, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { enUS, fr } from "date-fns/locale";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ClockAlertIcon,
  Loader2Icon,
  PhoneOffIcon,
  Rows3Icon,
  SearchIcon,
  SearchXIcon,
  SlidersHorizontalIcon,
  Table2Icon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AddClientDialog } from "@/components/clients/add-client-dialog";
import {
  ClientsTable,
  type ClientSortDir,
  type ClientSortKey,
} from "@/components/clients/clients-table";
import {
  ClientListNavContext,
  type ClientListItem,
  type ClientListNav,
} from "@/components/clients/client-list-nav";
import type { FilterOption } from "@/components/clients/clients-filters";
import {
  type DateFilterMode,
  normalizeSavedView,
  SavedViews,
  type SavedView,
  type SavedViewState,
} from "@/components/clients/saved-views";
import { APP_TZ } from "@/components/clients/timezone";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDataChange, useVisiblePolling } from "@/lib/live";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

export type PanelCategory = { id: number; label: string; color: string; count: number };

type ListResponse = {
  items: ClientListItem[];
  total: number;
  page: number;
  pageSize: number;
};

/** Cadence du rafraîchissement de fond (autres utilisateurs, leads webhook). */
const PANEL_POLL_MS = 20_000;

/** La vue choisie (fiches / tableau) survit aux sessions. */
const VIEW_STORAGE_KEY = "nexus.clientsView";

// ── Préférence de vue : petit magasin externe (localStorage) ─────────────────
// useSyncExternalStore évite à la fois l'écart d'hydratation (le serveur rend
// toujours « fiches ») et un setState dans un effet.

type ClientsView = "list" | "table";

const viewListeners = new Set<() => void>();
/** Relais mémoire : la bascule fonctionne même sans localStorage (navigation privée). */
let memoryView: ClientsView | null = null;

function readStoredView(): ClientsView {
  if (memoryView !== null) return memoryView;
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "table" ? "table" : "list";
  } catch {
    return "list";
  }
}

function writeStoredView(view: ClientsView): void {
  memoryView = view;
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Stockage indisponible : la préférence ne survivra pas à la session.
  }
  for (const notify of viewListeners) notify();
}

function subscribeStoredView(onChange: () => void): () => void {
  viewListeners.add(onChange);
  return () => viewListeners.delete(onChange);
}

// ── Filtres et tri persistants ───────────────────────────────────────────────
// Le panneau retrouve ses filtres au retour (rechargement, autre onglet) : on
// range l'instantané SavedViewState sous sa propre clé et on le restaure au
// montage — après l'hydratation, pour ne jamais diverger du rendu serveur.
// Un lien profond (?q=, ?categoryId=) garde la priorité sur l'état mémorisé.

const PANEL_STATE_KEY = "nexus.clientsPanelState";

function readStoredPanelState(): SavedViewState | null {
  try {
    const raw = window.localStorage.getItem(PANEL_STATE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    // Données d'un autre âge ou trafiquées : normalisées, jamais crues.
    return normalizeSavedView(parsed as SavedView);
  } catch {
    return null;
  }
}

function writeStoredPanelState(state: SavedViewState): void {
  try {
    window.localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
  } catch {
    // Stockage indisponible (navigation privée) : tant pis, rien ne casse.
  }
}

/** Signature d'affichage d'une ligne — évite les rendus inutiles au sondage. */
function rowsSignature(rows: ClientListItem[]): string {
  return rows
    .map(
      (r) =>
        `${r.id}:${r.fullName}:${r.phone}:${r.city ?? ""}:${r.categoryId ?? ""}:${r.categoryColor ?? ""}:${r.nextFollowupAt ?? ""}:${r.lastContactedAt ?? ""}:${r.doNotCall ? 1 : 0}:${r.updatedAt}:${r.assignedToId ?? ""}:${r.sourceId ?? ""}`,
    )
    .join("|");
}

/** Sens de tri initial par colonne — celui qu'on attend naturellement. */
const SORT_DEFAULT_DIR: Record<Exclude<ClientSortKey, "activity">, ClientSortDir> = {
  name: "asc",
  city: "asc",
  followupAt: "asc",
  lastContact: "desc",
  createdAt: "desc",
  updatedAt: "desc",
};

const SORT_KEYS: ClientSortKey[] = [
  "activity",
  "name",
  "city",
  "followupAt",
  "lastContact",
  "createdAt",
  "updatedAt",
];

/** Filtre de dates : un mode + les bornes que ce mode utilise. */
export type DateFilter = { mode: DateFilterMode; from: string; to: string };
export const NO_DATE_FILTER: DateFilter = { mode: "none", from: "", to: "" };

/** Le filtre restreint-il réellement la liste ? (mode choisi ET borne saisie) */
function hasDateFilter(f: DateFilter): boolean {
  switch (f.mode) {
    case "none":
      return false;
    case "before":
      return f.to !== "";
    case "after":
      return f.from !== "";
    case "custom":
      return f.from !== "" || f.to !== "";
    default:
      return true; // fenêtres nommées : toujours effectives
  }
}

/**
 * Persistent master-detail workspace for /clients.
 * Lives in the route layout, so the panel state (search, filters, loaded
 * pages, scroll) survives navigation between clients — speed is the goal.
 * Mobile: /clients shows only the panel; /clients/<id> shows only the detail.
 */
export function ClientsWorkspace({
  isAdmin,
  categories,
  sources,
  users,
  campaigns,
  totalClients,
  noCategoryCount,
  children,
}: {
  isAdmin: boolean;
  categories: PanelCategory[];
  sources: FilterOption[];
  users: FilterOption[];
  /** Campagnes SMS — pour filtrer « qui est dans telle campagne ». */
  campaigns: FilterOption[];
  totalClients: number;
  noCategoryCount: number;
  children: React.ReactNode;
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const isDetail = pathname !== "/clients";
  const activeId = isDetail ? (pathname.split("/")[2] ?? null) : null;

  // ── Vue (fiches / tableau) ─────────────────────────────────────────────────
  const view = useSyncExternalStore(
    subscribeStoredView,
    readStoredView,
    (): ClientsView => "list",
  );

  const [sortKey, setSortKey] = useState<ClientSortKey>("activity");
  const [sortDir, setSortDir] = useState<ClientSortDir>("desc");

  const changeView = (next: ClientsView) => {
    writeStoredView(next);
    // Le tableau ne s'affiche que sur /clients — on quitte la fiche ouverte.
    if (next === "table" && isDetail) router.push("/clients");
  };

  const onSort = (key: Exclude<ClientSortKey, "activity">) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(SORT_DEFAULT_DIR[key]);
    }
  };

  // ── Filters ────────────────────────────────────────────────────────────────
  // Multi-sélection partout : liste vide = « tous ». Semée depuis ?q= (recherche
  // rapide du tableau de bord) et ?categoryId= (liens « +N autres » du pipeline).
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [appliedQ, setAppliedQ] = useState(() => (searchParams.get("q") ?? "").trim());
  const [categoryIds, setCategoryIds] = useState<Array<number | "none">>(() => {
    const raw = searchParams.get("categoryId");
    if (!raw) return [];
    return raw.split(",").flatMap((token): Array<number | "none"> => {
      const trimmed = token.trim();
      if (trimmed === "none") return ["none"];
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isFinite(parsed) ? [parsed] : [];
    });
  });
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [assignedToIds, setAssignedToIds] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [campaignIds, setCampaignIds] = useState<string[]>([]);
  // Filtres de dates (mode + bornes yyyy-mm-dd) : création / modification.
  const [createdFilter, setCreatedFilter] = useState<DateFilter>(NO_DATE_FILTER);
  const [updatedFilter, setUpdatedFilter] = useState<DateFilter>(NO_DATE_FILTER);

  /** Ajoute/retire une valeur d'un filtre multi-sélection. */
  function toggleValue<T>(setter: React.Dispatch<React.SetStateAction<T[]>>, value: T): void {
    setter((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchChange = (value: string) => {
    setQ(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setAppliedQ(value.trim()), 300);
  };
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  /** Applique un état de filtres/tri complet (vues enregistrées, restauration). */
  const applyFilterState = (v: SavedViewState) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQ(v.q);
    setAppliedQ(v.q.trim());
    setCategoryIds(v.categoryIds);
    setSourceIds(v.sourceIds);
    setCampaignIds(v.campaignIds);
    setAssignedToIds(v.assignedToIds);
    setStatuses(v.statuses);
    setLanguages(v.languages);
    setCreatedFilter({ mode: v.createdMode, from: v.createdFrom, to: v.createdTo });
    setUpdatedFilter({ mode: v.updatedMode, from: v.updatedFrom, to: v.updatedTo });
    setSortKey(SORT_KEYS.includes(v.sortKey) ? v.sortKey : "activity");
    setSortDir(v.sortDir);
  };

  // Restauration au montage — une seule fois, après l'hydratation. Un lien
  // profond (?q= du tableau de bord, ?categoryId= du pipeline) gagne : ces
  // adresses promettent un résultat précis, pas les filtres d'hier.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    if (searchParams.get("q") || searchParams.get("categoryId")) return;
    const stored = readStoredPanelState();
    if (stored) applyFilterState(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- montage seulement
  }, []);

  // ── List state ─────────────────────────────────────────────────────────────
  const [items, setItems] = useState<ClientListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const filterQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (appliedQ) p.set("q", appliedQ);
    if (categoryIds.length > 0) p.set("categoryId", categoryIds.join(","));
    if (sourceIds.length > 0) p.set("sourceId", sourceIds.join(","));
    if (assignedToIds.length > 0) p.set("assignedToId", assignedToIds.join(","));
    if (statuses.length > 0) p.set("filter", statuses.join(","));
    if (languages.length > 0) p.set("language", languages.join(","));
    if (campaignIds.length > 0) p.set("campaignId", campaignIds.join(","));
    // Fenêtres nommées résolues par le serveur à chaque requête ; bornes
    // avant/après strictes ; plage personnalisée inclusive.
    for (const [prefix, f] of [
      ["created", createdFilter],
      ["updated", updatedFilter],
    ] as const) {
      switch (f.mode) {
        case "today":
        case "yesterday":
        case "week":
        case "month":
          p.set(`${prefix}Within`, f.mode);
          break;
        case "before":
          if (f.to) p.set(`${prefix}Before`, f.to);
          break;
        case "after":
          if (f.from) p.set(`${prefix}After`, f.from);
          break;
        case "custom":
          if (f.from) p.set(`${prefix}From`, f.from);
          if (f.to) p.set(`${prefix}To`, f.to);
          break;
      }
    }
    if (sortKey !== "activity") {
      p.set("sort", sortKey);
      p.set("dir", sortDir);
    }
    return p.toString();
  }, [
    appliedQ,
    categoryIds,
    sourceIds,
    assignedToIds,
    statuses,
    languages,
    campaignIds,
    createdFilter,
    updatedFilter,
    sortKey,
    sortDir,
  ]);

  // Mémorisation continue : chaque changement de filtres ou de tri est rangé —
  // jamais avant la restauration, sinon le montage écraserait l'état d'hier
  // avec les valeurs par défaut.
  // Le premier passage de cet effet est TOUJOURS avalé : au montage il voit
  // encore l'état du premier rendu (défauts, ou graines d'un lien profond) —
  // l'écrire aurait écrasé les filtres mémorisés avec des valeurs que
  // l'utilisateur n'a pas choisies. Seul un vrai changement persiste.
  const persistArmedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!persistArmedRef.current) {
      persistArmedRef.current = true;
      return;
    }
    writeStoredPanelState({
      q: appliedQ,
      categoryIds,
      sourceIds,
      assignedToIds,
      statuses,
      languages,
      campaignIds,
      createdMode: createdFilter.mode,
      createdFrom: createdFilter.from,
      createdTo: createdFilter.to,
      updatedMode: updatedFilter.mode,
      updatedFrom: updatedFilter.from,
      updatedTo: updatedFilter.to,
      sortKey,
      sortDir,
      view,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filterQuery couvre tous les filtres
  }, [filterQuery, sortKey, sortDir, view]);

  // Latest-value refs so loadMore stays stable for the context consumers.
  const itemsRef = useRef<ClientListItem[]>([]);
  const pageRef = useRef(1);
  const hasMoreRef = useRef(false);
  const queryRef = useRef(filterQuery);
  const loadingMoreRef = useRef(false);
  /** Chargement initial / changement de filtres en cours. */
  const loadingRef = useRef(true);
  /** Rafraîchissement de fond en cours (page 1, sans écran de chargement). */
  const refreshingRef = useRef(false);
  /** Un rafraîchissement a été demandé pendant qu'un autre était en vol. */
  const rerunRef = useRef(false);
  /** Incrémenté à chaque mutation locale — invalide les réponses parties avant. */
  const versionRef = useRef(0);
  queryRef.current = filterQuery;

  const listUrl = (query: string, page: number) =>
    `/api/clients/list?${query ? `${query}&` : ""}page=${page}`;

  const applyPage = useCallback((data: ListResponse, mode: "replace" | "append") => {
    const merged =
      mode === "replace"
        ? data.items
        : [
            ...itemsRef.current,
            ...data.items.filter(
              (item) => !itemsRef.current.some((prev) => prev.id === item.id),
            ),
          ];
    itemsRef.current = merged;
    pageRef.current = data.page;
    hasMoreRef.current = data.page * data.pageSize < data.total;
    setItems(merged);
    setTotal(data.total);
    setHasMore(hasMoreRef.current);
  }, []);

  // Page 1 (re)load whenever the filters change.
  useEffect(() => {
    const controller = new AbortController();
    loadingRef.current = true;
    setLoading(true);
    setFailed(false);
    fetch(listUrl(filterQuery, 1), { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ListResponse>;
      })
      .then((data) => {
        applyPage(data, "replace");
        loadingRef.current = false;
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        loadingRef.current = false;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      controller.abort();
      loadingRef.current = false;
    };
  }, [filterQuery, refreshKey, applyPage]);

  /**
   * Rafraîchissement « vivant » : recharge la page 1 avec les filtres courants
   * et la fusionne dans les pages déjà chargées — sans squelette, sans perdre
   * le défilement, la recherche, la pagination ni la fiche sélectionnée.
   * Les lignes au-delà de la page 1 sont conservées (dédupliquées), donc les
   * nouveautés apparaissent en tête sans casser le « charger plus ».
   */
  const refreshFirstPage = useCallback(async function run(): Promise<void> {
    // On ne concurrence ni le chargement initial ni un « charger plus ».
    if (loadingRef.current || loadingMoreRef.current) return;
    // Déjà en cours : on note qu'il faudra recommencer (le résultat en vol
    // peut précéder la mutation qui vient d'arriver).
    if (refreshingRef.current) {
      rerunRef.current = true;
      return;
    }
    refreshingRef.current = true;
    const startedQuery = queryRef.current;
    const startedVersion = versionRef.current;
    try {
      const res = await fetch(listUrl(startedQuery, 1));
      if (!res.ok) return;
      const data = (await res.json()) as ListResponse;
      // Filtres changés, rechargement complet lancé, ou mutation survenue
      // pendant la requête → réponse périmée, on la jette.
      if (
        queryRef.current !== startedQuery ||
        loadingRef.current ||
        versionRef.current !== startedVersion
      ) {
        return;
      }

      const fresh = new Set(data.items.map((item) => item.id));
      // Les pages ≥ 2 déjà chargées restent en place, sans doublon avec la page 1.
      const tail = itemsRef.current
        .slice(data.pageSize)
        .filter((item) => !fresh.has(item.id));
      // Les pages ≥ 2 sont conservées telles quelles : on ne sait pas lesquelles
      // ont disparu. Le total, lui, fait foi — sans ce plafond, une suppression
      // en masse laissait les fiches effacées affichées (« 0 client » au-dessus
      // d'une liste encore pleine) jusqu'au rechargement complet.
      const merged = [...data.items, ...tail].slice(0, Math.max(data.items.length, data.total));

      setFailed(false);
      setTotal(data.total);
      hasMoreRef.current = merged.length < data.total;
      setHasMore(hasMoreRef.current);
      if (rowsSignature(merged) === rowsSignature(itemsRef.current)) return;
      itemsRef.current = merged;
      setItems(merged);
    } catch {
      // Réseau indisponible : on retentera au prochain sondage.
    } finally {
      refreshingRef.current = false;
      if (rerunRef.current) {
        rerunRef.current = false;
        await run();
      }
    }
  }, []);

  // Mutations faites dans cet onglet (création, catégorie, suivis, suppression…).
  useDataChange(["clients", "followups"], () => {
    versionRef.current += 1;
    void refreshFirstPage();
  });
  // Changements faits par les AUTRES utilisateurs ou par les webhooks entrants.
  useVisiblePolling(PANEL_POLL_MS, () => {
    void refreshFirstPage();
  });

  const loadMore = useCallback(async (): Promise<string[]> => {
    if (loadingMoreRef.current || !hasMoreRef.current) return [];
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const startedQuery = queryRef.current;
    try {
      const res = await fetch(listUrl(startedQuery, pageRef.current + 1));
      if (!res.ok) return [];
      const data = (await res.json()) as ListResponse;
      // Filters changed while the request was in flight → discard the page.
      if (queryRef.current !== startedQuery) return [];
      const known = new Set(itemsRef.current.map((item) => item.id));
      const fresh = data.items.filter((item) => !known.has(item.id));
      applyPage({ ...data, items: fresh }, "append");
      return fresh.map((item) => item.id);
    } catch {
      return [];
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [applyPage]);

  // Infinite scroll: auto-trigger the "load more" button as it nears the viewport.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  // ── Quick-switching context (consumed by <ClientSwitcher/>) ────────────────
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const indexOf = useCallback((id: string) => ids.indexOf(id), [ids]);
  const nav = useMemo<ClientListNav>(
    () => ({ ids, total, hasMore, loadingMore, indexOf, loadMore }),
    [ids, total, hasMore, loadingMore, indexOf, loadMore],
  );

  // ── Options ────────────────────────────────────────────────────────────────
  // Plus d'entrée « Tous » : en multi-sélection, ne rien cocher = tout voir.
  const categoryOptions: FilterOption[] = categories.map((c) => ({
    value: String(c.id),
    label: c.label,
  }));
  const sourceFilterOptions: FilterOption[] = [
    { value: "none", label: t("list.filters.noSource") },
    ...sources,
  ];
  const userFilterOptions: FilterOption[] = [
    { value: "none", label: t("list.unassigned") },
    ...users,
  ];
  const statusOptions: FilterOption[] = [
    { value: "overdue", label: t("list.filters.late") },
    { value: "today", label: t("list.filters.today") },
    { value: "upcoming", label: t("list.filters.upcoming") },
    { value: "none", label: t("list.filters.noFollowup") },
    { value: "never", label: t("list.filters.neverContacted") },
    { value: "dnc", label: t("list.doNotCall") },
  ];
  const languageOptions: FilterOption[] = [
    { value: "fr", label: t("languages.fr") },
    { value: "en", label: t("languages.en") },
  ];
  // « Aucune campagne » d'abord : c'est la question la plus souvent posée —
  // qui n'a encore jamais été travaillé par une campagne.
  const campaignFilterOptions: FilterOption[] = [
    { value: "none", label: t("list.filters.noCampaign") },
    ...campaigns,
  ];
  const sortOptions: FilterOption[] = SORT_KEYS.map((key) => ({
    value: key,
    label: t(`sort.${key}`),
  }));
  const activeFilterCount =
    sourceIds.length +
    assignedToIds.length +
    statuses.length +
    languages.length +
    campaignIds.length +
    (hasDateFilter(createdFilter) ? 1 : 0) +
    (hasDateFilter(updatedFilter) ? 1 : 0);
  const hasAnyCriteria = activeFilterCount > 0 || categoryIds.length > 0 || appliedQ !== "";

  const clearFilters = () => {
    setSourceIds([]);
    setAssignedToIds([]);
    setStatuses([]);
    setLanguages([]);
    setCampaignIds([]);
    setCreatedFilter(NO_DATE_FILTER);
    setUpdatedFilter(NO_DATE_FILTER);
  };
  const clearEverything = () => {
    // Une frappe récente peut avoir un setAppliedQ en attente : on l'annule,
    // sinon il réappliquerait la recherche qu'on vient d'effacer.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    clearFilters();
    setCategoryIds([]);
    setQ("");
    setAppliedQ("");
  };

  // ── Vues enregistrées : instantané courant + application ──────────────────
  const currentViewState: SavedViewState = {
    q: appliedQ,
    categoryIds,
    sourceIds,
    assignedToIds,
    statuses,
    languages,
    campaignIds,
    createdMode: createdFilter.mode,
    createdFrom: createdFilter.from,
    createdTo: createdFilter.to,
    updatedMode: updatedFilter.mode,
    updatedFrom: updatedFilter.from,
    updatedTo: updatedFilter.to,
    sortKey,
    sortDir,
    view,
  };
  const applySavedView = (saved: SavedView) => {
    // Données venues du localStorage (ancien ou nouveau format) : normalisées.
    const v = normalizeSavedView(saved);
    applyFilterState(v);
    changeView(v.view);
  };

  /** Groupe de filtres multi-sélection : pastilles à bascule dans le popover. */
  const filterChipGroup = (
    label: string,
    options: FilterOption[],
    values: string[],
    onToggle: (v: string) => void,
  ) => (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {options.map((o) => {
          const active = values.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(o.value)}
              className={cn(
                "inline-flex h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors md:h-7",
                active
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {o.color ? (
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: o.color }}
                />
              ) : null}
              {o.label}
              {active ? <CheckIcon aria-hidden className="size-3" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );

  const now = Date.now();

  /** « 1 août » (année courante) ou « 1 août 2025 » — la valeur yyyy-mm-dd
   *  est affichée telle quelle, sans conversion de fuseau. */
  const chipDate = (ymd: string) => {
    const d = parseISO(ymd);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return formatDate(d, sameYear ? "d MMM" : "d MMM yyyy", { locale: dfnsLocale });
  };

  /** Libellé de rappel d'un filtre de dates : « Créée aujourd'hui »,
   *  « Modifiée avant le 1 août », « Créée du 1 août au 8 août »… */
  const dateChipLabel = (
    labelKey: "createdShort" | "updatedShort",
    filter: DateFilter,
  ): string => {
    const label = t(`list.filters.${labelKey}`);
    switch (filter.mode) {
      case "today":
        return t("list.filters.chipToday", { label });
      case "yesterday":
        return t("list.filters.chipYesterday", { label });
      case "week":
        return t("list.filters.chipThisWeek", { label });
      case "month":
        return t("list.filters.chipThisMonth", { label });
      case "before":
        return t("list.filters.chipBefore", { label, date: chipDate(filter.to) });
      case "after":
        return t("list.filters.chipAfter", { label, date: chipDate(filter.from) });
      default: {
        if (filter.from && filter.to) {
          return t("list.filters.fromTo", {
            label,
            from: chipDate(filter.from),
            to: chipDate(filter.to),
          });
        }
        if (filter.from) return t("list.filters.fromOnly", { label, from: chipDate(filter.from) });
        return t("list.filters.toOnly", { label, to: chipDate(filter.to) });
      }
    }
  };

  /** Choix de période proposés pour la création et la modification. */
  const dateModeOptions: Array<{ value: DateFilterMode; label: string }> = [
    { value: "none", label: t("list.filters.dateAny") },
    { value: "today", label: t("list.filters.dateToday") },
    { value: "yesterday", label: t("list.filters.dateYesterday") },
    { value: "week", label: t("list.filters.dateThisWeek") },
    { value: "month", label: t("list.filters.dateThisMonth") },
    { value: "before", label: t("list.filters.dateBefore") },
    { value: "after", label: t("list.filters.dateAfter") },
    { value: "custom", label: t("list.filters.dateCustom") },
  ];

  /** Groupe « filtre de dates » du popover : mode + bornes selon le mode. */
  const dateFilterGroup = (
    label: string,
    filter: DateFilter,
    setFilter: React.Dispatch<React.SetStateAction<DateFilter>>,
  ) => (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <Select
        items={dateModeOptions}
        value={filter.mode}
        onValueChange={(v) =>
          setFilter((f) => ({ ...f, mode: (v ?? "none") as DateFilterMode }))
        }
      >
        <SelectTrigger className="min-h-11 w-full md:min-h-8" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {dateModeOptions.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filter.mode === "before" ? (
        <Input
          type="date"
          value={filter.to}
          onChange={(e) => setFilter((f) => ({ ...f, to: e.target.value }))}
          aria-label={`${label} — ${t("list.filters.dateBefore")}`}
          className="min-h-11 w-full text-xs md:min-h-8"
        />
      ) : filter.mode === "after" ? (
        <Input
          type="date"
          value={filter.from}
          onChange={(e) => setFilter((f) => ({ ...f, from: e.target.value }))}
          aria-label={`${label} — ${t("list.filters.dateAfter")}`}
          className="min-h-11 w-full text-xs md:min-h-8"
        />
      ) : filter.mode === "custom" ? (
        <div className="flex items-center gap-1.5" role="group" aria-label={label}>
          <Input
            type="date"
            value={filter.from}
            max={filter.to || undefined}
            onChange={(e) => setFilter((f) => ({ ...f, from: e.target.value }))}
            aria-label={`${label} — ${t("list.filters.dateFrom")}`}
            className="min-h-11 flex-1 text-xs md:min-h-8"
          />
          <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
            –
          </span>
          <Input
            type="date"
            value={filter.to}
            min={filter.from || undefined}
            onChange={(e) => setFilter((f) => ({ ...f, to: e.target.value }))}
            aria-label={`${label} — ${t("list.filters.dateTo")}`}
            className="min-h-11 flex-1 text-xs md:min-h-8"
          />
        </div>
      ) : null}
    </div>
  );

  /** Filtres actifs hors catégorie — affichés en rappel sous la recherche. */
  const activeFilterChips: Array<{
    key: string;
    label: string;
    color?: string;
    remove: () => void;
  }> = [
    ...sourceIds.map((v) => ({
      key: `source-${v}`,
      label: sourceFilterOptions.find((o) => o.value === v)?.label ?? v,
      color: sourceFilterOptions.find((o) => o.value === v)?.color,
      remove: () => toggleValue(setSourceIds, v),
    })),
    ...assignedToIds.map((v) => ({
      key: `user-${v}`,
      label: userFilterOptions.find((o) => o.value === v)?.label ?? v,
      remove: () => toggleValue(setAssignedToIds, v),
    })),
    ...statuses.map((v) => ({
      key: `status-${v}`,
      label: statusOptions.find((o) => o.value === v)?.label ?? v,
      remove: () => toggleValue(setStatuses, v),
    })),
    ...languages.map((v) => ({
      key: `lang-${v}`,
      label: languageOptions.find((o) => o.value === v)?.label ?? v,
      remove: () => toggleValue(setLanguages, v),
    })),
    ...(hasDateFilter(createdFilter)
      ? [
          {
            key: "created-range",
            label: dateChipLabel("createdShort", createdFilter),
            remove: () => setCreatedFilter(NO_DATE_FILTER),
          },
        ]
      : []),
    ...(hasDateFilter(updatedFilter)
      ? [
          {
            key: "updated-range",
            label: dateChipLabel("updatedShort", updatedFilter),
            remove: () => setUpdatedFilter(NO_DATE_FILTER),
          },
        ]
      : []),
  ];

  const chipBase =
    "inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors md:h-7";

  /** « AB » pour l'avatar de fiche — teinté de la couleur de catégorie. */
  const initials = (name: string) =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?";

  const shortDay = (iso: string) =>
    formatInTimeZone(new Date(iso), APP_TZ, "d MMM", { locale: dfnsLocale });

  /** Vue tableau : pleine largeur, uniquement sur /clients (jamais sur une fiche). */
  const showTable = view === "table" && !isDetail;

  const failedBlock = (
    <EmptyState
      icon={<WifiOffIcon />}
      title={t("panel.loadError")}
      action={
        <Button
          variant="outline"
          className="min-h-11 md:min-h-9"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          {t("panel.retry")}
        </Button>
      }
    />
  );

  const emptyBlock = (
    <EmptyState
      icon={<SearchXIcon />}
      title={t("list.emptyTitle")}
      hint={t("list.empty")}
      action={
        hasAnyCriteria ? (
          <Button variant="outline" className="min-h-11 md:min-h-9" onClick={clearEverything}>
            <XIcon />
            {t("list.filters.clear")}
          </Button>
        ) : undefined
      }
    />
  );

  const loadMoreBlock =
    hasMore && !loading && !failed ? (
      <div ref={sentinelRef} className="p-3">
        <Button
          variant="outline"
          className="min-h-11 w-full md:min-h-9"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? <Loader2Icon className="animate-spin" /> : null}
          {t("panel.loadMore")}
        </Button>
      </div>
    ) : null;

  return (
    <ClientListNavContext.Provider value={nav}>
      <div className={cn(!showTable && "md:flex")}>
        {/* ── Left panel (or full-width table container) ── */}
        <aside
          aria-label={t("list.title")}
          className={cn(
            "flex w-full flex-col",
            !showTable && "md:sticky md:top-0 md:h-dvh md:w-[340px] md:shrink-0 md:border-r",
            isDetail && "hidden md:flex",
          )}
        >
          {/* Sticky header — top-[52px] tucks it right under the 53px mobile app bar. */}
          <div className="sticky top-[52px] z-20 border-b bg-background/95 px-3 pb-2 pt-3 backdrop-blur md:static md:bg-background">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder={t("list.searchPlaceholder")}
                  aria-label={t("list.searchPlaceholder")}
                  className="min-h-11 pl-9 md:min-h-9"
                  inputMode="search"
                  enterKeyHint="search"
                />
              </div>

              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      variant="outline"
                      className="relative size-11 md:size-9"
                      aria-label={t("panel.filters")}
                    />
                  }
                >
                  <SlidersHorizontalIcon />
                  {activeFilterCount > 0 ? (
                    <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="max-h-[min(70vh,36rem)] w-80 gap-3.5 overflow-y-auto p-3.5"
                >
                  {/* Tri — accessible aussi en vue fiches, pas seulement via
                      les en-têtes du tableau. */}
                  <div className="space-y-1">
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      {t("sort.label")}
                    </p>
                    <div className="flex items-center gap-1.5">
                      <Select
                        items={sortOptions}
                        value={sortKey}
                        onValueChange={(v) => {
                          const key = (v ?? "activity") as ClientSortKey;
                          setSortKey(key);
                          setSortDir(key === "activity" ? "desc" : SORT_DEFAULT_DIR[key]);
                        }}
                      >
                        <SelectTrigger
                          className="min-h-11 w-full md:min-h-9"
                          aria-label={t("sort.label")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {sortOptions.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {sortKey !== "activity" ? (
                        <Button
                          variant="outline"
                          className="size-11 shrink-0 md:size-9"
                          aria-label={t(sortDir === "asc" ? "sort.asc" : "sort.desc")}
                          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                        >
                          {sortDir === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {filterChipGroup(
                    t("list.filters.status"),
                    statusOptions,
                    statuses,
                    (v) => toggleValue(setStatuses, v),
                  )}
                  {filterChipGroup(
                    t("list.filters.source"),
                    sourceFilterOptions,
                    sourceIds,
                    (v) => toggleValue(setSourceIds, v),
                  )}
                  {filterChipGroup(
                    t("list.filters.assignedTo"),
                    userFilterOptions,
                    assignedToIds,
                    (v) => toggleValue(setAssignedToIds, v),
                  )}
                  {filterChipGroup(
                    t("list.filters.language"),
                    languageOptions,
                    languages,
                    (v) => toggleValue(setLanguages, v),
                  )}
                  {campaignFilterOptions.length > 1
                    ? filterChipGroup(
                        t("list.filters.campaign"),
                        campaignFilterOptions,
                        campaignIds,
                        (v) => toggleValue(setCampaignIds, v),
                      )
                    : null}
                  {dateFilterGroup(t("list.filters.createdAt"), createdFilter, setCreatedFilter)}
                  {dateFilterGroup(t("list.filters.updatedAt"), updatedFilter, setUpdatedFilter)}
                  {activeFilterCount > 0 ? (
                    <Button
                      variant="ghost"
                      className="min-h-11 w-full md:min-h-8"
                      onClick={clearFilters}
                    >
                      <XIcon />
                      {t("list.filters.clear")}
                    </Button>
                  ) : null}

                  <div className="border-t pt-3">
                    <SavedViews current={currentViewState} onApply={applySavedView} />
                  </div>
                </PopoverContent>
              </Popover>

              <Button
                variant="outline"
                className="size-11 md:size-9"
                aria-label={view === "list" ? t("views.table") : t("views.cards")}
                onClick={() => changeView(view === "list" ? "table" : "list")}
              >
                {view === "list" ? <Table2Icon /> : <Rows3Icon />}
              </Button>

              {isAdmin ? (
                <AddClientDialog
                  compact
                  categories={categoryOptions}
                  sources={sources}
                  users={users}
                />
              ) : null}
            </div>

            {/* Category chips — multi-select, colored per categories.color */}
            <div
              role="group"
              aria-label={t("list.filters.category")}
              className="-mx-3 mt-2 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <button
                type="button"
                aria-pressed={categoryIds.length === 0}
                onClick={() => setCategoryIds([])}
                className={cn(
                  chipBase,
                  categoryIds.length === 0
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {t("list.filters.all")}
                <span className="tabular-nums opacity-70">{totalClients}</span>
              </button>
              {categories.map((c) => {
                const active = categoryIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleValue<number | "none">(setCategoryIds, c.id)}
                    className={cn(
                      chipBase,
                      !active && "border-border text-muted-foreground hover:bg-muted",
                    )}
                    style={
                      active
                        ? {
                            color: c.color,
                            backgroundColor: `${c.color}1a`,
                            borderColor: `${c.color}66`,
                          }
                        : undefined
                    }
                  >
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: c.color }}
                    />
                    {c.label}
                    <span className={cn("tabular-nums", !active && "opacity-70")}>{c.count}</span>
                  </button>
                );
              })}
              {noCategoryCount > 0 ? (
                <button
                  type="button"
                  aria-pressed={categoryIds.includes("none")}
                  onClick={() => toggleValue<number | "none">(setCategoryIds, "none")}
                  className={cn(
                    chipBase,
                    categoryIds.includes("none")
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                  {t("list.noCategory")}
                  <span className="tabular-nums opacity-70">{noCategoryCount}</span>
                </button>
              ) : null}
            </div>

            {/* Rappel des filtres actifs (hors catégorie) : retrait en un geste. */}
            {activeFilterChips.length > 0 ? (
              <div className="-mx-3 mt-1.5 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {activeFilterChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    aria-label={t("list.filters.remove", { label: chip.label })}
                    onClick={chip.remove}
                    className="inline-flex h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-secondary px-2.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/70 md:h-7"
                  >
                    {chip.color ? (
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: chip.color }}
                      />
                    ) : null}
                    {chip.label}
                    <XIcon aria-hidden className="size-3 opacity-60" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex h-11 shrink-0 items-center whitespace-nowrap rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted md:h-7"
                >
                  {t("list.filters.clear")}
                </button>
              </div>
            ) : null}

            <p className="mt-1.5 text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
              {loading ? t("panel.loading") : t("list.count", { count: total })}
            </p>
          </div>

          {showTable ? (
            <div className="min-w-0">
              {failed && !loading ? (
                failedBlock
              ) : !loading && items.length === 0 ? (
                emptyBlock
              ) : (
                <ClientsTable
                  items={items}
                  loading={loading}
                  isAdmin={isAdmin}
                  categories={categories}
                  sources={sources}
                  users={users}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  now={now}
                />
              )}
              {loadMoreBlock}
            </div>
          ) : (
          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
            {loading ? (
              <div className="space-y-1.5 p-3">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="flex items-center gap-2.5 px-1 py-1">
                    <Skeleton className="size-9 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-2/3 rounded" />
                      <Skeleton className="h-3 w-1/2 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : failed ? (
              failedBlock
            ) : items.length === 0 ? (
              emptyBlock
            ) : (
              <ul className="divide-y divide-border/60">
                {items.map((item) => {
                  const active = item.id === activeId;
                  const overdue =
                    item.nextFollowupAt !== null && Date.parse(item.nextFollowupAt) < now;
                  return (
                    <li key={item.id}>
                      <Link
                        href={`/clients/${item.id}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-h-[56px] items-center gap-2.5 border-l-2 px-3 py-2 transition-colors",
                          active
                            ? "border-l-primary bg-accent text-accent-foreground"
                            : "border-l-transparent hover:bg-muted/60 active:bg-muted",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                            !item.categoryColor &&
                              "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
                          )}
                          style={
                            item.categoryColor
                              ? {
                                  color: item.categoryColor,
                                  backgroundColor: `${item.categoryColor}1f`,
                                  boxShadow: `inset 0 0 0 1px ${item.categoryColor}33`,
                                }
                              : undefined
                          }
                        >
                          {initials(item.fullName)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">{item.fullName}</span>
                            {item.doNotCall ? (
                              <PhoneOffIcon
                                className="size-3.5 shrink-0 text-destructive"
                                aria-label={t("list.doNotCall")}
                              />
                            ) : null}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="tabular-nums">{formatPhone(item.phone)}</span>
                            {item.city ? <span className="truncate">{item.city}</span> : null}
                          </span>
                        </span>
                        {item.nextFollowupAt ? (
                          <span
                            className={cn(
                              "flex shrink-0 items-center gap-1 text-[11px] tabular-nums",
                              overdue ? "font-medium text-destructive" : "text-muted-foreground",
                            )}
                          >
                            {overdue ? (
                              <ClockAlertIcon
                                className="size-3.5"
                                aria-label={t("list.filters.late")}
                              />
                            ) : null}
                            {shortDay(item.nextFollowupAt)}
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            {loadMoreBlock}
          </div>
          )}
        </aside>

        {/* ── Right side: detail (or desktop empty state) — masqué en vue tableau ── */}
        {showTable ? null : (
          <div className={cn("min-w-0 flex-1", !isDetail && "hidden md:block")}>{children}</div>
        )}
      </div>
    </ClientListNavContext.Provider>
  );
}
