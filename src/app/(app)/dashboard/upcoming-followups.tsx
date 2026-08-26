"use client";

/**
 * Les suivis des jours qui viennent, sous « En retard » et « À faire
 * aujourd'hui ».
 *
 * Pourquoi un composant client : la carte du tableau de bord doit rester
 * lisible d'un coup d'œil sur un téléphone. Une semaine de relances peut faire
 * quarante lignes — on en montre quelques-unes, le reste se déplie sur place,
 * sans quitter la page ni redemander au serveur (tout est déjà chargé).
 */

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FollowupItem, type FollowupItemData } from "./followup-item";

export type FollowupDayGroup = {
  /** yyyy-MM-dd dans le fuseau de Toronto — sert de clé React et de repère. */
  key: string;
  /** « Demain », puis le jour de la semaine daté. */
  label: string;
  items: FollowupItemData[];
};

/** Suivis à venir montrés avant le bouton de dépliage. */
const COLLAPSED_COUNT = 6;

export function UpcomingFollowups({ groups }: { groups: FollowupDayGroup[] }) {
  const t = useTranslations("dashboard");
  const [expanded, setExpanded] = useState(false);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const hidden = total - COLLAPSED_COUNT;

  // Coupe au fil des journées : un jour partiellement montré garde son en-tête,
  // sinon la première ligne visible flotterait sans date.
  let budget = expanded ? total : COLLAPSED_COUNT;
  const visible: FollowupDayGroup[] = [];
  for (const g of groups) {
    if (budget <= 0) break;
    const items = g.items.slice(0, budget);
    budget -= items.length;
    visible.push({ ...g, items });
  }

  return (
    <div className="space-y-3">
      {visible.map((g) => (
        <div key={g.key} className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground first-letter:uppercase">
            {g.label}
          </p>
          <ul className="space-y-2">
            {g.items.map((item) => (
              <FollowupItem key={item.id} item={item} />
            ))}
          </ul>
        </div>
      ))}

      {hidden > 0 ? (
        <Button
          variant="ghost"
          className="min-h-11 w-full text-xs font-medium text-muted-foreground md:min-h-9"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronUpIcon data-icon="inline-start" />
          ) : (
            <ChevronDownIcon data-icon="inline-start" />
          )}
          {expanded ? t("followups.showLess") : t("followups.showMore", { count: hidden })}
        </Button>
      ) : null}
    </div>
  );
}
