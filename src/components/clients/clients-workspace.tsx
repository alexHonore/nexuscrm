"use client";

import {
  ClockAlertIcon,
  Loader2Icon,
  PhoneOffIcon,
  Rows3Icon,
  SearchIcon,
  SlidersHorizontalIcon,
  Table2Icon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
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
import { Button } from "@/components/ui/button";
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

const ALL = "all";

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

/** Signature d'affichage d'une ligne — évite les rendus inutiles au sondage. */
function rowsSignature(rows: ClientListItem[]): string {
  return rows
    .map(
      (r) =>
        `${r.id}:${r.fullName}:${r.phone}:${r.city ?? ""}:${r.categoryColor ?? ""}:${r.nextFollowupAt ?? ""}:${r.doNotCall ? 1 : 0}:${r.updatedAt}:${r.assignedToId ?? ""}:${r.sourceId ?? ""}`,
    )
    .join("|");
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
  totalClients,
  children,
}: {
  isAdmin: boolean;
  categories: PanelCategory[];
  sources: FilterOption[];
  users: FilterOption[];
  totalClients: number;
  children: React.ReactNode;
}) {
  const t = useTranslations("clients");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const isDetail = pathname !== "/clients";
  const activeId = isDetail ? (pathname.split("/")[2] ?? null) : null;

  // ── Vue (fiches / tableau) ─────────────────────────────────────────────────
  const view = useSyncExternalStore(subscribeStoredView, readStoredView, () => "list");

  const [sortKey, setSortKey] = useState<ClientSortKey>("activity");
  const [sortDir, setSortDir] = useState<ClientSortDir>("desc");

  const changeView = (next: ClientsView) => {
    writeStoredView(next);
    // Le tableau ne s'affiche que sur /clients — on quitte la fiche ouverte.
    if (next === "table" && isDetail) router.push("/clients");
    // Retour aux fiches : on retrouve l'ordre « activité récente » du panneau.
    if (next === "list") {
      setSortKey("activity");
      setSortDir("desc");
    }
  };

  const onSort = (key: Exclude<ClientSortKey, "activity">) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  // ── Filters ────────────────────────────────────────────────────────────────
  // Seeded from ?q= so the dashboard quick search keeps working.
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [appliedQ, setAppliedQ] = useState(() => (searchParams.get("q") ?? "").trim());
  const [categoryId, setCategoryId] = useState<number | null>(() => {
    // Semée depuis l'URL (liens « +N autres » du tableau pipeline).
    const raw = searchParams.get("categoryId");
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  });
  const [sourceId, setSourceId] = useState(ALL);
  const [assignedToId, setAssignedToId] = useState(ALL);
  const [status, setStatus] = useState(ALL);

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
    if (categoryId !== null) p.set("categoryId", String(categoryId));
    if (sourceId !== ALL) p.set("sourceId", sourceId);
    if (assignedToId !== ALL) p.set("assignedToId", assignedToId);
    if (status !== ALL) p.set("filter", status);
    if (sortKey !== "activity") {
      p.set("sort", sortKey);
      p.set("dir", sortDir);
    }
    return p.toString();
  }, [appliedQ, categoryId, sourceId, assignedToId, status, sortKey, sortDir]);

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
      const merged = [...data.items, ...tail];

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
  const categoryOptions: FilterOption[] = categories.map((c) => ({
    value: String(c.id),
    label: c.label,
  }));
  const withAll = (options: FilterOption[]): FilterOption[] => [
    { value: ALL, label: t("list.filters.all") },
    ...options,
  ];
  const statusOptions: FilterOption[] = [
    { value: ALL, label: t("list.filters.all") },
    { value: "overdue", label: t("list.filters.late") },
    { value: "today", label: t("list.filters.today") },
  ];
  const activeFilterCount = [sourceId, assignedToId, status].filter((v) => v !== ALL).length;

  const selectField = (
    label: string,
    options: FilterOption[],
    value: string,
    onChange: (v: string) => void,
  ) => (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <Select items={options} value={value} onValueChange={(v) => onChange(v ?? ALL)}>
        <SelectTrigger className="min-h-11 w-full md:min-h-9" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const chipBase =
    "inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors md:h-7";
  const now = Date.now();

  /** Vue tableau : pleine largeur, uniquement sur /clients (jamais sur une fiche). */
  const showTable = view === "table" && !isDetail;

  const failedBlock = (
    <div className="space-y-2 p-6 text-center">
      <p className="text-sm text-muted-foreground">{t("panel.loadError")}</p>
      <Button
        variant="outline"
        className="min-h-11 md:min-h-9"
        onClick={() => setRefreshKey((k) => k + 1)}
      >
        {t("panel.retry")}
      </Button>
    </div>
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
                <PopoverContent align="end" className="w-64 gap-3 p-3">
                  {selectField(t("list.filters.source"), withAll(sources), sourceId, setSourceId)}
                  {selectField(
                    t("list.filters.assignedTo"),
                    withAll(users),
                    assignedToId,
                    setAssignedToId,
                  )}
                  {selectField(t("list.filters.status"), statusOptions, status, setStatus)}
                  {activeFilterCount > 0 ? (
                    <Button
                      variant="ghost"
                      className="min-h-11 w-full md:min-h-8"
                      onClick={() => {
                        setSourceId(ALL);
                        setAssignedToId(ALL);
                        setStatus(ALL);
                      }}
                    >
                      <XIcon />
                      {t("list.filters.clear")}
                    </Button>
                  ) : null}
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

            {/* Category chips — single-select, colored per categories.color */}
            <div
              role="group"
              aria-label={t("list.filters.category")}
              className="-mx-3 mt-2 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <button
                type="button"
                aria-pressed={categoryId === null}
                onClick={() => setCategoryId(null)}
                className={cn(
                  chipBase,
                  categoryId === null
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {t("list.filters.all")}
                <span className="tabular-nums opacity-70">{totalClients}</span>
              </button>
              {categories.map((c) => {
                const active = categoryId === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCategoryId(active ? null : c.id)}
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
            </div>

            <p className="mt-1.5 text-[11px] text-muted-foreground" aria-live="polite">
              {loading ? t("panel.loading") : t("list.count", { count: total })}
            </p>
          </div>

          {showTable ? (
            <div className="min-w-0">
              {failed && !loading ? (
                failedBlock
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
                />
              )}
              {loadMoreBlock}
            </div>
          ) : (
          <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
            {loading ? (
              <div className="space-y-1.5 p-3">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-[52px] w-full rounded-lg" />
                ))}
              </div>
            ) : failed ? (
              failedBlock
            ) : items.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">{t("list.empty")}</p>
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
                          "flex min-h-[52px] items-center gap-2.5 border-l-2 px-3 py-1.5 transition-colors",
                          active
                            ? "border-l-primary bg-accent text-accent-foreground"
                            : "border-l-transparent hover:bg-muted/60 active:bg-muted",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-2.5 shrink-0 rounded-full",
                            !item.categoryColor && "bg-muted-foreground/25",
                          )}
                          style={
                            item.categoryColor
                              ? { backgroundColor: item.categoryColor }
                              : undefined
                          }
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">{item.fullName}</span>
                            {overdue ? (
                              <ClockAlertIcon
                                className="size-3.5 shrink-0 text-destructive"
                                aria-label={t("list.filters.late")}
                              />
                            ) : null}
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
