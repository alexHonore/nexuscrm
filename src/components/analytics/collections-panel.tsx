"use client";

import { Loader2, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/components/admin/api";
import { LIBRARY_LOOK, LookGlyph } from "@/components/look";
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
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type CollectionRow = {
  id: string;
  kind: "folder" | "tag";
  name: string;
  description: string | null;
  /** Décompte DÉJÀ filtré par la portée de celui qui regarde (règle 13). */
  count: number;
};

/**
 * Le rayonnage de la bibliothèque : mes marqués, les dossiers, les étiquettes.
 *
 * Les décomptes affichés ici sont ceux de CELUI QUI REGARDE, jamais les totaux
 * bruts — un « 40 » sous une liste de six aurait annoncé, à la ligne près, le
 * nombre d'appels qu'on lui cache. La phrase sous la liste le dit en toutes
 * lettres, pour que « 6 » ne se lise pas comme une panne.
 */
export function CollectionsPanel({
  collections,
  starred,
  scope,
  canCurate,
}: {
  collections: CollectionRow[];
  starred: number;
  scope: { kind: "starred" } | { kind: "collection"; id: string };
  canCurate: boolean;
}) {
  const t = useTranslations("analytics");
  const [editing, setEditing] = useState<CollectionRow | null>(null);
  const [creating, setCreating] = useState<"folder" | "tag" | null>(null);
  const [deleting, setDeleting] = useState<CollectionRow | null>(null);

  const groups = [
    { kind: "folder" as const, label: t("library.folders"), hint: t("library.foldersHint") },
    { kind: "tag" as const, label: t("library.tags"), hint: t("library.tagsHint") },
  ];

  return (
    <nav aria-label={t("library.title")} className="space-y-5">
      <div>
        <Link
          href="/admin/recordings"
          aria-current={scope.kind === "starred" ? "page" : undefined}
          className={cn(
            "flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm transition-colors hover:bg-muted md:min-h-9",
            scope.kind === "starred" && "bg-muted font-medium",
          )}
        >
          <LookGlyph look={LIBRARY_LOOK.starred} className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">{t("library.starredScope")}</span>
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{starred}</span>
        </Link>
        <p className="mt-1 px-2 text-xs text-muted-foreground">{t("library.starredHint")}</p>
      </div>

      {groups.map((g) => {
        const items = collections.filter((c) => c.kind === g.kind);
        return (
          <div key={g.kind}>
            <div className="flex items-center justify-between gap-2 px-2">
              <h2 className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                {g.label}
              </h2>
              {canCurate ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-11 md:size-7"
                  aria-label={g.kind === "folder" ? t("library.newFolder") : t("library.newTag")}
                  title={g.kind === "folder" ? t("library.newFolder") : t("library.newTag")}
                  onClick={() => setCreating(g.kind)}
                >
                  <PlusIcon className="size-4" />
                </Button>
              ) : null}
            </div>
            <p className="mt-0.5 px-2 text-xs text-muted-foreground">{g.hint}</p>
            <ul className="mt-1">
              {items.map((c) => {
                const active = scope.kind === "collection" && scope.id === c.id;
                return (
                  <li key={c.id} className="group flex items-center gap-1">
                    <Link
                      href={`/admin/recordings?c=${c.id}`}
                      aria-current={active ? "page" : undefined}
                      title={c.description ?? c.name}
                      className={cn(
                        "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-sm transition-colors hover:bg-muted md:min-h-9",
                        active && "bg-muted font-medium",
                      )}
                    >
                      <LookGlyph look={LIBRARY_LOOK[c.kind]} className="size-3.5" />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                        {c.count}
                      </span>
                    </Link>
                    {canCurate ? (
                      // Toujours visibles au doigt ; effacées au survol seulement
                      // sur écran, où le pointeur remplace le tâtonnement.
                      <span className="flex shrink-0 items-center md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-11 md:size-7"
                          aria-label={
                            c.kind === "folder" ? t("library.editFolder") : t("library.editTag")
                          }
                          onClick={() => setEditing(c)}
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-11 text-destructive md:size-7"
                          aria-label={t("library.deleteTitle", { name: c.name })}
                          onClick={() => setDeleting(c)}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <p className="px-2 text-xs text-muted-foreground">{t("library.countHidden")}</p>
      {canCurate ? null : (
        <p className="px-2 text-xs text-muted-foreground">{t("library.readOnly")}</p>
      )}

      {creating ? (
        <CollectionDialog kind={creating} onClose={() => setCreating(null)} />
      ) : null}
      {editing ? (
        <CollectionDialog
          kind={editing.kind}
          collection={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteCollectionDialog collection={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </nav>
  );
}

function CollectionDialog({
  kind,
  collection,
  onClose,
}: {
  kind: "folder" | "tag";
  collection?: CollectionRow;
  onClose: () => void;
}) {
  const t = useTranslations("analytics");
  const router = useRouter();
  const [name, setName] = useState(collection?.name ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    try {
      const payload = { name: name.trim(), description: description.trim() || null };
      if (collection) {
        await api(`/api/admin/recordings/collections/${collection.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        toast.success(t("library.updated"));
      } else {
        await api("/api/admin/recordings/collections", {
          method: "POST",
          body: JSON.stringify({ kind, ...payload }),
        });
        toast.success(t("library.created"));
      }
      router.refresh();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.code === "name_taken"
          ? t("library.nameTaken")
          : t("library.genericError"),
      );
    } finally {
      setPending(false);
    }
  };

  const title = collection
    ? kind === "folder"
      ? t("library.editFolder")
      : t("library.editTag")
    : kind === "folder"
      ? t("library.newFolder")
      : t("library.newTag");

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {kind === "folder" ? t("library.foldersHint") : t("library.tagsHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="collection-name">{t("library.name")}</Label>
            <Input
              id="collection-name"
              value={name}
              maxLength={80}
              placeholder={t("library.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="collection-description">{t("library.description")}</Label>
            <Textarea
              id="collection-description"
              rows={2}
              maxLength={300}
              value={description}
              placeholder={t("library.descriptionPlaceholder")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("library.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={pending || name.trim().length === 0}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("library.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteCollectionDialog({
  collection,
  onClose,
}: {
  collection: CollectionRow;
  onClose: () => void;
}) {
  const t = useTranslations("analytics");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <AlertDialog open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("library.deleteTitle", { name: collection.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("library.deleteBody", { count: collection.count })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("library.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              try {
                await api(`/api/admin/recordings/collections/${collection.id}`, {
                  method: "DELETE",
                });
                toast.success(t("library.deleted"));
                // Le recueil ouvert vient de disparaître : revenir aux marqués
                // plutôt que de laisser une page qui parle d'un dossier mort.
                router.push("/admin/recordings");
                router.refresh();
                onClose();
              } catch {
                toast.error(t("library.genericError"));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("library.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
