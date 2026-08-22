"use client";

import {
  Bot,
  Download,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PowerOff,
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
import { ASSISTANT_STATUS_LOOK, GOAL_LOOK, LookIcon, type Look } from "@/components/look";
import type { GoalType } from "@/lib/assistants/schema";
import { api } from "./api";
import { AssistantImportDialog } from "./assistant-import-dialog";
import { AssistantCreateDialog } from "./assistant-create";

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
  const [target, setTarget] = useState<AssistantListItem | null>(null);
  const [toDeactivate, setToDeactivate] = useState<AssistantListItem | null>(null);
  const [busy, setBusy] = useState(false);

  // Retirer un assistant du service sans l'archiver : il repasse en brouillon
  // et devra repasser la porte d'activation. C'était le geste qui manquait
  // pour arrêter un assistant actif qui dérape.
  const deactivate = async () => {
    if (!toDeactivate) return;
    setBusy(true);
    try {
      await api(`/api/assistants/${toDeactivate.id}/deactivate`, { method: "POST" });
      toast.success(t("list.deactivated"));
      setToDeactivate(null);
      router.refresh();
    } catch {
      toast.error(t("editor.errors.save"));
    } finally {
      setBusy(false);
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
        {/* Trois portes d'entrée plutôt qu'un brouillon vide jeté dans un
            éditeur à onze onglets. */}
        <AssistantCreateDialog
          trigger={
            <Button className="min-h-11 md:min-h-9">
              <Plus /> {t("list.new")}
            </Button>
          }
        />
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
              <CardContent className="flex flex-wrap items-start gap-3 p-4">
                <div className="w-full min-w-0 space-y-2 md:w-auto md:flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* `break-words` : un nom d'assistant sans espace déborde
                        sinon de la carte sur un écran de 360 px. */}
                    <Link
                      href={`/admin/assistants/${item.id}`}
                      className="min-w-0 break-words font-medium hover:underline"
                    >
                      {item.name}
                    </Link>
                    <StatusBadge status={item.status} />
                  </div>

                  {item.description ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{item.description}</p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="gap-1 pl-1 font-normal">
                      {/* Même pastille qu'au choix de l'objectif à la création :
                          ce qu'on a coché doit se reconnaître ici sans relire. */}
                      <LookIcon
                        look={GOAL_LOOK[item.goalType] ?? GOAL_LOOK.qualify_only}
                        size="sm"
                      />
                      {t(`goalType.${item.goalType}`)}
                    </Badge>
                    <CompileBadge item={item} />
                    <SuiteBadge item={item} />
                  </div>
                </div>

                {/* Sous `md`, la carte n'est pas assez large pour porter le
                    texte ET les deux gestes sur la même ligne : la pastille
                    de l'objectif poussait « Rencontre en personne » hors de
                    la carte, où `overflow-hidden` le coupait. Les gestes
                    passent sous le texte, alignés à droite, cibles intactes. */}
                <div className="flex w-full shrink-0 items-center justify-end gap-3 md:w-auto">
                  {/* « Tester » est un BOUTON, pas une entrée de menu : c'est le
                      geste qu'on fait le plus souvent en réglant un assistant. */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11 shrink-0 md:min-h-8"
                    render={<Link href={`/admin/assistants/${item.id}?tab=sandbox`} />}
                  >
                    <MessageSquare /> {t("list.actions.test")}
                  </Button>

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
                          render={<Link href={`/admin/assistants/${item.id}?tab=sandbox`} />}
                        >
                          <MessageSquare /> {t("list.actions.test")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          render={<a href={`/api/assistants/${item.id}/export`} download />}
                        >
                          <Download /> {t("list.actions.export")}
                        </DropdownMenuItem>
                        {item.status === "active" ? (
                          <DropdownMenuItem onClick={() => setToDeactivate(item)}>
                            <PowerOff /> {t("list.actions.deactivate")}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem variant="destructive" onClick={() => setTarget(item)}>
                          <Trash2 />{" "}
                          {item.hasWritten ? t("list.actions.archive") : t("list.actions.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
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

      <AlertDialog
        open={toDeactivate !== null}
        onOpenChange={(open) => !open && setToDeactivate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("list.deactivateConfirm.title", { name: toDeactivate?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("list.deactivateConfirm.body")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deactivate()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t("list.deactivateConfirm.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Les trois lectures d'une ligne portent le MÊME habillage : bordure neutre,
 * libellé au ton du texte, et toute la couleur dans la pastille.
 *
 * Avant, la teinte était sur le TEXTE — un libellé ambre de douze pixels se
 * repère mal dans une grille de six cartes — et deux pictogrammes seulement
 * (coche, triangle) servaient aux cinq lectures : la coche de « prompt à jour »
 * et celle de « suite verte » étaient le même dessin. Sur une pastille, la
 * teinte devient une surface, et chaque lecture a son propre pictogramme, donc
 * la couleur peut disparaître sans que le sens parte avec elle.
 */
function StateBadge({ look, children }: { look: Look; children: React.ReactNode }) {
  return (
    <Badge variant="outline" className="gap-1 pl-1 font-normal">
      <LookIcon look={look} size="sm" />
      {children}
    </Badge>
  );
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("assistants");
  // Un état inconnu venu de la base ne doit pas faire disparaître la pastille ;
  // on retombe sur le brouillon, l'état le moins engageant.
  const look = ASSISTANT_STATUS_LOOK[status] ?? ASSISTANT_STATUS_LOOK.draft;
  return <StateBadge look={look}>{t(`list.status.${status}` as never)}</StateBadge>;
}

function CompileBadge({ item }: { item: AssistantListItem }) {
  const t = useTranslations("assistants");
  if (!item.everCompiled) {
    return (
      <StateBadge look={ASSISTANT_STATUS_LOOK.compiled_never}>
        {t("list.compiled.never")}
      </StateBadge>
    );
  }
  if (item.needsRecompile) {
    // Le cas qui compte : actif ET périmé. Le texte du prompt n'est plus celui
    // que la fiche affiche — c'est la seule pastille ambre de la carte.
    return (
      <StateBadge look={ASSISTANT_STATUS_LOOK.compiled_stale}>
        {t("list.compiled.stale")}
      </StateBadge>
    );
  }
  return (
    <StateBadge look={ASSISTANT_STATUS_LOOK.compiled_fresh}>{t("list.compiled.fresh")}</StateBadge>
  );
}

function SuiteBadge({ item }: { item: AssistantListItem }) {
  const t = useTranslations("assistants");
  if (!item.everCompiled) return null;
  return item.suitePassed ? (
    <StateBadge look={ASSISTANT_STATUS_LOOK.suite_passed}>{t("list.suite.passed")}</StateBadge>
  ) : (
    <StateBadge look={ASSISTANT_STATUS_LOOK.suite_failed}>{t("list.suite.failed")}</StateBadge>
  );
}
