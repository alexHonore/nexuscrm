"use client";

import { BookmarkPlusIcon, Trash2Icon } from "lucide-react";
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
  categoryId: number | "none" | null;
  sourceId: string;
  assignedToId: string;
  status: string;
  language: string;
  sortKey: ClientSortKey;
  sortDir: ClientSortDir;
  view: "list" | "table";
};

export type SavedView = SavedViewState & { id: string; name: string };

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
      <p className="text-xs font-medium text-muted-foreground">{t("savedViews.title")}</p>
      {views.length > 0 ? (
        <ul className="space-y-1">
          {views.map((v) => (
            <li key={v.id} className="flex items-center gap-1">
              <Button
                variant="outline"
                className="min-h-11 min-w-0 flex-1 justify-start md:min-h-8"
                aria-label={t("savedViews.apply", { name: v.name })}
                onClick={() => onApply(v)}
              >
                <span className="truncate">{v.name}</span>
              </Button>
              <Button
                variant="ghost"
                className="size-11 shrink-0 text-destructive md:size-8"
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
