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
import { formatPhone } from "@/lib/phone";
import { ApiError, api } from "../api";

type Found = { id: string; fullName: string; phone: string };
type EnrollResult = { clientId: string; enrolled: boolean; refusal?: string };

/**
 * Ajouter des fiches à une campagne — une par une ou en lot.
 *
 * On cherche dans TOUTES les fiches (pas seulement l'audience du filtre) : le
 * geste sert justement à inscrire quelqu'un que les critères n'auraient pas
 * pris. L'éligibilité (numéro joignable, désabonnement, déjà inscrite) reste
 * vérifiée fiche par fiche côté serveur — la réponse dit qui est entré.
 */
export function AddClientsDialog({
  campaignId,
  onAdded,
}: {
  campaignId: string;
  onAdded: () => void;
}) {
  const t = useTranslations("campaigns");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Found[]>([]);
  const [selected, setSelected] = useState<Record<string, Found>>({});
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);

  // Recherche débouncée, pilotée par la frappe (pas d'effet) : on ne lance pas
  // une requête par touche, et on annule la précédente pour ne pas afficher une
  // réponse périmée arrivée après une plus récente.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const cancelSearch = () => {
    if (debounce.current) clearTimeout(debounce.current);
    if (inFlight.current) inFlight.current.abort();
  };

  const reset = () => {
    cancelSearch();
    setQ("");
    setResults([]);
    setSelected({});
    setSearching(false);
  };

  const search = (raw: string) => {
    setQ(raw);
    cancelSearch();
    const query = raw.trim();
    if (query === "") {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(() => {
      const controller = new AbortController();
      inFlight.current = controller;
      api<{ items: Found[] }>(`/api/clients/list?q=${encodeURIComponent(query)}&pageSize=20`, {
        signal: controller.signal,
      })
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
    }, 250);
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
              value={q}
              onChange={(e) => search(e.target.value)}
              placeholder={t("editor.enrollments.addSearchPlaceholder")}
              className="min-h-11 pl-9 md:min-h-9"
            />
          </div>

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {searching ? (
              <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t("editor.enrollments.searching")}
              </p>
            ) : q.trim() === "" ? (
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
