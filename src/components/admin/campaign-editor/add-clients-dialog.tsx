"use client";

import { Loader2, Plus, Search, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPhone } from "@/lib/phone";
import { ApiError, api } from "../api";

type Found = { id: string; fullName: string; phone: string };
type EnrollResult = { clientId: string; enrolled: boolean; refusal?: string };

export type ClientSearchFilters = {
  q: string;
  cats: number[];
  srcs: number[];
  assignees: string[];
  never: boolean;
};

const EMPTY: ClientSearchFilters = { q: "", cats: [], srcs: [], assignees: [], never: false };

export function hasAnyFilter(f: ClientSearchFilters): boolean {
  return (
    f.q.trim() !== "" || f.cats.length > 0 || f.srcs.length > 0 || f.assignees.length > 0 || f.never
  );
}

/** La requête `/api/clients/list` correspondante — les mêmes filtres que la liste. */
export function buildClientSearchQuery(f: ClientSearchFilters): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.cats.length) p.set("categoryId", f.cats.join(","));
  if (f.srcs.length) p.set("sourceId", f.srcs.join(","));
  if (f.assignees.length) p.set("assignedToId", f.assignees.join(","));
  if (f.never) p.set("filter", "never");
  p.set("pageSize", "25");
  return p.toString();
}

/**
 * Ajouter des fiches à une campagne — une par une ou en lot.
 *
 * On cherche dans TOUTES les fiches (pas seulement l'audience du filtre), par
 * NOM mais aussi par catégorie (le statut du pipeline), source, personne
 * assignée, ou « jamais contacté » — exactement les filtres de la liste des
 * clients. L'éligibilité (numéro joignable, désabonnement, déjà inscrite)
 * reste vérifiée fiche par fiche côté serveur.
 */
