"use client";

import { BookmarkIcon, BookmarkPlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ClientSortDir, ClientSortKey } from "@/components/clients/clients-table";

/**
 * Vues enregistrées du panneau /clients : une combinaison nommée de recherche,
 * filtres, tri et type d'affichage (fiches / tableau). Persistées par
 * navigateur (localStorage) — le schéma de la base est gelé, et une préférence
 * d'écran par appareil suffit ici.
 */
export type SavedViewState = {
  q: string;
  categoryIds: Array<number | "none">;
  sourceIds: string[];
  assignedToIds: string[];
  statuses: string[];
  languages: string[];
  sortKey: ClientSortKey;
  sortDir: ClientSortDir;
  view: "list" | "table";
};

export type SavedView = SavedViewState & { id: string; name: string };

// ── Normalisation à l'application ────────────────────────────────────────────
// Le localStorage peut contenir n'importe quoi : des vues du premier format
// (une seule valeur par filtre : categoryId, sourceId, status…) ou des données
// corrompues. On convertit tout vers les listes multi-sélection sans rien
// casser pour l'utilisateur.

/** Ancien format (valeur unique par filtre) — accepté à la lecture seulement. */
type LegacyFields = {
  categoryId?: unknown;
  sourceId?: unknown;
  assignedToId?: unknown;
  status?: unknown;
  language?: unknown;
};

const LEGACY_ALL = "all";

function stringList(list: unknown, legacy: unknown): string[] {
  if (Array.isArray(list)) {
    return list.filter((v): v is string => typeof v === "string" && v !== LEGACY_ALL);
  }
  if (typeof legacy === "string" && legacy !== LEGACY_ALL) return [legacy];
  return [];
}

/** Vue telle que stockée → état applicable, quel que soit son âge. */
export function normalizeSavedView(view: SavedView): SavedViewState {
  const raw = view as SavedView & LegacyFields;
  const legacyCategory: Array<number | "none"> =
    typeof raw.categoryId === "number" ? [raw.categoryId] : raw.categoryId === "none" ? ["none"] : [];
  const categoryIds = Array.isArray(raw.categoryIds)
    ? raw.categoryIds.filter((v): v is number | "none" => typeof v === "number" || v === "none")
    : legacyCategory;
  return {
    q: typeof raw.q === "string" ? raw.q : "",
    categoryIds,
    sourceIds: stringList(raw.sourceIds, raw.sourceId),
    assignedToIds: stringList(raw.assignedToIds, raw.assignedToId),
    statuses: stringList(raw.statuses, raw.status),
    languages: stringList(raw.languages, raw.language).filter((l) => l === "fr" || l === "en"),
    sortKey: raw.sortKey,
    sortDir: raw.sortDir === "asc" ? "asc" : "desc",
    view: raw.view === "table" ? "table" : "list",
  };
}

const STORAGE_KEY = "nexus.clientsSavedViews";
const MAX_VIEWS = 20;

// ── Magasin externe (même patron que la préférence de vue du panneau) ────────
// useSyncExternalStore : pas de setState dans un effet, pas d'écart
// d'hydratation (le serveur voit une liste vide), et toutes les instances
// montées restent synchronisées.

const EMPTY_VIEWS: SavedView[] = [];
let viewsCache: SavedView[] | null = null;
const viewsListeners = new Set<() => void>();

function parseStored(): SavedView[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SavedView =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as SavedView).id === "string" &&
        typeof (v as SavedView).name === "string",
    );
  } catch {
    return [];
  }
}

function readViews(): SavedView[] {
  if (viewsCache === null) viewsCache = parseStored();
  return viewsCache;
}

function storeViews(views: SavedView[]): void {
  viewsCache = views;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Stockage indisponible (navigation privée) : la vue ne survivra pas.
  }
  for (const notify of viewsListeners) notify();
}

function subscribeViews(onChange: () => void): () => void {
  viewsListeners.add(onChange);
  return () => viewsListeners.delete(onChange);
}

export function SavedViews({
  current,
  onApply,
}: {
  current: SavedViewState;
  onApply: (view: SavedView) => void;
}) {
  const t = useTranslations("clients");
  const views = useSyncExternalStore(subscribeViews, readViews, () => EMPTY_VIEWS);
  const [name, setName] = useState("");

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const view: SavedView = { ...current, id: crypto.randomUUID(), name: trimmed };
    // Même nom → remplacement : « ma vue » reste unique.
    const next = [...views.filter((v) => v.name !== trimmed), view].slice(-MAX_VIEWS);
    storeViews(next);
    setName("");
    toast.success(t("savedViews.saved", { name: trimmed }));
  };

  const remove = (id: string) => {
    storeViews(views.filter((v) => v.id !== id));
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {t("savedViews.title")}
      </p>
      {views.length > 0 ? (
        <ul className="space-y-0.5">
          {views.map((v) => (
            <li
              key={v.id}
              className="group flex items-center rounded-md transition-colors hover:bg-muted"
            >
              <button
                type="button"
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
                aria-label={t("savedViews.apply", { name: v.name })}
                onClick={() => onApply(v)}
              >
                <BookmarkIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{v.name}</span>
              </button>
              <Button
                variant="ghost"
                className="size-11 shrink-0 text-destructive transition-opacity md:size-8 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                aria-label={t("savedViews.delete", { name: v.name })}
                onClick={() => remove(v.id)}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("savedViews.empty")}</p>
      )}
      <div className="flex items-center gap-1">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("savedViews.namePlaceholder")}
          aria-label={t("savedViews.namePlaceholder")}
          className="min-h-11 md:min-h-8"
          maxLength={40}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        />
        <Button
          variant="outline"
          className="size-11 shrink-0 md:size-8"
          aria-label={t("savedViews.save")}
          disabled={!name.trim()}
          onClick={save}
        >
          <BookmarkPlusIcon />
        </Button>
      </div>
    </div>
  );
}
