"use client";

import {
  Download,
  Loader2,
  Megaphone,
  MoreHorizontal,
  Pause,
  PencilLine,
  Play,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { CAMPAIGN_STAT_LOOK, CAMPAIGN_STATUS_LOOK, LookGlyph, lookTint } from "@/components/look";
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
import { cn } from "@/lib/utils";
import { api } from "./api";
import { CampaignCreateDialog } from "./campaign-create";
import { CampaignImportDialog } from "./campaign-import-dialog";
import { TriggerIcon } from "./trigger-look";

/**
 * Les quatre compteurs, dans l'ordre où on les lit : combien sont entrés,
 * combien reçoivent encore, combien ont répondu, combien ont dit stop.
 */
const STAT_KEYS = ["enrolled", "active", "replied", "stopped"] as const;

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
  const [target, setTarget] = useState<CampaignListItem | null>(null);
  const [busy, setBusy] = useState(false);

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
      <div className="flex flex-wrap justify-end gap-2">
        <CampaignImportDialog
          trigger={
            <Button variant="outline" className="min-h-11 md:min-h-9">
              <Upload /> {t("list.import")}
            </Button>
          }
        />
        <CampaignCreateDialog
          trigger={
            <Button className="min-h-11 md:min-h-9">
              <Plus /> {t("list.new")}
            </Button>
          }
        />
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<Megaphone />}
          title={t("list.empty.title")}
          hint={t("list.empty.desc")}
          action={
            <CampaignCreateDialog
              trigger={
                <Button className="min-h-11 md:min-h-9">
                  <Plus /> {t("list.new")}
                </Button>
              }
            />
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((item) => {
            // Un état inconnu (valeur écrite par un module futur) reste
            // lisible plutôt que de faire disparaître la pastille.
            const statusLook = CAMPAIGN_STATUS_LOOK[item.status] ?? CAMPAIGN_STATUS_LOOK.draft;
            const statusTint = lookTint(statusLook);
            return (
              <Card
                key={item.id}
                // Le liseré reprend la couleur de l'état : empilées sur
                // téléphone, les cartes se trient à l'œil avant d'être lues. Il
                // DOUBLE la pastille, il ne la remplace pas.
                className="border-l-[3px]"
                style={{ borderLeftColor: `color-mix(in srgb, ${statusLook.color} 55%, transparent)` }}
              >
                <CardContent className="flex items-start gap-3 p-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Le nom EST le lien vers la campagne : sur téléphone
                          il se prend au pouce, donc on lui donne les 44 px
                          réglementaires sans toucher au rendu du bureau, où il
                          redevient un mot souligné dans une ligne de texte. */}
                      <Link
                        href={`/admin/campaigns/${item.id}`}
                        className="inline-flex min-h-11 items-center font-medium hover:underline md:inline md:min-h-0"
                      >
                        {item.name}
                      </Link>
                      {/* L'état dit si des SMS partent en ce moment : il porte
                          son pictogramme et sa couleur, jamais la couleur
                          seule. La teinte prend le fond et la bordure, jamais
                          le libellé : un « En pause » ambre de douze pixels se
                          repère mal dans une grille de cartes. */}
                      <Badge
                        variant="outline"
                        className="gap-1 pl-1.5 font-medium"
                        style={{
                          borderColor: statusTint.borderColor,
                          backgroundColor: statusTint.backgroundColor,
                        }}
                      >
                        <LookGlyph look={statusLook} />
                        {t(`list.status.${item.status}` as never)}
                      </Badge>
                      <Badge variant="outline" className="gap-1 pl-1 font-normal">
                        {/* Même pastille qu'à la création : ce qu'on a choisi
                            doit se reconnaître ici sans relire le libellé. */}
                        <TriggerIcon kind={item.triggerKind} size="sm" />
                        {t(`list.trigger.${item.triggerKind}`)}
                      </Badge>
                    </div>

                    {item.description ? (
                      <p className="line-clamp-2 text-sm text-muted-foreground">{item.description}</p>
                    ) : null}

                    {/* Les arrêts sont affichés à côté des réponses, jamais
                        cachés : un bon taux de réponse avec beaucoup d'arrêts
                        n'est pas un succès. Quatre nombres gris alignés se
                        valent à l'œil — le pictogramme et la couleur disent
                        lequel réjouit et lequel coûte. */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                      {STAT_KEYS.map((key) => {
                        const value = item[key];
                        return (
                          <span key={key} className="flex min-w-0 items-center gap-1.5">
                            {/* À zéro, le pictogramme s'efface : un stop rouge
                                devant « 0 arrêts » crierait au loup. */}
                            <LookGlyph
                              look={CAMPAIGN_STAT_LOOK[key]}
                              className={cn("size-3.5", value === 0 && "opacity-35")}
                            />
                            <span
                              className={
                                key === "stopped" && value > 0 ? "text-destructive" : undefined
                              }
                            >
                              {t(`list.stats.${key}`, { count: value })}
                            </span>
                          </span>
                        );
                      })}
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
                          <PencilLine /> {t("list.actions.edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          render={<a href={`/api/campaigns/${item.id}/export`} download />}
                        >
                          <Download /> {t("list.actions.export")}
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
            );
          })}
        </div>
      )}

      {archivedCount > 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <LookGlyph look={CAMPAIGN_STATUS_LOOK.archived} className="size-3.5" />
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
