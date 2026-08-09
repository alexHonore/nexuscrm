"use client";

import { PhoneIncoming, PhoneMissed, PhoneOutgoing, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DISPOSITION_CONFIG, DISPOSITION_ORDER } from "@/lib/dispositions";
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
}: {
  period: CallsPeriod;
  direction?: CallsDirection;
  disposition?: string;
  missed?: boolean;
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
      "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8 md:px-3 md:text-xs",
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

  return (
    <div className="space-y-2">
      {/* Période + direction */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label={t("callsPage.filters.period")}
          className="flex items-center gap-2"
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
          className="flex items-center gap-2"
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
      </div>

      {/* Résultats d'appel — pastilles colorées, défilement horizontal sur mobile */}
      <div
        role="group"
        aria-label={t("callsPage.filters.disposition")}
        className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0"
      >
        {DISPOSITION_ORDER.map((d) => {
          const active = disposition === d;
          return (
            <button
              key={d}
              type="button"
              aria-pressed={active}
              className={chipClass(active)}
              onClick={() => apply({ dispo: active ? null : d })}
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full ring-1 ring-foreground/10"
                style={{ background: DISPOSITION_CONFIG[d].color }}
              />
              {t(`disposition.options.${d}`)}
            </button>
          );
        })}

        {hasFilters ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 shrink-0 rounded-full md:h-8"
            onClick={() => apply({ period: null, direction: null, dispo: null, missed: null })}
          >
            <XIcon className="size-4" />
            {t("callsPage.filters.reset")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
