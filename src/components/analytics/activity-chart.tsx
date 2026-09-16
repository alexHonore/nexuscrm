"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ACTIVITY_KINDS,
  ACTIVITY_VAR,
  ACTIVITY_GRAINS,
  type ActivityGrain,
  type ActivityKind,
} from "@/components/analytics/activity";
import {
  AXIS_TICK,
  CURSOR,
  EmptyState,
  GRID_STROKE,
  type TooltipItem,
} from "@/components/analytics/charts";
import { ACTIVITY_LOOK, LookIcon } from "@/components/look";
import { Button } from "@/components/ui/button";

/**
 * « Activité » — le volume de gestes posés, empilé sur une frise de temps.
 *
 * Les six autres graphiques de la page répondent à « combien » et « par qui ».
 * Celui-ci répond à QUAND : une journée sans appel mais pleine de textos, une
 * semaine où plus personne n'écrit sur les fiches, une plage horaire qu'on
 * n'occupe jamais. La composition compte autant que la hauteur — d'où une pile
 * plutôt que cinq courbes.
 *
 * L'ORDRE des bandes est celui de `ACTIVITY_KINDS`, et il est validé (voir
 * `viz-theme.tsx`) : Recharts empile dans l'ordre de déclaration, donc cet
 * ordre EST l'ordre des paires voisines que le validateur dataviz a mesurées.
 */

// ── La maille de temps ───────────────────────────────────────────────────────

/**
 * Le choix de maille vit dans l'URL, pas dans un état React : les données sont
 * agrégées par Postgres, pas par le navigateur, et une maille qu'on perd en
 * rechargeant est une maille qu'on n'envoie pas à un collègue.
 */
export function ActivityGrainTabs({ grain }: { grain: ActivityGrain }) {
  const t = useTranslations("analytics");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const select = (next: ActivityGrain) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("grain", next);
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <div
      role="group"
      aria-label={t("activity.grainLabel")}
      className="inline-flex rounded-lg border border-border p-0.5"
    >
      {ACTIVITY_GRAINS.map((g) => (
        <Button
          key={g}
          type="button"
          size="sm"
          variant={grain === g ? "secondary" : "ghost"}
          className="h-11 min-w-16 md:h-7"
          aria-pressed={grain === g}
          onClick={() => select(g)}
        >
          {t(`activity.grain.${g}`)}
        </Button>
      ))}
    </div>
  );
}

// ── Le graphique ─────────────────────────────────────────────────────────────

export type ActivityDatum = {
  key: string;
  /** Étiquette d'axe — courte, elle doit tenir sous une barre. */
  label: string;
  /** Étiquette d'infobulle — complète, elle a toute la place. */
  full: string;
} & Record<ActivityKind, number>;

function bucketTotal(d: ActivityDatum): number {
  return ACTIVITY_KINDS.reduce((acc, kind) => acc + d[kind], 0);
}

