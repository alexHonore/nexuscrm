"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ACTIVITY_FORMS,
  ACTIVITY_GRAINS,
  ACTIVITY_KINDS,
  ACTIVITY_VAR,
  movingAverage,
  trendWindow,
  type ActivityForm,
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
import { ACTIVITY_LOOK, CHART_FORM_LOOK, LookGlyph, LookIcon } from "@/components/look";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * « Activité » — le volume de gestes posés, sur une frise de temps.
 *
 * Les six autres graphiques de la page répondent à « combien » et « par qui ».
 * Celui-ci répond à QUAND : une journée sans appel mais pleine de textos, une
 * semaine où plus personne n'écrit sur les fiches, une plage horaire qu'on
 * n'occupe jamais.
 *
 * SIX FORMES, une seule donnée. Changer de forme change la QUESTION, pas le
 * jeu de chiffres : la légende chiffrée ne bouge jamais d'une forme à l'autre,
 * pour qu'on puisse comparer deux dessins sans relire les totaux. Ce que
 * chaque forme raconte est documenté sur `ACTIVITY_FORMS` (`activity.ts`).
 *
 * L'ORDRE des séries est celui de `ACTIVITY_KINDS`, et il est validé (voir
 * `viz-theme.tsx`) : empilement comme tracé suivent l'ordre de déclaration,
 * donc cet ordre EST celui des paires voisines mesurées par le validateur
 * dataviz. Il vaut pour la pile, l'aire, la part et l'anneau.
 */

// ── Les deux commandes ───────────────────────────────────────────────────────

/** Écrit un paramètre dans l'URL sans toucher aux autres ni remonter la page. */
function useParamWriter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  return (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  };
}

/**
 * La maille de temps.
 *
 * Elle vit dans l'URL, pas dans un état React : les données sont agrégées par
 * Postgres, pas par le navigateur, et une maille qu'on perd en rechargeant est
 * une maille qu'on n'envoie pas à un collègue.
 *
 * `disabled` quand la forme choisie n'a pas d'axe de temps (l'anneau) : les
 * boutons restent à leur place, éteints. Les faire disparaître ferait douter
 * de ce qu'on vient de cliquer.
 */
export function ActivityGrainTabs({
  grain,
  disabled = false,
}: {
  grain: ActivityGrain;
  disabled?: boolean;
}) {
  const t = useTranslations("analytics");
  const write = useParamWriter();

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
          variant={grain === g && !disabled ? "secondary" : "ghost"}
          className="h-11 min-w-16 md:h-7"
          aria-pressed={grain === g}
          disabled={disabled}
          onClick={() => write("grain", g)}
        >
          {t(`activity.grain.${g}`)}
        </Button>
      ))}
    </div>
  );
}

/**
 * La forme du graphique.
 *
 * Un menu plutôt que six boutons de plus : la rangée de commandes en porte
 * déjà trois (la maille) et la carte n'est pas un cockpit. Chaque entrée porte
 * son pictogramme — c'est lui qui identifie la forme, le libellé qui la nomme.
 */
