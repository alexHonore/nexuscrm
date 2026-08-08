"use client";

import { ArrowDown, ArrowRightLeft, ArrowUp, Loader2, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api, ApiError } from "./api";
import { COLOR_PALETTE, type CategoryDto, type SourceDto } from "./types";

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="grid grid-cols-6 gap-2">
      {COLOR_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            "flex size-11 items-center justify-center rounded-lg border transition-transform md:size-9",
            value === c ? "scale-105 ring-2 ring-ring ring-offset-2 ring-offset-background" : "hover:scale-105",
          )}
          style={{ backgroundColor: c }}
          aria-label={c}
        />
      ))}
    </div>
  );
}

// ── Catégories ───────────────────────────────────────────────────────────────

export function CategoriesCard({ initial }: { initial: CategoryDto[] }) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [syncedFrom, setSyncedFrom] = useState(initial);
  // Le serveur peut renvoyer des compteurs frais (router.refresh après un
  // refus « fiches rattachées entre-temps ») : on les adopte. Patron React
  // « ajuster l'état quand une prop change » — pendant le rendu, pas dans un
  // effet, sinon useState(initial) resterait figé sur le premier rendu.
  if (initial !== syncedFrom) {
    setSyncedFrom(initial);
    setItems(initial);
  }
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<CategoryDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CategoryDto | null>(null);
  const [transferring, setTransferring] = useState<CategoryDto | null>(null);

  const label = (c: CategoryDto) => (locale === "fr" ? c.nameFr : c.nameEn);

  /** Compteurs après un transfert : la source se vide, la cible encaisse. */
  const applyTransfer = (fromId: number, targetId: number | null, moved: number) =>
    setItems((prev) =>
      prev.map((c) =>
        c.id === fromId
          ? { ...c, clientCount: 0 }
          : c.id === targetId
            ? { ...c, clientCount: c.clientCount + moved }
            : c,
      ),
    );

  const move = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    setPending(true);
    try {
      await api("/api/admin/categories/reorder", {
        method: "POST",
        body: JSON.stringify({ orderedIds: next.map((c) => c.id) }),
      });
    } catch {
      setItems(items);
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle>{t("pipeline.categories.title")}</CardTitle>
        <CardDescription>{t("pipeline.categories.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1.5">
          {items.map((c, i) => (
            <li
              key={c.id}
              className="group flex items-center gap-2 rounded-lg border border-l-4 px-2.5 py-2 transition-colors hover:bg-muted/50"
              style={{ borderLeftColor: c.color }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.nameFr}</p>
                <p className="truncate text-xs text-muted-foreground">{c.nameEn}</p>
              </div>
              {/* Compteur et cadenas en pastilles compactes : le nom des
                  catégories est long (« Acheteur — 1re rencontre en ligne »)
                  et c'est lui qui doit garder la place. */}
              <Badge
                variant="secondary"
                className="shrink-0 tabular-nums"
                title={t("pipeline.categories.clientCount", { count: c.clientCount })}
              >
                <span aria-hidden>{c.clientCount}</span>
                <span className="sr-only">
                  {t("pipeline.categories.clientCount", { count: c.clientCount })}
                </span>
              </Badge>
              {c.isSystem ? (
                <Badge
                  variant="outline"
                  className="shrink-0"
                  title={t("pipeline.categories.system")}
                >
                  <Lock className="size-3" />
                  <span className="sr-only">{t("pipeline.categories.system")}</span>
                </Badge>
              ) : null}
              {/* Sur md+, la grappe d'icônes n'apparaît qu'au survol ou au focus ;
                  au tactile (pas de survol) elle reste toujours visible. */}
              <div className="flex shrink-0 items-center gap-0.5 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 md:size-7"
                  disabled={pending || i === 0}
                  onClick={() => void move(i, -1)}
                  aria-label={t("pipeline.moveUp")}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 md:size-7"
                  disabled={pending || i === items.length - 1}
                  onClick={() => void move(i, 1)}
                  aria-label={t("pipeline.moveDown")}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 md:size-7"
                  onClick={() => setEditing(c)}
                  aria-label={t("edit")}
                >
                  <Pencil className="size-4" />
                </Button>
                {/* Déplacer les fiches sans supprimer la catégorie : utile
                    quand on réorganise le pipeline plutôt que de le réduire. */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 md:size-7"
                  disabled={c.clientCount === 0}
                  onClick={() => setTransferring(c)}
                  aria-label={t("pipeline.transferAria", { name: label(c) })}
                >
                  <ArrowRightLeft className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 text-destructive md:size-7"
                  disabled={c.isSystem}
                  onClick={() => setDeleting(c)}
                  aria-label={t("delete")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t("pipeline.categories.create")}
        </Button>
      </CardContent>

      <CategoryFormDialog
        key={editing ? `edit-${editing.id}` : creating ? "create" : "closed"}
        open={creating || editing !== null}
        category={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={(saved, isNew) => {
          setItems((prev) => (isNew ? [...prev, saved] : prev.map((p) => (p.id === saved.id ? saved : p))));
          setCreating(false);
          setEditing(null);
        }}
      />

      <TransferClientsDialog
        key={transferring ? `transfer-${transferring.id}` : "transfer-closed"}
        open={transferring !== null}
        title={transferring ? t("pipeline.transferTitle", { name: label(transferring) }) : ""}
        description={t("pipeline.transferDesc", { count: transferring?.clientCount ?? 0 })}
        options={items
          .filter((c) => c.id !== transferring?.id)
          .map((c) => ({ value: String(c.id), label: label(c) }))}
        noneLabel={t("pipeline.noCategory")}
        onClose={() => setTransferring(null)}
        onConfirm={async (targetId) => {
          if (!transferring) return;
          try {
            const res = await api<{ moved: number }>(
              `/api/admin/categories/${transferring.id}/transfer`,
              { method: "POST", body: JSON.stringify({ targetId }) },
            );
            applyTransfer(transferring.id, targetId, res.moved);
            toast.success(t("pipeline.transferred", { count: res.moved }));
          } catch {
            toast.error(t("genericError"));
          } finally {
            setTransferring(null);
          }
        }}
      />

      <DeleteWithReassignDialog
        open={deleting !== null}
        title={deleting ? t("pipeline.categories.deleteTitle", { name: label(deleting) }) : ""}
        description={t("pipeline.categories.deleteDesc", { count: deleting?.clientCount ?? 0 })}
        clientCount={deleting?.clientCount ?? 0}
        options={items
          .filter((c) => c.id !== deleting?.id)
          .map((c) => ({ value: String(c.id), label: label(c) }))}
        noneLabel={t("pipeline.noCategory")}
        onClose={() => setDeleting(null)}
        onConfirm={async (reassignTo) => {
          if (!deleting) return;
          try {
            // `moved` vient du serveur : seul compte fiable si le compteur
            // affiché avait pris du retard.
            const { moved } = await api<{ moved: number }>(
              `/api/admin/categories/${deleting.id}`,
              {
                method: "DELETE",
                ...(reassignTo === undefined ? {} : { body: JSON.stringify({ reassignTo }) }),
              },
            );
            setItems((prev) =>
              prev
                .filter((p) => p.id !== deleting.id)
                .map((p) =>
                  p.id === reassignTo ? { ...p, clientCount: p.clientCount + moved } : p,
                ),
            );
            toast.success(t("pipeline.categories.deleted"));
          } catch (err) {
            const code = err instanceof ApiError ? err.code : null;
            if (code === "reassign_required") {
              // Des fiches sont arrivées depuis l'affichage : on recharge les
              // compteurs pour que la boîte redemande une destination.
              toast.error(t("pipeline.reassignRequired"));
              router.refresh();
            } else {
              toast.error(
                code === "system_category"
                  ? t("pipeline.categories.systemError")
                  : t("genericError"),
              );
            }
          } finally {
            setDeleting(null);
          }
        }}
      />
    </Card>
  );
}

function CategoryFormDialog({
  open,
  category,
  onClose,
  onSaved,
}: {
  open: boolean;
  category: CategoryDto | null;
  onClose: () => void;
  onSaved: (c: CategoryDto, isNew: boolean) => void;
}) {
  const t = useTranslations("admin");
  const [form, setForm] = useState({
    nameFr: category?.nameFr ?? "",
    nameEn: category?.nameEn ?? "",
    color: category?.color ?? COLOR_PALETTE[9],
  });
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    try {
      if (category) {
        const res = await api<{ category: Omit<CategoryDto, "clientCount"> }>(
          `/api/admin/categories/${category.id}`,
          { method: "PATCH", body: JSON.stringify(form) },
        );
        onSaved({ ...res.category, clientCount: category.clientCount }, false);
      } else {
        const res = await api<{ category: Omit<CategoryDto, "clientCount"> }>("/api/admin/categories", {
          method: "POST",
          body: JSON.stringify(form),
        });
        onSaved({ ...res.category, clientCount: 0 }, true);
      }
      toast.success(t("saved"));
    } catch {
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {category ? t("pipeline.categories.editTitle") : t("pipeline.categories.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("pipeline.categories.formDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cat-fr">{t("pipeline.categories.nameFr")}</Label>
            <Input id="cat-fr" value={form.nameFr} onChange={(e) => setForm({ ...form, nameFr: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-en">{t("pipeline.categories.nameEn")}</Label>
            <Input id="cat-en" value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("pipeline.color")}</Label>
            <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={pending || !form.nameFr || !form.nameEn}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Choix d'une destination pour les fiches rattachées ───────────────────────
// Valeur sentinelle : « aucune catégorie / aucune source » est un CHOIX
// explicite, distinct de « rien de choisi » (null) qui bloque la validation.
const NONE_VALUE = "__none__";

/** Sélecteur « où partent les fiches ? » partagé par les deux boîtes. */
function DestinationSelect({
  value,
  onChange,
  options,
  noneLabel,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: { value: string; label: string }[];
  noneLabel: string;
}) {
  const t = useTranslations("admin");
  return (
    <div className="space-y-1.5">
      <Label>{t("pipeline.reassignLabel")}</Label>
      <Select
        items={[{ value: NONE_VALUE, label: noneLabel }, ...options]}
        value={value}
        onValueChange={(v) => onChange(v === null ? null : String(v))}
      >
        <SelectTrigger className="min-h-11 w-full md:min-h-9">
          <SelectValue placeholder={t("pipeline.reassignPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE_VALUE}>{noneLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** `"__none__"` → null (sans catégorie/source) ; sinon l'id numérique. */
function toTargetId(choice: string | null): number | null {
  return choice === null || choice === NONE_VALUE ? null : Number(choice);
}

// ── Suppression avec transfert obligatoire ───────────────────────────────────

function DeleteWithReassignDialog({
  open,
  title,
  description,
  clientCount,
  options,
  noneLabel,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  /** Nombre de fiches rattachées — au-delà de 0, la destination est exigée. */
  clientCount: number;
  options: { value: string; label: string }[];
  noneLabel: string;
  onClose: () => void;
  /** `undefined` = aucune décision transmise : le serveur tranche sur SON
   *  propre compte, à jour, et refuse si des fiches sont apparues depuis. */
  onConfirm: (reassignTo: number | null | undefined) => Promise<void>;
}) {
  const t = useTranslations("admin");
  const [choice, setChoice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Aucune fiche rattachée : rien à déplacer, on ne demande rien.
  // Sinon la destination est obligatoire — le serveur refuse lui aussi une
  // suppression sans décision explicite (jamais d'orpheline en silence).
  const mustChoose = clientCount > 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setChoice(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {mustChoose ? (
          <DestinationSelect
            value={choice}
            onChange={setChoice}
            options={options}
            noneLabel={noneLabel}
          />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending || (mustChoose && choice === null)}
            onClick={async () => {
              setPending(true);
              try {
                // Rien à déplacer d'après l'affichage : on ne décide RIEN, pour
                // que le serveur puisse refuser si le compteur était périmé.
                await onConfirm(mustChoose ? toTargetId(choice) : undefined);
              } finally {
                setPending(false);
                setChoice(null);
              }
            }}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Transfert des fiches (sans suppression) ──────────────────────────────────

function TransferClientsDialog({
  open,
  title,
  description,
  options,
  noneLabel,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  options: { value: string; label: string }[];
  noneLabel: string;
  onClose: () => void;
  onConfirm: (targetId: number | null) => Promise<void>;
}) {
  const t = useTranslations("admin");
  const [choice, setChoice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setChoice(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DestinationSelect
          value={choice}
          onChange={setChoice}
          options={options}
          noneLabel={noneLabel}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            disabled={pending || choice === null}
            onClick={async () => {
              setPending(true);
              try {
                await onConfirm(toTargetId(choice));
              } finally {
                setPending(false);
                setChoice(null);
              }
            }}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("pipeline.transfer")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Sources ──────────────────────────────────────────────────────────────────

export function SourcesCard({ initial }: { initial: SourceDto[] }) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [syncedFrom, setSyncedFrom] = useState(initial);
  // Le serveur peut renvoyer des compteurs frais (router.refresh après un
  // refus « fiches rattachées entre-temps ») : on les adopte. Patron React
  // « ajuster l'état quand une prop change » — pendant le rendu, pas dans un
  // effet, sinon useState(initial) resterait figé sur le premier rendu.
  if (initial !== syncedFrom) {
    setSyncedFrom(initial);
    setItems(initial);
  }
  const [editing, setEditing] = useState<SourceDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SourceDto | null>(null);
  const [transferring, setTransferring] = useState<SourceDto | null>(null);

  /** Compteurs après un transfert : la source se vide, la cible encaisse. */
  const applyTransfer = (fromId: number, targetId: number | null, moved: number) =>
    setItems((prev) =>
      prev.map((s) =>
        s.id === fromId
          ? { ...s, clientCount: 0 }
          : s.id === targetId
            ? { ...s, clientCount: s.clientCount + moved }
            : s,
      ),
    );

  return (
    <Card className="shadow-xs">
      <CardHeader>
        <CardTitle>{t("pipeline.sources.title")}</CardTitle>
        <CardDescription>{t("pipeline.sources.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1.5">
          {items.map((s) => (
            <li
              key={s.id}
              className="group flex items-center gap-2 rounded-lg border border-l-4 px-2.5 py-2 transition-colors hover:bg-muted/50"
              style={{ borderLeftColor: s.color }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.name}</p>
              </div>
              <Badge
                variant="secondary"
                className="shrink-0 tabular-nums"
                title={t("pipeline.categories.clientCount", { count: s.clientCount })}
              >
                <span aria-hidden>{s.clientCount}</span>
                <span className="sr-only">
                  {t("pipeline.categories.clientCount", { count: s.clientCount })}
                </span>
              </Badge>
              {/* Même règle que les catégories : visible au survol/focus sur md+. */}
              <div className="flex shrink-0 items-center gap-0.5 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 md:size-7"
                  onClick={() => setEditing(s)}
                  aria-label={t("edit")}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 md:size-7"
                  disabled={s.clientCount === 0}
                  onClick={() => setTransferring(s)}
                  aria-label={t("pipeline.transferAria", { name: s.name })}
                >
                  <ArrowRightLeft className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 text-destructive md:size-7"
                  onClick={() => setDeleting(s)}
                  aria-label={t("delete")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t("pipeline.sources.create")}
        </Button>
      </CardContent>

      <SourceFormDialog
        key={editing ? `edit-${editing.id}` : creating ? "create" : "closed"}
        open={creating || editing !== null}
        source={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSaved={(saved, isNew) => {
          setItems((prev) => (isNew ? [...prev, saved] : prev.map((p) => (p.id === saved.id ? saved : p))));
          setCreating(false);
          setEditing(null);
        }}
      />

      <TransferClientsDialog
        key={transferring ? `transfer-${transferring.id}` : "transfer-closed"}
        open={transferring !== null}
        title={transferring ? t("pipeline.transferTitle", { name: transferring.name }) : ""}
        description={t("pipeline.transferDesc", { count: transferring?.clientCount ?? 0 })}
        options={items
          .filter((s) => s.id !== transferring?.id)
          .map((s) => ({ value: String(s.id), label: s.name }))}
        noneLabel={t("pipeline.noSource")}
        onClose={() => setTransferring(null)}
        onConfirm={async (targetId) => {
          if (!transferring) return;
          try {
            const res = await api<{ moved: number }>(
              `/api/admin/sources/${transferring.id}/transfer`,
              { method: "POST", body: JSON.stringify({ targetId }) },
            );
            applyTransfer(transferring.id, targetId, res.moved);
            toast.success(t("pipeline.transferred", { count: res.moved }));
          } catch {
            toast.error(t("genericError"));
          } finally {
            setTransferring(null);
          }
        }}
      />

      <DeleteWithReassignDialog
        open={deleting !== null}
        title={deleting ? t("pipeline.sources.deleteTitle", { name: deleting.name }) : ""}
        description={t("pipeline.sources.deleteDesc", { count: deleting?.clientCount ?? 0 })}
        clientCount={deleting?.clientCount ?? 0}
        options={items.filter((s) => s.id !== deleting?.id).map((s) => ({ value: String(s.id), label: s.name }))}
        noneLabel={t("pipeline.noSource")}
        onClose={() => setDeleting(null)}
        onConfirm={async (reassignTo) => {
          if (!deleting) return;
          try {
            // `moved` vient du serveur : seul compte fiable si le compteur
            // affiché avait pris du retard.
            const { moved } = await api<{ moved: number }>(`/api/admin/sources/${deleting.id}`, {
              method: "DELETE",
              ...(reassignTo === undefined ? {} : { body: JSON.stringify({ reassignTo }) }),
            });
            setItems((prev) =>
              prev
                .filter((p) => p.id !== deleting.id)
                .map((p) =>
                  p.id === reassignTo ? { ...p, clientCount: p.clientCount + moved } : p,
                ),
            );
            toast.success(t("pipeline.sources.deleted"));
          } catch (err) {
            if (err instanceof ApiError && err.code === "reassign_required") {
              // Des fiches sont arrivées depuis l'affichage : on recharge.
              toast.error(t("pipeline.reassignRequired"));
              router.refresh();
            } else {
              toast.error(t("genericError"));
            }
          } finally {
            setDeleting(null);
          }
        }}
      />
    </Card>
  );
}

function SourceFormDialog({
  open,
  source,
  onClose,
  onSaved,
}: {
  open: boolean;
  source: SourceDto | null;
  onClose: () => void;
  onSaved: (s: SourceDto, isNew: boolean) => void;
}) {
  const t = useTranslations("admin");
  const [form, setForm] = useState({ name: source?.name ?? "", color: source?.color ?? COLOR_PALETTE[11] });
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    try {
      if (source) {
        const res = await api<{ source: Omit<SourceDto, "clientCount"> }>(`/api/admin/sources/${source.id}`, {
          method: "PATCH",
          body: JSON.stringify(form),
        });
        onSaved({ ...res.source, clientCount: source.clientCount }, false);
      } else {
        const res = await api<{ source: Omit<SourceDto, "clientCount"> }>("/api/admin/sources", {
          method: "POST",
          body: JSON.stringify(form),
        });
        onSaved({ ...res.source, clientCount: 0 }, true);
      }
      toast.success(t("saved"));
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.code === "name_taken" ? t("pipeline.sources.nameTaken") : t("genericError"),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {source ? t("pipeline.sources.editTitle") : t("pipeline.sources.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("pipeline.sources.formDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="src-name">{t("pipeline.sources.name")}</Label>
            <Input id="src-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("pipeline.color")}</Label>
            <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={pending || !form.name}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
