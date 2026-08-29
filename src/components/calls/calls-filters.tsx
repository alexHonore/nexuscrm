"use client";

import { PhoneIncoming, PhoneMissed, PhoneOutgoing, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { DispositionOption } from "@/lib/dispositions";
import { cn } from "@/lib/utils";

export type CallsPeriod = "today" | "7" | "30";
export type CallsDirection = "outbound" | "inbound";

/**
 * Filtres de « Mes appels » — tout en pastilles (un seul tap, pas de menu) :
 * période, direction, résultat d'appel (couleurs de src/lib/dispositions.ts).
 * Pilotés par l'URL (searchParams) — le serveur reste la source de vérité.
 */
export function CallsFilters({
  period,
  direction,
  disposition,
  missed,
  dispositionOptions,
}: {
  period: CallsPeriod;
  direction?: CallsDirection;
  disposition?: string;
  missed?: boolean;
  /** « Sans réponse » + statuts du pipeline — préparés côté serveur. */
  dispositionOptions: DispositionOption[];
}) {
  const t = useTranslations("phone");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const apply = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  };

  const chipClass = (active: boolean) =>
    cn(
      // `snap-start` : quand la bande défile, elle s'arrête sur une pastille
      // entière et jamais au milieu d'un libellé.
      "inline-flex h-11 shrink-0 snap-start items-center gap-1.5 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8 md:px-3 md:text-xs",
      active
        ? "border-foreground bg-foreground text-background"
        : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
    );

  const periods: { value: CallsPeriod; label: string }[] = [
    { value: "today", label: t("callsPage.filters.today") },
    { value: "7", label: t("callsPage.filters.last7") },
    { value: "30", label: t("callsPage.filters.last30") },
  ];

  const hasFilters =
    period !== "today" || Boolean(direction) || Boolean(disposition) || Boolean(missed);

  const resetAll = () => apply({ period: null, direction: null, dispo: null, missed: null });

  return (
    <div className="space-y-2">
      {/* Période + direction. Les deux groupes reviennent À LA LIGNE sous md :
          une rangée de pastilles insécables mesure plus large qu'un téléphone,
          et comme rien ici ne rétrécit, c'est la PAGE entière qui partait vers
          la droite — « Manqués » coupé, l'en-tête décalé, un défilement
          horizontal sur tout l'écran. Sur grand écran la rangée tient d'un
          trait : `md:flex-nowrap` lui rend son comportement d'origine. */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t("callsPage.filters.period")}
          className="flex flex-wrap items-center gap-2 md:flex-nowrap"
        >
          {periods.map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={period === p.value}
              className={chipClass(period === p.value)}
              onClick={() => apply({ period: p.value === "today" ? null : p.value })}
            >
              {p.label}
            </button>
          ))}
        </div>

        <span aria-hidden className="hidden h-5 w-px bg-border md:block" />

        <div
          role="group"
          aria-label={t("callsPage.filters.direction")}
          className="flex flex-wrap items-center gap-2 md:flex-nowrap"
        >
          <button
            type="button"
            aria-pressed={!direction}
            className={chipClass(!direction)}
            onClick={() => apply({ direction: null })}
          >
            {t("callsPage.filters.allDirections")}
          </button>
          <button
            type="button"
            aria-pressed={direction === "outbound"}
            className={chipClass(direction === "outbound")}
            // « Sortants » et « Manqués » (entrants par définition) s'excluent.
            onClick={() =>
              apply({ direction: direction === "outbound" ? null : "outbound", missed: null })
            }
          >
            <PhoneOutgoing
              aria-hidden
              className={cn(
                "size-3.5",
                direction !== "outbound" && "text-emerald-600 dark:text-emerald-500",
              )}
            />
            {t("callsPage.filters.outbound")}
          </button>
          <button
            type="button"
            aria-pressed={direction === "inbound"}
            className={chipClass(direction === "inbound")}
            onClick={() => apply({ direction: direction === "inbound" ? null : "inbound" })}
          >
            <PhoneIncoming
              aria-hidden
              className={cn(
                "size-3.5",
                direction !== "inbound" && "text-blue-600 dark:text-blue-400",
              )}
            />
            {t("callsPage.filters.inbound")}
          </button>
          <button
            type="button"
            aria-pressed={Boolean(missed)}
            className={chipClass(Boolean(missed))}
            onClick={() =>
              apply({
                missed: missed ? null : "1",
                ...(direction === "outbound" ? { direction: null } : {}),
              })
            }
          >
            <PhoneMissed
              aria-hidden
              className={cn("size-3.5", !missed && "text-red-600 dark:text-red-400")}
            />
            {t("callsPage.filters.missed")}
          </button>
        </div>

        {/* « Réinitialiser » vit au bout de la bande des résultats d'appel :
            sur grand écran elle se déplie et le bouton se voit, mais sur un
            téléphone cette bande défile et le bouton se retrouve douze
            pastilles plus loin — atteignable en théorie, jamais en pratique.
            Le même geste est donc rendu ICI, avec les filtres qui reviennent à
            la ligne, et l'exemplaire de la bande s'efface sous md. Deux boutons
            dans le DOM, jamais deux à l'écran. */}
        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 shrink-0 rounded-full md:hidden"
            onClick={resetAll}
          >
            <XIcon className="size-4" />
            {t("callsPage.filters.reset")}
          </Button>
        ) : null}
      </div>

      {/*
        Résultats d'appel — dix-sept pastilles pour 360 px de large.

        La bande défile horizontalement sur téléphone, mais elle le faisait en
        AVEUGLE : coupée net au bord droit, sans dégradé ni accroche, douze
        dispositions vivaient hors de l'écran sans que rien ne le laisse
        deviner. Le dégradé de masque est l'idiome déjà employé par la liste
        des fiches (clients-workspace) : le bord s'estompe, donc l'œil
        comprend que ça continue. `snap` arrête le défilement sur une pastille
        entière plutôt qu'au milieu d'un mot.

        Tout est en `max-md:` : à partir de `md:` la bande redevient un
        `flex-wrap` sans masque, exactement comme avant.
      */}
      <div
        role="group"
        aria-label={t("callsPage.filters.disposition")}
        className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 max-md:snap-x max-md:snap-mandatory max-md:[mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)] max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0"
      >
        {dispositionOptions.map((o) => {
          const active = disposition === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              className={chipClass(active)}
              onClick={() => apply({ dispo: active ? null : o.value })}
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full ring-1 ring-foreground/10"
                style={{ background: o.color }}
              />
              {o.label}
            </button>
          );
        })}

        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 shrink-0 rounded-full max-md:hidden md:h-8"
            onClick={resetAll}
          >
            <XIcon className="size-4" />
            {t("callsPage.filters.reset")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
