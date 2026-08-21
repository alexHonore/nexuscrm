"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Download,
  Loader2,
  MoreHorizontal,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import type { GoalType } from "@/lib/assistants/schema";
import { api } from "./api";
import { AssistantImportDialog } from "./assistant-import-dialog";

export type AssistantListItem = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  goalType: GoalType;
  suitePassed: boolean;
  needsRecompile: boolean;
  everCompiled: boolean;
  /** Vrai si l'assistant a déjà écrit : il ne peut plus être que archivé. */
  hasWritten: boolean;
  updatedAt: string;
};

/**
 * Liste des assistants.
 *
 * Trois états sont affichés côte à côte parce qu'ils répondent à des questions
 * différentes : l'assistant est-il en service (état), son prompt correspond-il à
 * sa configuration (compilation), et s'est-il bien comporté au dernier test
 * (suite). Un assistant actif avec un prompt périmé est le cas qu'il faut voir
 * d'un coup d'œil.
 */
export function AssistantsListClient({
  items,
  archivedCount,
}: {
  items: AssistantListItem[];
  archivedCount: number;
}) {
  const t = useTranslations("assistants");
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<AssistantListItem | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setCreating(true);
    try {
      const created = await api<{ id: string }>("/api/assistants", {
        method: "POST",
        body: JSON.stringify({
          name: t("list.new"),
          identity: {},
          goal: { primary: { type: "video_meeting", durationMin: 30, appointmentType: "meet" }, fallbacks: [] },
          approach: {},
          model: {},
        }),
      });
      toast.success(t("list.created"));
      router.push(`/admin/assistants/${created.id}`);
    } catch {
      toast.error(t("editor.errors.save"));
      setCreating(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api<{ deleted: boolean }>(`/api/assistants/${target.id}`, {
        method: "DELETE",
      });
      toast.success(res.deleted ? t("list.deleted") : t("list.archived"));
      setTarget(null);
      router.refresh();
    } catch {
      toast.error(t("editor.errors.save"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <AssistantImportDialog
          trigger={
            <Button variant="outline" className="min-h-11 md:min-h-9">
              <Upload /> {t("list.import")}
            </Button>
          }
        />
        <Button onClick={() => void create()} disabled={creating} className="min-h-11 md:min-h-9">
          {creating ? <Loader2 className="animate-spin" /> : <Plus />} {t("list.new")}
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title={t("list.empty.title")}
          hint={t("list.empty.desc")}
        />
      ) : (
        // Cartes partout : sur téléphone une rangée de tableau tronque
        // justement les trois pastilles d'état qui font l'intérêt de l'écran.
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((item) => (
            <Card key={item.id} className="overflow-hidden">
              <CardContent className="flex items-start gap-3 p-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/assistants/${item.id}`}
                      className="font-medium hover:underline"
                    >
                      {item.name}
                    </Link>
                    <StatusBadge status={item.status} />
                  </div>

                  {item.description ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{item.description}</p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-normal">
                      {t(`goalType.${item.goalType}`)}
                    </Badge>
                    <CompileBadge item={item} />
                    <SuiteBadge item={item} />
                  </div>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon" className="size-11 shrink-0 md:size-9" />
                    }
                  >
                    <MoreHorizontal />
                    <span className="sr-only">{item.name}</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem render={<Link href={`/admin/assistants/${item.id}`} />}>
                        {t("list.actions.edit")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        render={<a href={`/api/assistants/${item.id}/export`} download />}
                      >
                        <Download /> {t("list.actions.export")}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setTarget(item)}>
                        <Trash2 />{" "}
                        {item.hasWritten ? t("list.actions.archive") : t("list.actions.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {archivedCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          {archivedCount} {t("list.status.archived").toLowerCase()}
        </p>
      ) : null}

      <AlertDialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("list.deleteConfirm.title", { name: target?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target?.hasWritten
                ? t("list.deleteConfirm.bodyArchive")
                : t("list.deleteConfirm.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t("list.deleteConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("assistants");
  const variant = status === "active" ? "default" : status === "archived" ? "outline" : "secondary";
  return <Badge variant={variant}>{t(`list.status.${status}` as never)}</Badge>;
}

function CompileBadge({ item }: { item: AssistantListItem }) {
  const t = useTranslations("assistants");
  if (!item.everCompiled) {
    return (
      <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
        {t("list.compiled.never")}
      </Badge>
    );
  }
  if (item.needsRecompile) {
    // Le cas qui compte : actif ET périmé. Le texte du prompt n'est plus celui
    // que la fiche affiche.
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 font-normal text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3" /> {t("list.compiled.stale")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
      <CheckCircle2 className="size-3" /> {t("list.compiled.fresh")}
    </Badge>
  );
}

function SuiteBadge({ item }: { item: AssistantListItem }) {
  const t = useTranslations("assistants");
  if (!item.everCompiled) return null;
  return item.suitePassed ? (
    <Badge variant="outline" className="gap-1 border-emerald-500/40 font-normal text-emerald-600 dark:text-emerald-400">
      <CheckCircle2 className="size-3" /> {t("list.suite.passed")}
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 border-destructive/40 font-normal text-destructive">
      <AlertTriangle className="size-3" /> {t("list.suite.failed")}
    </Badge>
  );
}
