"use client";

import { CircleAlert, CircleCheck, CircleHelp, TriangleAlert, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Les RÉSERVOIRS : ce qu'il reste sur chacun des trois comptes prépayés.
 *
 * C'est la question que le solde voip.ms posait déjà tout seul dans un coin de
 * la page — « est-ce que je vais tomber en panne d'argent ? » — mais elle n'a
 * de réponse que si les trois comptes sont là : un envoi SMS refusé par Twilio
 * et un assistant muet faute de crédits OpenRouter coûtent aussi cher qu'un
 * appel qui ne part pas.
 *
 * Quatre états, et ils se distinguent VISIBLEMENT parce que sur une page
 * d'argent « je ne sais pas » et « zéro » sont deux nouvelles opposées :
 *
 *  · **indisponible** — le fournisseur n'a pas répondu : « — », pas 0 $ ;
 *  · **négatif** — compte à découvert : c'est la panne, pas son approche ;
 *  · **bas** — sous le seuil du fournisseur ;
 *  · **normal**.
 *
 * L'autonomie (« ~X jours ») se calcule sur la dépense RÉELLE de la période
 * affichée. Elle ne s'affiche que si cette dépense est connue ET non nulle :
 * une autonomie qu'on ne peut pas calculer n'est pas une autonomie infinie.
 */

export type BalanceTile = {
  key: string;
  label: string;
  Icon: LucideIcon;
  /** Solde du fournisseur ($ US), signe conservé. `null` = injoignable. */
  balance: number | null;
  /** Dépense de la période POUR CE COMPTE, ou `null` si la source n'a pas répondu. */
  periodCost: number | null;
  /** Sous ce montant, le compte est annoncé « bas » — propre à chaque fournisseur. */
  lowBelow: number;
};

type Tone = "unknown" | "critical" | "warn" | "ok";

const TONE_ICON: Record<Tone, LucideIcon> = {
  unknown: CircleHelp,
  critical: CircleAlert,
  warn: TriangleAlert,
  ok: CircleCheck,
};

/** La couleur DOUBLE le pictogramme et le mot ; elle ne porte jamais le sens seule. */
const TONE_CLASS: Record<Tone, string> = {
  unknown: "text-muted-foreground",
  critical: "text-destructive",
  warn: "text-amber-600 dark:text-amber-400",
  ok: "text-emerald-600 dark:text-emerald-400",
};

export function BalanceTiles({
  tiles,
  dayCount,
  money,
  loading,
}: {
  tiles: BalanceTile[];
  /** Nombre de jours de la période affichée — le diviseur de l'autonomie. */
  dayCount: number;
  money: (n: number | null) => string;
  loading?: boolean;
}) {
  const t = useTranslations("admin");

  return (
    <section
      className={cn(
        "space-y-2",
        // Rechargement : on GARDE le rendu précédent en retrait plutôt que de
        // le remplacer par des squelettes — pas de saut de mise en page.
        loading && "opacity-60 transition-opacity",
      )}
    >
      <h2 className="text-sm font-semibold">{t("billing.tanksTitle")}</h2>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {tiles.map((tile) => {
        const tone: Tone =
          tile.balance === null
            ? "unknown"
            : tile.balance < 0
              ? "critical"
              : tile.balance < tile.lowBelow
                ? "warn"
                : "ok";
        const ToneIcon = TONE_ICON[tone];

        // L'autonomie : le solde divisé par la dépense QUOTIDIENNE de la
        // période. Inconnue dès qu'il manque une des deux moitiés, ou que la
        // consommation est nulle (diviser par zéro donnerait « infini », ce qui
        // se lirait comme une bonne nouvelle).
        const burnPerDay =
          tile.periodCost !== null && dayCount > 0 ? tile.periodCost / dayCount : null;
        const runwayDays =
          tile.balance !== null && tile.balance > 0 && burnPerDay !== null && burnPerDay > 0
            ? Math.floor(tile.balance / burnPerDay)
            : null;

        return (
          <Card key={tile.key} size="sm" className="shadow-xs">
            <CardContent className="space-y-1">
              <div className="flex items-start justify-between gap-1.5">
                <p className="truncate text-xs text-muted-foreground">{tile.label}</p>
                <tile.Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </div>
              {/* Chiffres proportionnels : une valeur isolée en chasse fixe
                  paraît lâche. Le tableau, lui, reste tabular-nums. */}
              <p className="text-lg font-semibold sm:text-2xl">{money(tile.balance)}</p>
              {/* Ni l'état ni l'autonomie ne se TRONQUENT : sur une tuile de
                  114px, « Solde suffis… » est pire que deux lignes. */}
              <p className={cn("flex items-start gap-1 text-xs", TONE_CLASS[tone])}>
                <ToneIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {tone === "unknown"
                    ? t("billing.balanceUnknown")
                    : tone === "critical"
                      ? t("billing.balanceNegative")
                      : tone === "warn"
                        ? t("billing.balanceLowShort")
                        : t("billing.balanceOk")}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {runwayDays !== null
                  ? t("billing.runwayDays", { days: runwayDays })
                  : t("billing.runwayUnknown")}
              </p>
            </CardContent>
          </Card>
          );
        })}
      </div>
    </section>
  );
}