export function ActivityFormSelect({ form }: { form: ActivityForm }) {
  const t = useTranslations("analytics");
  const write = useParamWriter();

  return (
    <Select
      value={form}
      onValueChange={(value) => {
        if (typeof value === "string") write("form", value);
      }}
    >
      <SelectTrigger aria-label={t("activity.formLabel")} className="min-h-11 md:min-h-0">
        <SelectValue>
          {() => (
            <>
              <LookGlyph look={CHART_FORM_LOOK[form]} />
              {t(`activity.form.${form}`)}
            </>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ACTIVITY_FORMS.map((f) => (
          <SelectItem key={f} value={f}>
            <LookGlyph look={CHART_FORM_LOOK[f]} />
            {t(`activity.form.${f}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── La donnée ────────────────────────────────────────────────────────────────

export type ActivityDatum = {
  key: string;
  /** Étiquette d'axe — courte, elle doit tenir sous une barre. */
  label: string;
  /** Étiquette d'infobulle — complète, elle a toute la place. */
  full: string;
} & Record<ActivityKind, number>;

/** La donnée d'une case, augmentée de la tendance (forme `combo` seulement). */
type ComboDatum = ActivityDatum & { trend: number };

function bucketTotal(d: ActivityDatum): number {
  return ACTIVITY_KINDS.reduce((acc, kind) => acc + d[kind], 0);
}

// ── Infobulle ────────────────────────────────────────────────────────────────

/**
 * Une seule infobulle pour les cinq formes temporelles.
 *
 * En mode `share`, Recharts normalise le DESSIN (`stackOffset="expand"`) mais
 * garde les valeurs d'origine dans la charge utile : l'infobulle peut donc
 * montrer le décompte ET la part, là où l'axe ne montre que la part.
 */
function ActivityTooltip({
  active,
  payload,
  totalLabel,
  trendLabel,
  share,
  format,
  formatPct,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  totalLabel: string;
  trendLabel: string;
  share: boolean;
  format: (n: number) => string;
  formatPct: (n: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload as ActivityDatum | undefined;
  if (!datum) return null;

  const total = bucketTotal(datum);
  // La tendance n'est pas une famille : elle se lit sous le total, pas au
  // milieu de la composition.
  const trend = payload.find((item) => item.dataKey === "trend");
  // Une bande à zéro n'occupe aucun pixel : la citer allongerait l'infobulle
  // d'une ligne qui n'apprend rien. Le total, lui, est toujours là.
  const shown = payload
    .filter((item) => item.dataKey !== "trend" && Number(item.value ?? 0) !== 0)
    .reverse();
  if (shown.length === 0 && !trend) return null;

  return (
    <div className="rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <p className="mb-1 font-medium text-muted-foreground">{datum.full}</p>
      {shown.map((item, i) => {
        const value = Number(item.value ?? 0);
        return (
          <div
            key={`${String(item.dataKey ?? item.name)}-${i}`}
            className="flex items-center gap-2 py-0.5"
          >
            <span
              aria-hidden
              className="h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: item.color ?? item.fill }}
            />
            <span className="font-semibold tabular-nums">
              {format(value)}
              {share && total > 0 ? ` · ${formatPct(value / total)}` : ""}
            </span>
            <span className="text-muted-foreground">{item.name}</span>
          </div>
        );
      })}
      <div className="mt-1 flex items-center gap-2 border-t border-border pt-1">
        <span aria-hidden className="w-3 shrink-0" />
        <span className="font-semibold tabular-nums">{format(total)}</span>
        <span className="text-muted-foreground">{totalLabel}</span>
      </div>
      {trend ? (
        <div className="flex items-center gap-2 py-0.5">
          <span
            aria-hidden
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: trend.color ?? trend.fill }}
          />
          <span className="font-semibold tabular-nums">
            {format(Math.round(Number(trend.value ?? 0)))}
          </span>
          <span className="text-muted-foreground">{trendLabel}</span>
        </div>
      ) : null}
    </div>
  );
}

function DonutTooltip({
  active,
  payload,
  format,
  formatPct,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  format: (n: number) => string;
  formatPct: (n: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0];
  const datum = item.payload as { share?: number } | undefined;
  return (
    <div className="rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-0.5 w-3 shrink-0 rounded-full"
          style={{ background: item.fill ?? item.color }}
        />
        <span className="font-semibold tabular-nums">
          {format(Number(item.value ?? 0))}
          {datum?.share !== undefined ? ` · ${formatPct(datum.share)}` : ""}
        </span>
        <span className="text-muted-foreground">{item.name}</span>
      </div>
    </div>
  );
}

// ── Légende ──────────────────────────────────────────────────────────────────

/**
 * La légende CHIFFRÉE — et ce n'est pas une décoration.
 *
 * Deux des cinq teintes passent sous 3:1 sur la surface claire (le jaune des
 * notes, le magenta des fiches) : la règle de compensation dataviz exige alors
 * que les valeurs soient lisibles ailleurs qu'au survol. Elles le sont ici, et
 * chaque famille porte son pictogramme — l'identité ne repose jamais sur la
 * couleur seule.
 *
 * Elle est IDENTIQUE pour les six formes, et c'est le point : on change de
 * dessin sans que les chiffres ne se déplacent sous les yeux.
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

// ── Le graphique ─────────────────────────────────────────────────────────────

export function ActivityChart({
  data,
  form,
  locale,
}: {
  data: ActivityDatum[];
  form: ActivityForm;
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
  const formatPct = (n: number) => pf.format(n).replace(/\s/g, " ");

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

  // Les axes sont les mêmes pour les cinq formes temporelles. Ils restent des
  // ENFANTS DIRECTS du graphique — Recharts inspecte ses enfants par type et ne
  // traverse pas un fragment — d'où des objets de props plutôt qu'un fragment
  // partagé.
  const gridProps = { vertical: false, stroke: GRID_STROKE } as const;
  const xAxisProps = {
    dataKey: "label",
    tickLine: false,
    axisLine: { stroke: GRID_STROKE },
    tick: AXIS_TICK,
    minTickGap,
    interval: "preserveStartEnd",
  } as const;
  const yAxisProps = {
    width: 36,
    allowDecimals: false,
    tickLine: false,
    axisLine: false,
    tick: AXIS_TICK,
    // Un peu d'air au-dessus du maximum. Sans lui, Recharts fait finir l'axe
    // EXACTEMENT sur la plus grande valeur : la série la plus haute se dessine
    // alors sur la graduation du sommet, et une ligne collée au bord du cadre
    // se lit comme une ligne COUPÉE — on croit que le graphique tronque ce
    // qu'il n'a pas la place de montrer.
    domain: [0, (dataMax: number) => Math.max(1, Math.ceil(dataMax * 1.08))],
  } as const;
  const margin = { top: 4, right: 4, bottom: 0, left: 0 } as const;

  const tooltip = (
    <Tooltip
      cursor={CURSOR}
      content={
        <ActivityTooltip
          totalLabel={t("activity.total")}
          trendLabel={t("activity.trend")}
          share={form === "share"}
          format={format}
          formatPct={formatPct}
        />
      }
    />
  );

  function plot() {
    switch (form) {
      // ── Aires empilées ────────────────────────────────────────────────────
      case "area":
        return (
          <AreaChart data={data} margin={margin}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            {tooltip}
            {ACTIVITY_KINDS.map((kind) => (
              <Area
                key={kind}
                // `linear`, jamais `monotone` : une courbe entre deux jours
                // MESURÉS invente les valeurs du milieu. Sur cette donnée, le
                // lissage changeait la chute du vendredi soir en pente douce —
                // on lisait un ralentissement là où il y a un arrêt. La seule
                // courbe lissée de la carte est la TENDANCE de `combo`, et
                // c'est un lissage assumé, annoncé par son nom.
                type="linear"
                dataKey={kind}
                name={t(`activity.kind.${kind}`)}
                stackId="activity"
                fill={ACTIVITY_VAR[kind]}
                fillOpacity={1}
                // Le trait est de la couleur de la SURFACE, pas de la série :
                // c'est l'écart de 2 px entre deux aires empilées, pas un
                // contour. Un contour coloré ferait une sixième couleur.
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        );

      // ── Part de chaque famille (100 %) ────────────────────────────────────
      case "share":
        return (
          // `expand` normalise chaque case à 1 — Recharts garde les valeurs
          // d'origine dans la charge utile de l'infobulle.
          <AreaChart data={data} margin={margin} stackOffset="expand">
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            {/* Graduations explicites : `allowDecimals: false` sur un domaine
                0–1 ne laisse passer que 0 et 1, et l'axe ne gradue plus rien. */}
            <YAxis
              {...yAxisProps}
              width={44}
              domain={[0, 1]}
              allowDecimals
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v: number) => formatPct(v)}
            />
            {tooltip}
            {ACTIVITY_KINDS.map((kind) => (
              <Area
                key={kind}
                type="linear"
                dataKey={kind}
                name={t(`activity.kind.${kind}`)}
                stackId="activity"
                fill={ACTIVITY_VAR[kind]}
                fillOpacity={1}
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        );

      // ── Lignes (les familles comparées entre elles) ───────────────────────
      case "line":
        return (
          <LineChart data={data} margin={margin}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            {tooltip}
            {ACTIVITY_KINDS.map((kind) => (
              <Line
                key={kind}
                type="linear"
                dataKey={kind}
                name={t(`activity.kind.${kind}`)}
                stroke={ACTIVITY_VAR[kind]}
                strokeWidth={2}
                // Un point par case ne se lit qu'en petit nombre ; au-delà, la
                // ligne EST la donnée et les points la couvrent.
                dot={data.length <= 20 ? { r: 3, strokeWidth: 0 } : false}
                activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        );

      // ── Colonnes + tendance ───────────────────────────────────────────────
      case "combo": {
        const span = trendWindow(data.length);
        const trend = movingAverage(data.map(bucketTotal), span);
        const comboData: ComboDatum[] = data.map((d, i) => ({ ...d, trend: trend[i] }));
        return (
          <ComposedChart data={comboData} margin={margin}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            {tooltip}
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
                radius={i === ACTIVITY_KINDS.length - 1 ? [4, 4, 0, 0] : undefined}
                isAnimationActive={false}
              />
            ))}
            {/* La tendance est le TOTAL lissé : même axe, même unité que les
                colonnes. Jamais un second axe Y — deux échelles alignées à la
                main inventent une corrélation absente des données. Son gris
                est celui du « mis en retrait » : elle commente la pile, elle
                n'est pas une sixième famille. */}
            <Line
              type="monotone"
              dataKey="trend"
              name={t("activity.trend")}
              stroke="var(--viz-deemph)"
              strokeWidth={2}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        );
      }

      // ── Anneau (toute la période, sans axe de temps) ──────────────────────
      case "donut": {
        const slices = ACTIVITY_KINDS.filter((kind) => totals[kind] > 0).map((kind) => ({
          kind,
          label: t(`activity.kind.${kind}`),
          value: totals[kind],
          share: grandTotal > 0 ? totals[kind] / grandTotal : 0,
        }));
        return (
          <PieChart>
            <Tooltip content={<DonutTooltip format={format} formatPct={formatPct} />} />
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="58%"
              outerRadius="88%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={1.5}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.kind} fill={ACTIVITY_VAR[s.kind]} />
              ))}
            </Pie>
          </PieChart>
        );
      }

      // ── Barres empilées (la forme par défaut) ─────────────────────────────
      default:
        return (
          <BarChart data={data} margin={margin}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            {tooltip}
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
        );
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ActivityLegend
        totals={totals}
        grandTotal={grandTotal}
        format={format}
        formatPct={formatPct}
      />
      {/* L'anneau est carré : lui donner la largeur d'une frise l'étirerait en
          un disque perdu au milieu du vide. */}
      <div className={form === "donut" ? "relative mx-auto h-72 w-72" : "h-72"}>
        {grandTotal === 0 ? (
          <EmptyState />
        ) : (
          <>
            <ResponsiveContainer width="100%" height="100%">
              {plot()}
            </ResponsiveContainer>
            {form === "donut" ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-semibold tabular-nums">{format(grandTotal)}</span>
                <span className="text-xs text-muted-foreground">{t("activity.total")}</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