export function AddClientsDialog({
  campaignId,
  categories,
  sources,
  users,
  onAdded,
}: {
  campaignId: string;
  categories: { id: number; name: string }[];
  sources: { id: number; name: string }[];
  users: { id: string; name: string }[];
  onAdded: () => void;
}) {
  const t = useTranslations("campaigns");
  const [open, setOpen] = useState(false);
  const [filters, setClientSearchFilters] = useState<ClientSearchFilters>(EMPTY);
  const [results, setResults] = useState<Found[]>([]);
  const [selected, setSelected] = useState<Record<string, Found>>({});
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const cancelSearch = () => {
    if (debounce.current) clearTimeout(debounce.current);
    if (inFlight.current) inFlight.current.abort();
  };

  const reset = () => {
    cancelSearch();
    setClientSearchFilters(EMPTY);
    setResults([]);
    setSelected({});
    setSearching(false);
  };

  /**
   * Applique un nouvel état de filtres et relance la recherche. Piloté par les
   * gestes (pas d'effet) : la saisie est débouncée, un clic de filtre est
   * immédiat. `next` est passé explicitement — pas de lecture d'état périmé.
   */
  const apply = (next: ClientSearchFilters, debounced: boolean) => {
    setClientSearchFilters(next);
    cancelSearch();
    if (!hasAnyFilter(next)) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const go = () => {
      const controller = new AbortController();
      inFlight.current = controller;
      api<{ items: Found[] }>(`/api/clients/list?${buildClientSearchQuery(next)}`, { signal: controller.signal })
        .then((data) => setResults(data.items))
        .catch(() => {
          if (!controller.signal.aborted) setResults([]);
        })
        .finally(() => {
          if (inFlight.current === controller) {
            inFlight.current = null;
            setSearching(false);
          }
        });
    };
    if (debounced) debounce.current = setTimeout(go, 250);
    else go();
  };

  const toggle = (client: Found, on: boolean) =>
    setSelected((s) => {
      const next = { ...s };
      if (on) next[client.id] = client;
      else delete next[client.id];
      return next;
    });

  const chosen = Object.values(selected);

  const add = async () => {
    if (chosen.length === 0) return;
    setAdding(true);
    try {
      const res = await api<{ added: number; skipped: number; results: EnrollResult[] }>(
        `/api/campaigns/${campaignId}/enrollments`,
        { method: "POST", body: JSON.stringify({ clientIds: chosen.map((c) => c.id) }) },
      );
      toast.success(t("editor.enrollments.toast.added", { added: res.added, skipped: res.skipped }));
      setOpen(false);
      reset();
      onAdded();
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.code === "not_found"
          ? t("editor.errors.save")
          : t("editor.enrollments.toast.failed"),
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" className="min-h-11 md:min-h-9">
            <UserPlus /> {t("editor.enrollments.addTrigger")}
          </Button>
        }
      />
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("editor.enrollments.addTitle")}</DialogTitle>
          <DialogDescription>{t("editor.enrollments.addHint")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={filters.q}
              onChange={(e) => apply({ ...filters, q: e.target.value }, true)}
              placeholder={t("editor.enrollments.addSearchPlaceholder")}
              className="min-h-11 pl-9 md:min-h-9"
            />
          </div>

          {/* Filtres — les mêmes dimensions que la liste des clients. */}
          <ChipFilter
            label={t("editor.enrollments.filterCategory")}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
            selected={filters.cats}
            onToggle={(id, on) =>
              apply(
                { ...filters, cats: on ? [...filters.cats, id] : filters.cats.filter((x) => x !== id) },
                false,
              )
            }
          />
          <ChipFilter
            label={t("editor.enrollments.filterSource")}
            options={sources.map((s) => ({ value: s.id, label: s.name }))}
            selected={filters.srcs}
            onToggle={(id, on) =>
              apply(
                { ...filters, srcs: on ? [...filters.srcs, id] : filters.srcs.filter((x) => x !== id) },
                false,
              )
            }
          />
          <ChipFilter
            label={t("editor.enrollments.filterAssignee")}
            options={users.map((u) => ({ value: u.id, label: u.name }))}
            selected={filters.assignees}
            onToggle={(id, on) =>
              apply(
                {
                  ...filters,
                  assignees: on
                    ? [...filters.assignees, id]
                    : filters.assignees.filter((x) => x !== id),
                },
                false,
              )
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={filters.never ? "default" : "outline"}
              className="min-h-11 md:min-h-8"
              aria-pressed={filters.never}
              onClick={() => apply({ ...filters, never: !filters.never }, false)}
            >
              {t("editor.enrollments.filterNever")}
            </Button>
          </div>

          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-1">
            {searching ? (
              <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t("editor.enrollments.searching")}
              </p>
            ) : !hasAnyFilter(filters) ? (
              <p className="p-2 text-sm text-muted-foreground">{t("editor.enrollments.addEmpty")}</p>
            ) : results.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">{t("editor.enrollments.addNone")}</p>
            ) : (
              results.map((c) => (
                <label
                  key={c.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted"
                >
                  <Checkbox
                    checked={Boolean(selected[c.id])}
                    onCheckedChange={(on) => toggle(c, Boolean(on))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.fullName}</span>
                    <span className="block text-xs text-muted-foreground">{formatPhone(c.phone)}</span>
                  </span>
                </label>
              ))
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
              reset();
            }}
            disabled={adding}
          >
            {t("cancel")}
          </Button>
          <Button onClick={() => void add()} disabled={adding || chosen.length === 0}>
            {adding ? <Loader2 className="animate-spin" /> : <Plus />}
            {t("editor.enrollments.addButton", { count: chosen.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Une rangée de puces à bascule pour un filtre multi-valeurs. */
function ChipFilter<T extends string | number>({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: T[];
  onToggle: (value: T, on: boolean) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <Button
              key={String(o.value)}
              type="button"
              size="sm"
              variant={on ? "default" : "outline"}
              className="min-h-9 md:min-h-7"
              aria-pressed={on}
              onClick={() => onToggle(o.value, !on)}
            >
              {o.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
