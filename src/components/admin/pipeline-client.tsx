"use client";

import { ArrowDown, ArrowUp, Loader2, Lock, Pencil, Plus, Trash2 } from "lucide-react";
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

function Dot({ color }: { color: string }) {
  return <span className="inline-block size-3 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

// ── Catégories ───────────────────────────────────────────────────────────────

export function CategoriesCard({ initial }: { initial: CategoryDto[] }) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const [items, setItems] = useState(initial);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<CategoryDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CategoryDto | null>(null);

  const label = (c: CategoryDto) => (locale === "fr" ? c.nameFr : c.nameEn);

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
    <Card>
      <CardHeader>
        <CardTitle>{t("pipeline.categories.title")}</CardTitle>
        <CardDescription>{t("pipeline.categories.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1.5">
          {items.map((c, i) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded-lg border px-2.5 py-2"
            >
              <Dot color={c.color} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.nameFr}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.nameEn} · {t("pipeline.categories.clientCount", { count: c.clientCount })}
                </p>
              </div>
              {c.isSystem ? (
                <Badge variant="outline" className="shrink-0 gap-1">
                  <Lock className="size-3" />
                  {t("pipeline.categories.system")}
                </Badge>
              ) : null}
              <div className="flex shrink-0 items-center gap-0.5">
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

      <DeleteWithReassignDialog
        open={deleting !== null}
        title={deleting ? t("pipeline.categories.deleteTitle", { name: label(deleting) }) : ""}
        description={t("pipeline.categories.deleteDesc", { count: deleting?.clientCount ?? 0 })}
        options={items
          .filter((c) => c.id !== deleting?.id)
          .map((c) => ({ value: String(c.id), label: label(c) }))}
        noneLabel={t("pipeline.noCategory")}
        onClose={() => setDeleting(null)}
        onConfirm={async (reassignTo) => {
          if (!deleting) return;
          try {
            await api(`/api/admin/categories/${deleting.id}`, {
              method: "DELETE",
              body: JSON.stringify({ reassignTo }),
            });
            setItems((prev) => prev.filter((p) => p.id !== deleting.id));
            toast.success(t("pipeline.categories.deleted"));
          } catch (err) {
            toast.error(
              err instanceof ApiError && err.code === "system_category"
                ? t("pipeline.categories.systemError")
                : t("genericError"),
            );
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

// ── Suppression avec réassignation ───────────────────────────────────────────

function DeleteWithReassignDialog({
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
  onConfirm: (reassignTo: number | null) => Promise<void>;
}) {
  const t = useTranslations("admin");
  const [reassignTo, setReassignTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setReassignTo(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label>{t("pipeline.reassignLabel")}</Label>
          <Select
            items={[{ value: null as unknown as string, label: noneLabel }, ...options]}
            value={reassignTo}
            onValueChange={(v) => setReassignTo(v === null ? null : String(v))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={noneLabel} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={null}>{noneLabel}</SelectItem>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                await onConfirm(reassignTo === null ? null : Number(reassignTo));
              } finally {
                setPending(false);
                setReassignTo(null);
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

// ── Sources ──────────────────────────────────────────────────────────────────

export function SourcesCard({ initial }: { initial: SourceDto[] }) {
  const t = useTranslations("admin");
  const [items, setItems] = useState(initial);
  const [editing, setEditing] = useState<SourceDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<SourceDto | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pipeline.sources.title")}</CardTitle>
        <CardDescription>{t("pipeline.sources.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1.5">
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-2">
              <Dot color={s.color} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t("pipeline.categories.clientCount", { count: s.clientCount })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
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

      <DeleteWithReassignDialog
        open={deleting !== null}
        title={deleting ? t("pipeline.sources.deleteTitle", { name: deleting.name }) : ""}
        description={t("pipeline.sources.deleteDesc", { count: deleting?.clientCount ?? 0 })}
        options={items.filter((s) => s.id !== deleting?.id).map((s) => ({ value: String(s.id), label: s.name }))}
        noneLabel={t("pipeline.noSource")}
        onClose={() => setDeleting(null)}
        onConfirm={async (reassignTo) => {
          if (!deleting) return;
          try {
            await api(`/api/admin/sources/${deleting.id}`, {
              method: "DELETE",
              body: JSON.stringify({ reassignTo }),
            });
            setItems((prev) => prev.filter((p) => p.id !== deleting.id));
            toast.success(t("pipeline.sources.deleted"));
          } catch {
            toast.error(t("genericError"));
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
