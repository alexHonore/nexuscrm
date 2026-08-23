"use client";

import { AlertTriangle, HelpCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext } from "react";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { ResolvedParamDoc } from "@/lib/docs/types";

/**
 * L'aide en ligne d'un paramètre.
 *
 * Le texte vient du registre serveur (surcouches administrateur comprises) et
 * descend par contexte : écrire l'aide dans chaque composant la condamnerait à
 * diverger du schéma. Un champ sans documentation ne s'affiche pas sans aide —
 * il n'existe pas, un test le refuse.
 *
 * La LANGUE est déjà tranchée côté serveur (`getParamDocs(locale)`) : le
 * registre anglais ne descend donc jamais dans le paquet client, et l'aide
 * suit la langue de l'interface — pas celle de l'assistant, qui a la sienne.
 */

export type ParamDocView = ResolvedParamDoc;

const DocsContext = createContext<Record<string, ParamDocView>>({});

export function ParamDocsProvider({
  docs,
  children,
}: {
  docs: Record<string, ParamDocView>;
  children: React.ReactNode;
}) {
  return <DocsContext.Provider value={docs}>{children}</DocsContext.Provider>;
}

export function useParamDoc(path: string): ParamDocView | undefined {
  const docs = useContext(DocsContext);
  return docs[path] ?? docs[path.replace(/\[\d+\]/g, "[]")];
}

/** Bulle d'aide : quoi, pourquoi, effet, et surtout le piège. */
export function ParamHelp({ path }: { path: string }) {
  const t = useTranslations("assistants");
  const doc = useParamDoc(path);
  if (!doc) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            aria-label={`${t("editor.help.show")} — ${doc.label}`}
          />
        }
      >
        <HelpCircle className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3 text-sm">
        <div>
          <p className="font-medium">{doc.label}</p>
          <p className="mt-1 text-muted-foreground">{doc.what}</p>
        </div>
        <Section title={t("editor.help.why")} body={doc.why} />
        {doc.effect ? <Section title={t("editor.help.effect")} body={doc.effect} /> : null}
        {doc.pitfalls ? (
          <div className="rounded-md bg-amber-500/10 p-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-3.5" /> {t("editor.help.pitfalls")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{doc.pitfalls}</p>
          </div>
        ) : null}
        <p className="font-mono text-[11px] text-muted-foreground">{doc.path}</p>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

/** Libellé + bulle d'aide — le couple répété dans tous les onglets. */
export function FieldLabel({
  path,
  htmlFor,
  short,
  after,
  children,
}: {
  path: string;
  htmlFor?: string;
  /**
   * Coupe le préfixe de contexte du libellé (« Objectif principal — durée »
   * devient « Durée »).
   *
   * Le registre qualifie chaque fiche par le cran auquel elle appartient, et
   * c'est juste : la bulle d'aide s'ouvre hors de tout contexte. Dans une carte
   * qui s'intitule DÉJÀ « Objectif principal », le même préfixe se répétait sur
   * huit libellés d'affilée — huit lignes qui commencent par les mêmes trois
   * mots, et l'œil doit aller au bout de chacune pour trouver ce qui diffère.
   */
  short?: boolean;
  /** Élément aligné à droite du libellé (jauge, compteur). */
  after?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const doc = useParamDoc(path);
  const label = doc?.label ?? path;
  return (
    <div className="flex items-center gap-0.5">
      <Label htmlFor={htmlFor}>{children ?? (short ? shortLabel(label) : label)}</Label>
      <ParamHelp path={path} />
      {/* Collé au libellé, pas poussé au bord : une jauge alignée à droite
          d'une colonne large flotte loin du mot qu'elle qualifie. */}
      {after ? <span className="ml-1 flex items-center">{after}</span> : null}
    </div>
  );
}

/**
 * « Objectif principal — nombre de disponibilités offertes » → « Nombre de
 * disponibilités offertes ».
 *
 * Le tiret cadratin entouré d'espaces est la convention du registre ; un
 * libellé qui n'en porte pas ressort intact.
 */
function shortLabel(label: string): string {
  const cut = label.split(" — ");
  if (cut.length < 2) return label;
  const tail = cut.slice(1).join(" — ");
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}
