"use client";

import { useTranslations } from "next-intl";
import { LookIcon, lookTint, type Look } from "@/components/look";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * La charpente des onglets de l'éditeur.
 *
 * Douze onglets réglaient l'assistant en douze murs de champs : un libellé, un
 * contrôle, un libellé, un contrôle, sur toute la hauteur de la page. Rien ne
 * disait de quoi l'onglet parlait avant d'avoir lu ses champs, ni quels champs
 * allaient ensemble. Trois pièces suffisent à le dire :
 *
 * - `TabHead` — ce que règle CET onglet, une fois, en haut ;
 * - `Panel` — une carte par sujet, avec son titre ;
 * - `Fields` — la grille commune, pour que deux onglets voisins aient la même
 *   gouttière et la même colonne.
 *
 * Aucune chaîne n'est écrite ici : les titres viennent de l'appelant, donc du
 * namespace `assistants`.
 */

/** L'en-tête d'un onglet : ce qu'on règle ici, et pourquoi. */
export function TabHead({
  look,
  title,
  hint,
  actions,
}: {
  look: Look;
  title: string;
  hint?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
      <LookIcon look={look} size="lg" />
      <div className="min-w-0 flex-1">
        <h2 className="font-heading text-lg font-semibold tracking-tight">{title}</h2>
        {hint ? <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Une carte de réglages — un sujet, un titre, ses champs.
 *
 * `look` teinte le filet de gauche à la couleur de la famille : sur une pile
 * de quatre cartes, il rappelle sans être lu qu'on est toujours dans « ce que
 * l'assistant dit » ou déjà dans « ce qui le vérifie ».
 */
export function Panel({
  title,
  description,
  look,
  actions,
  children,
  className,
  contentClassName,
}: {
  title?: string;
  description?: string;
  look?: Look;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card
      className={cn("gap-4", className)}
      style={look ? { borderLeft: `3px solid ${lookTint(look).borderColor}` } : undefined}
    >
      {title ? (
        <CardHeader className="gap-1">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1">
              <CardTitle>{title}</CardTitle>
              {description ? (
                <p className="mt-1 text-sm text-muted-foreground">{description}</p>
              ) : null}
            </div>
            {actions ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
            ) : null}
          </div>
        </CardHeader>
      ) : null}
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

/**
 * La grille des champs.
 *
 * Une colonne sous `md`, deux au-delà. Un champ occupe toute la largeur avec
 * `className="md:col-span-2"` — c'est ce qu'on veut pour une zone de texte, et
 * jamais pour un nombre à deux chiffres.
 */
export function Fields({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("grid gap-x-4 gap-y-4 md:grid-cols-2", className)}>{children}</div>;
}

/** Un champ qui prend les deux colonnes — nom explicite plutôt qu'une classe répétée. */
export function WideField({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("space-y-1.5 md:col-span-2", className)}>{children}</div>;
}

/**
 * Une note de bas de champ.
 *
 * Le même gris, la même taille et le même écart partout : trois onglets
 * écrivaient la leur avec trois classes différentes.
 */
export function FieldNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/**
 * Une ligne « libellé à gauche, interrupteur à droite ».
 *
 * Le motif revenait dans quatre onglets, écrit quatre fois, avec quatre
 * bordures et quatre écarts différents.
 */
export function ToggleRow({
  children,
  control,
  className,
}: {
  children: React.ReactNode;
  control: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-11 items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/** L'état vide d'une liste, à l'intérieur d'une carte. */
export function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * L'aide de l'onglet courant, traduite.
 *
 * Chaque onglet appelle `useTabHead("goal")` plutôt que d'écrire deux clés :
 * le couple titre/aide est toujours le même, et une aide manquante se voit à
 * la relecture du fichier de messages, pas au hasard d'un écran.
 */
export function useTabHead(id: string): { title: string; hint: string } {
  const t = useTranslations("assistants");
  return { title: t(`editor.tabs.${id}` as never), hint: t(`editor.tabHint.${id}` as never) };
}