function ActivityTooltip({
  active,
  payload,
  totalLabel,
  format,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  totalLabel: string;
  format: (n: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload as ActivityDatum | undefined;
  if (!datum) return null;
  // Une bande à zéro n'occupe aucun pixel : la citer allongerait l'infobulle
  // d'une ligne qui n'apprend rien. Le total, lui, est toujours là.
  const shown = payload.filter((item) => Number(item.value ?? 0) !== 0).reverse();
  if (shown.length === 0) return null;

  return (
    <div className="rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <p className="mb-1 font-medium text-muted-foreground">{datum.full}</p>
      {shown.map((item, i) => (
        <div
          key={`${String(item.dataKey ?? item.name)}-${i}`}
          className="flex items-center gap-2 py-0.5"
        >
          <span
            aria-hidden
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: item.color ?? item.fill }}
          />
          <span className="font-semibold tabular-nums">{format(Number(item.value ?? 0))}</span>
          <span className="text-muted-foreground">{item.name}</span>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-2 border-t border-border pt-1">
        <span aria-hidden className="w-3 shrink-0" />
        <span className="font-semibold tabular-nums">{format(bucketTotal(datum))}</span>
        <span className="text-muted-foreground">{totalLabel}</span>
      </div>
    </div>
  );
}

/**
 * La légende CHIFFRÉE — et ce n'est pas une décoration.
 *
 * Deux des cinq teintes passent sous 3:1 sur la surface claire (le jaune des
 * notes, le magenta des fiches) : la règle de compensation dataviz exige alors
 * que les valeurs soient lisibles ailleurs qu'au survol. Elles le sont ici, et
 * chaque famille porte son pictogramme — l'identité ne repose jamais sur la
 * couleur seule.
 */
function ActivityLegend({
  totals,
  grandTotal,
  format,
  formatPct,
}: {
  totals: Record<ActivityKind, number>;
  grandTotal: number;
  format: (n: number) => string;
  formatPct: (n: number) => string;
}) {
  const t = useTranslations("analytics");
  return (
    <ul className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-2 xl:grid-cols-3">
      {ACTIVITY_KINDS.map((kind) => (
        <li key={kind} className="flex items-center gap-2">
          <LookIcon look={ACTIVITY_LOOK[kind]} size="sm" />
          <span className="min-w-0 flex-1 truncate">{t(`activity.kind.${kind}`)}</span>
          <span className="font-medium tabular-nums">{format(totals[kind])}</span>
          <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
            {formatPct(grandTotal > 0 ? totals[kind] / grandTotal : 0)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ActivityChart({
  data,
  locale,
}: {
  data: ActivityDatum[];
  /** La langue de l'INTERFACE — pour les séparateurs de milliers, rien d'autre. */
  locale: string;
}) {
  const t = useTranslations("analytics");
  const tag = locale === "en" ? "en-CA" : "fr-CA";
  const nf = new Intl.NumberFormat(tag);
  const pf = new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 });
  const format = (n: number) => nf.format(n);
  // Intl colle une espace insécable devant « % » dans Chrome et une espace
  // ordinaire dans Node : sans normalisation, le serveur et le client rendent
  // deux chaînes différentes et React refuse l'hydratation.
  const formatPct = (n: number) => pf.format(n).replace(/\s/g, "\u00a0");

  const totals = Object.fromEntries(
    ACTIVITY_KINDS.map((kind) => [kind, data.reduce((acc, d) => acc + d[kind], 0)]),
  ) as Record<ActivityKind, number>;
  const grandTotal = ACTIVITY_KINDS.reduce((acc, kind) => acc + totals[kind], 0);

  // Écart de surface entre segments empilés — il s'efface quand les barres
  // deviennent plus fines que lui, sinon il mange la donnée.
  const gap = data.length <= 20 ? 2 : data.length <= 60 ? 1 : 0;

  // L'axe se resserre quand les étiquettes sont courtes. Le profil de la
  // journée n'a que « 9 h » à écrire : lui imposer l'écart d'une date le
  // réduirait à une heure sur deux, et on ne saurait plus lire la barre qu'on
  // regarde. `minTickGap` reste un MINIMUM — Recharts en saute autant qu'il
  // faut quand l'écran rétrécit.
  const longestLabel = data.reduce((max, d) => Math.max(max, d.label.length), 0);
  const minTickGap = longestLabel <= 6 ? 8 : 32;

  return (
    <div className="flex flex-col gap-3">
      <ActivityLegend
        totals={totals}
        grandTotal={grandTotal}
        format={format}
        formatPct={formatPct}
      />
      <div className="h-72">
        {grandTotal === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={{ stroke: GRID_STROKE }}
                tick={AXIS_TICK}
                minTickGap={minTickGap}
                interval="preserveStartEnd"
              />
              <YAxis
                width={36}
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={AXIS_TICK}
              />
              <Tooltip
                cursor={CURSOR}
                content={
                  <ActivityTooltip totalLabel={t("activity.total")} format={format} />
                }
              />
              {ACTIVITY_KINDS.map((kind, i) => (
                <Bar
                  key={kind}
                  dataKey={kind}
                  name={t(`activity.kind.${kind}`)}
                  stackId="activity"
                  fill={ACTIVITY_VAR[kind]}
                  stroke="var(--card)"
                  strokeWidth={gap}
                  maxBarSize={24}
                  // Seule la bande du dessus s'arrondit : un coin arrondi au
                  // milieu d'une pile creuserait un trou dans la barre.
                  radius={i === ACTIVITY_KINDS.length - 1 ? [4, 4, 0, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
