"use client";

import { LockIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext } from "react";
import { cn } from "@/lib/utils";

/**
 * LIRE un assistant sans pouvoir le changer.
 *
 * `admin.assistants` ouvre la porte — la liste, la fiche, le prompt compilé,
 * l'historique des essais ; `admin.assistantsEdit` seul autorise à écrire. Les
 * deux écrans sont donc les MÊMES, à une différence près : sans le second
 * droit, chaque contrôle part désactivé et aucun geste d'écriture n'est offert.
 *
 * Le mécanisme reste celui que l'éditeur emploie déjà pour son état occupé —
 * la prop `disabled` du contrôle, rien d'autre. Ce qui passe par un contexte,
 * c'est seulement la RÉPONSE à « ai-je le droit d'écrire ? » : l'éditeur a
 * douze onglets et trois étages de composants internes (le champ d'un cran
 * d'objectif, une objection dans un paquet), et un booléen passé de main en
 * main à travers vingt signatures s'oublie quelque part. `ParamDocsProvider`,
 * juste à côté, fait descendre l'aide des paramètres de la même façon.
 *
 * Rien ici ne PROTÈGE quoi que ce soit : les routes refusent l'écriture sans le
 * droit. L'écran cesse simplement de proposer ce qui serait refusé.
 */
const CanEditContext = createContext(true);

export function CanEditProvider({
  canEdit,
  children,
}: {
  canEdit: boolean;
  children: React.ReactNode;
}) {
  return <CanEditContext.Provider value={canEdit}>{children}</CanEditContext.Provider>;
}

/** Le droit d'écrire, là où la question se pose : au contrôle. */
export function useCanEdit(): boolean {
  return useContext(CanEditContext);
}

/**
 * Ce qu'on peut faire de cet écran, dit AVANT les champs.
 *
 * Même forme que sur une fiche client fermée (`client-info-form`) : découvrir
 * au moment d'enregistrer qu'on ne pouvait pas est le pire ordre. Le cadenas
 * DOUBLE le libellé, il ne le remplace pas, et ne porte aucune couleur.
 */
export function ReadOnlyNotice({ className }: { className?: string }) {
  const t = useTranslations("assistants");
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground",
        className,
      )}
    >
      <LockIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="font-medium text-foreground">{t("readOnly.title")}</span>
      <span className="min-w-0">{t("readOnly.hint")}</span>
    </p>
  );
}

/**
 * L'enclos des contrôles qu'on ne possède pas.
 *
 * `ModelPicker` est partagé avec l'écran de création et n'expose pas de prop
 * `disabled` : il ne nous appartient pas, on ne le modifie pas pour ce besoin.
 * Un `fieldset` désactivé obtient exactement le même résultat, mais du
 * navigateur — tout champ et tout bouton à l'intérieur devient inerte, et
 * `:disabled` s'y applique comme si la prop avait été posée. À n'employer QUE
 * là : partout ailleurs, le contrôle porte sa propre prop.
 */
export function ReadOnlyFence({ children }: { children: React.ReactNode }) {
  const canEdit = useCanEdit();
  return (
    <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0 disabled:opacity-70">
      {children}
    </fieldset>
  );
}
