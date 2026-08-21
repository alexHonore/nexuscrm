"use client";

import { Loader2, Megaphone, MoreHorizontal, Pause, Play, Plus, Trash2 } from "lucide-react";
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
import type { TriggerKind } from "@/lib/campaigns/schema";
import { api } from "./api";

export type CampaignListItem = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  triggerKind: TriggerKind;
  enrolled: number;
  active: number;
  replied: number;
  stopped: number;
  updatedAt: string;
};

/**
 * Liste des campagnes.
 *
 * Les quatre nombres affichés — inscrits, en cours, réponses, arrêts — sont
 * choisis pour répondre d'un coup d'œil à la seule question qui compte : est-ce
 * que ça marche, et est-ce que ça dérange? Un taux de réponse honorable avec
 * beaucoup d'arrêts n'est pas un succès.
 */
export function CampaignsListClient({
  items,
  archivedCount,
}: {
  items: CampaignListItem[];
  archivedCount: number;
}) {
  const t = useTranslations("campaigns");
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<CampaignListItem | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setCreating(true);
    try {
      const created = await api<{ id: string }>("/api/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: t("list.new"),
          trigger: { kind: "manual" },
          ladder: [{ delayHours: 0, body: "", label: "" }],
        }),
      });
      toast.success(t("list.created"));
      router.push(`/admin/campaigns/${created.id}`);
    } catch {
      toast.error(t("editor.errors.save"));
      setCreating(false);
    }
  };

  const setStatus = async (item: CampaignListItem, status: "active" | "paused") => {
    try {
      await api(`/api/campaigns/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      toast.success(status === "active" ? t("editor.activated") : t("editor.paused"));
      router.refresh();
    } catch {
      toast.error(t("editor.errors.save"));
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api<{ deleted: boolean }>(`/api/campaigns/${target.id}`, {
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
      <div className="flex justify-end">
        <Button onClick={() => void create()} disabled={creating} className="min-h-11 md:min-h-9">
          {creating ? <Loader2 className="animate-spin" /> : <Plus />} {t("list.new")}
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Megaphone />}
          title={t("list.empty.title")}
          hint={t("list.empty.desc")}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((item) => (
            <Card key={item.id}>
              <CardContent className="flex items-start gap-3 p-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/campaigns/${item.id}`}
                      className="font-medium hover:underline"
                    >
                      {item.name}
                    </Link>
                    <Badge variant={item.status === "active" ? "default" : "secondary"}>
                      {t(`list.status.${item.status}` as never)}
                    </Badge>
                    <Badge variant="outline" className="font-normal">
                      {t(`list.trigger.${item.triggerKind}`)}
                    </Badge>
                  </div>

                  {item.description ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{item.description}</p>
                  ) : null}

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span>{t("list.stats.enrolled", { count: item.enrolled })}</span>
                    <span>{t("list.stats.active", { count: item.active })}</span>
                    <span>{t("list.stats.replied", { count: item.replied })}</span>
                    {/* Les arrêts sont affichés à côté des réponses, jamais
                        cachés : un bon taux de réponse avec beaucoup d'arrêts
                        n'est pas un succès. */}
                    <span className={item.stopped > 0 ? "text-destructive" : undefined}>
                      {t("list.stats.stopped", { count: item.stopped })}
                    </span>
                  </div>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon" className="size-11 shrink-0 md:size-9" />}
                  >
                    <MoreHorizontal />
                    <span className="sr-only">{item.name}</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem render={<Link href={`/admin/campaigns/${item.id}`} />}>
                        {t("list.actions.edit")}
                      </DropdownMenuItem>
                      {item.status === "active" ? (
                        <DropdownMenuItem onClick={() => void setStatus(item, "paused")}>
                          <Pause /> {t("list.actions.pause")}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => void setStatus(item, "active")}>
                          <Play /> {t("list.actions.activate")}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem variant="destructive" onClick={() => setTarget(item)}>
                        <Trash2 />{" "}
                        {item.enrolled > 0 ? t("list.actions.archive") : t("list.actions.delete")}
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
              {(target?.enrolled ?? 0) > 0
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
