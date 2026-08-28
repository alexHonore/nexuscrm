"use client";

import { useTranslations } from "next-intl";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Graphiques de la page de consommation.
 *
 * Trois règles tiennent ce fichier, et ce sont les mêmes que pour l'analytique
 * (`src/components/analytics/charts.tsx`) :
 *
 * 1. **Aucune couleur en dur.** Tout passe par les variables `--viz-*` du
 *    conteneur `.nx-viz` — la page DOIT porter cette classe et monter
 *    `<VizTheme />`, sinon les barres sont invisibles.
 * 2. **La couleur ne porte jamais le sens toute seule.** Chaque graphique à
 *    deux séries ou plus a sa légende CHIFFRÉE, et un tableau double les
 *    valeurs : rien n'est accessible uniquement au survol.
 * 3. **« Indisponible » ne se dessine pas comme « zéro ».** Une source qui n'a
 *    pas répondu sort de la pile et reçoit une pastille creuse en pointillé
 *    dans la légende — jamais une bande plate à zéro, qui se lirait comme une
 *    dépense nulle sur une page d'argent.
 */

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 11 } as const;
const NAME_TICK = { fill: "var(--foreground)", fontSize: 12 } as const;
const GRID_STROKE = "var(--border)";
const CURSOR = { fill: "var(--muted)", opacity: 0.6 } as const;

/** Les quatre sources de dépense, DANS L'ORDRE DE LA PILE (voir viz-theme.tsx). */
export const SPEND_SOURCES = ["sms", "telephony", "ai", "notes"] as const;
export type SpendSource = (typeof SPEND_SOURCES)[number];

export const SOURCE_VAR: Record<SpendSource, string> = {
  sms: "var(--viz-src-sms)",
  telephony: "var(--viz-src-telephony)",
  ai: "var(--viz-src-ai)",
  notes: "var(--viz-src-notes)",
};

// ── Pièces communes ──────────────────────────────────────────────────────────

type TooltipItem = {
  name?: string | number;
  value?: number | string;
  color?: string;
  fill?: string;
  dataKey?: string | number;
};

function VizTooltip({
  active,
  payload,
  label,
  format,
  unit,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: string | number;
  /** Mise en forme d'une valeur — argent ou compte, jamais deviné ici. */
  format: (n: number) => string;
  unit?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  // Une bande à zéro n'a rien à dire dans l'infobulle : elle n'occupe aucun
  // pixel, la citer donnerait une liste de « 0,00 » plus longue que la donnée.
  const shown = payload.filter((item) => Number(item.value ?? 0) !== 0);
  if (shown.length === 0) return null;
  return (
    <div className="rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      {label !== undefined && label !== "" ? (
        <p className="mb-1 font-medium text-muted-foreground">{label}</p>
      ) : null}
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
          <span className="font-semibold tabular-nums">
            {format(Number(item.value ?? 0))}
            {unit ? ` ${unit}` : ""}
          </span>
          <span className="text-muted-foreground">{item.name}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Légende CHIFFRÉE — le canal d'identité et de valeurs.
 *
 * `value === null` veut dire « cette source n'a pas répondu » : la pastille
 * devient creuse et pointillée, et le montant cède la place au mot. Deux objets
 * visiblement différents, jamais deux façons d'écrire zéro.
 */
export function ValueLegend({
  items,
  className,
}: {
  items: {
    key: string;
    color: string;
    label: string;
    value: string | null;
    extra?: string;
    /** Ce que dit la ligne à la place du montant quand `value` est null. */
    unavailableLabel?: string;
  }[];
  className?: string;
}) {
  const t = useTranslations("admin");
  return (
    <ul className={className ?? "flex flex-wrap gap-x-4 gap-y-1 text-xs"}>
      {items.map((item) => (
        <li key={item.key} className="flex min-w-0 items-center gap-1.5">
          {item.value === null ? (
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[3px] border border-dashed border-muted-foreground/70"
            />
          ) : (
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-foreground/10"
              style={{ background: item.color }}
            />
          )}
          <span className="truncate text-muted-foreground">{item.label}</span>
          <span
            className={
              item.value === null
                ? "text-muted-foreground italic"
                : "font-semibold tabular-nums text-foreground"
            }
          >
            {item.value ?? item.unavailableLabel ?? t("billing.sourceUnavailable")}
          </span>
          {item.extra ? <span className="text-muted-foreground">{item.extra}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Le PLAFOND de l'axe, arrondi à un chiffre rond.
 *
 * Laissé à lui-même, recharts borne l'axe sur le maximum exact et gradue en
 * quarts : « 0,95 · 1,90 · 2,85 · 3,80 ». Des graduations qu'on doit lire
 * chiffre par chiffre ne servent à rien — on veut 0 · 1 · 2 · 3 · 4. Les pas
 * retenus se divisent tous proprement par quatre.
 */
const NICE_STEPS = [1, 2, 3, 4, 5, 6, 8, 10];

export function niceCeil(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const scaled = max / magnitude;
  const step = NICE_STEPS.find((s) => scaled <= s + 1e-9) ?? 10;
  return step * magnitude;
}

/**
 * Les cinq graduations, CALCULÉES ICI.
 *
 * Laisser `tickCount` à recharts ne suffit pas : il re-arrondit pour son compte
 * et finit par poser deux étiquettes l'une sur l'autre (« 0,45 » sous
 * « 0,50 »). Le plafond étant déjà rond, les quarts le sont aussi.
 */
function niceTicks(max: number): number[] {
  const top = niceCeil(max);
  return [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
}

function NoData({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-24 items-center justify-center rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

// ── Répartition de la dépense (part-à-tout) ─────────────────────────────────

export type ShareDatum = {
  key: SpendSource;
  label: string;
  /** null = source injoignable — elle n'a AUCUN segment, et la légende le dit. */
  amount: number | null;
};

/**
 * Barre unique 100 % empilée : « où est parti l'argent ».
 *
 * Pas un camembert — quatre parts dont deux sont souvent proches se comparent
 * mal sur un disque, et un anneau coûte deux fois la hauteur pour la même
 * information. La barre sert AUSSI de clé de couleurs de toute la page : elle
 * nomme les quatre teintes avant que le graphique des journées les emploie.
 */
export function SpendShareBar({
  data,
  money,
  complete,
  className,
}: {
  data: ShareDatum[];
  money: (n: number | null) => string;
  /**
   * Toutes les sources ont répondu.
   *
   * Sinon NI barre NI pourcentage : une part se calcule contre un tout, et un
   * tout amputé d'une source gonfle mécaniquement les autres — le SMS passerait
   * de 35 % à 76 % du seul fait que la téléphonie n'a pas répondu. Les MONTANTS
   * connus restent affichés ; c'est la proportion qui est indéfendable.
   */
  complete: boolean;
  className?: string;
}) {
  const t = useTranslations("admin");
  const total = data.reduce((acc, d) => acc + (d.amount ?? 0), 0);

  return (
    <div className={className ?? "space-y-2"}>
      {complete && total > 0 ? (
        <div
          className="flex h-2.5 gap-[2px] overflow-hidden rounded-full"
          role="img"
          aria-label={t("billing.shareAria")}
        >
          {data
            .filter((d) => (d.amount ?? 0) > 0)
            .map((d) => (
              <span
                key={d.key}
                // Un plancher de 3px : une part minuscule doit rester VISIBLE,
                // sinon la légende annonce une couleur qu'on ne trouve pas.
                style={{
                  background: SOURCE_VAR[d.key],
                  width: `${((d.amount ?? 0) / total) * 100}%`,
                  minWidth: 3,
                }}
              />
            ))}
        </div>
      ) : null}
      <ValueLegend
        items={data.map((d) => ({
          key: d.key,
          color: SOURCE_VAR[d.key],
          label: d.label,
          value: d.amount === null ? null : money(d.amount),
          extra:
            complete && d.amount !== null && total > 0
              ? `· ${Math.round((d.amount / total) * 100)} %`
              : undefined,
        }))}
      />
    </div>
  );
}

// ── Dépense par jour, par source ─────────────────────────────────────────────

export type SpendDayDatum = {
  key: string;
  label: string;
  sms: number;
  telephony: number;
  ai: number;
  notes: number;
  total: number;
  /** Étiquette directe — remplie POUR LA SEULE journée la plus chère, sinon "". */
  peakLabel: string;
};

/**
 * Barres empilées : une colonne par journée, quatre segments par colonne.
 *
 * Un seul axe d'argent : jamais deux échelles sur un même graphique. Les
 * sources injoignables sortent de la pile (elles seraient sinon dessinées à
 * zéro) et la légende les nomme « indisponible ».
 */
export function SpendPerDayChart({
  data,
  labels,
  available,
  money,
  moneyAxis,
  totals,
  height = 240,
}: {
  data: SpendDayDatum[];
  labels: Record<SpendSource, string>;
  available: Record<SpendSource, boolean>;
  money: (n: number | null) => string;
  /**
   * Mise en forme des GRADUATIONS : deux décimales fixes donnent cinq
   * « 0,00 » identiques sur une période à quelques centimes. L'axe garde
   * autant de décimales qu'il en faut, et pas plus.
   */
  moneyAxis: (n: number) => string;
  /**
   * Montants de la PÉRIODE — les mêmes que le total du haut, pas une somme
   * recalculée : un graphique et un grand chiffre qui se contredisent d'un
   * centime coûtent plus cher que la précision qu'ils prétendent gagner.
   */
  totals: Record<SpendSource, number | null>;
  height?: number;
}) {
  const t = useTranslations("admin");
  const drawn = SPEND_SOURCES.filter((s) => available[s]);
  const grandTotal = data.reduce((acc, d) => acc + d.total, 0);
  // Trois raisons de ne rien dessiner, et elles ne se disent pas pareil :
  // aucune source n'a répondu · une seule journée · rien dépensé.
  const reason =
    drawn.length === 0
      ? t("billing.chartUnavailable")
      : data.length < 2
        ? t("billing.chartOneDay")
        : grandTotal === 0
          ? t("billing.chartEmpty")
          : null;
  // L'écart de surface s'efface quand les colonnes deviennent trop fines pour
  // le porter : à 2px sur une barre de 4px, il mangerait la donnée.
  const gap = data.length <= 20 ? 2 : data.length <= 45 ? 1 : 0;

  return (
    <div className="space-y-3">
      <ValueLegend
        items={SPEND_SOURCES.map((s) => ({
          key: s,
          color: SOURCE_VAR[s],
          label: labels[s],
          // Une source non DESSINÉE peut quand même avoir un montant connu pour
          // la période (le coût SMS existe même sans son détail par journée) :
          // dire « indisponible » ferait alors contredire ce graphique par le
          // total juste au-dessus. Deux manques, deux phrases.
          value: available[s] ? money(totals[s] ?? 0) : null,
          unavailableLabel:
            !available[s] && totals[s] !== null ? t("billing.noDailyDetail") : undefined,
        }))}
      />
      {reason ? (
        <NoData>{reason}</NoData>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 16, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={{ stroke: GRID_STROKE }}
                tick={AXIS_TICK}
                minTickGap={24}
                interval="preserveStartEnd"
              />
              <YAxis
                width={48}
                domain={[0, niceCeil(Math.max(...data.map((d) => d.total)))]}
                ticks={niceTicks(Math.max(...data.map((d) => d.total)))}
                tickLine={false}
                axisLine={false}
                tick={AXIS_TICK}
                tickFormatter={(v: number) => moneyAxis(v)}
              />
              <Tooltip cursor={CURSOR} content={<VizTooltip format={(n) => money(n)} />} />
              {drawn.map((source, i) => (
                <Bar
                  key={source}
                  dataKey={source}
                  name={labels[source]}
                  stackId="spend"
                  fill={SOURCE_VAR[source]}
                  stroke="var(--card)"
                  strokeWidth={gap}
                  maxBarSize={24}
                  isAnimationActive={false}
                  radius={i === drawn.length - 1 ? [4, 4, 0, 0] : undefined}
                >
                  {/* Étiquetage SÉLECTIF : la journée la plus chère seulement.
                      Une valeur au-dessus de chaque colonne ne se lit pas. */}
                  {i === drawn.length - 1 ? (
                    <LabelList
                      dataKey="peakLabel"
                      position="top"
                      fill="var(--muted-foreground)"
                      fontSize={11}
                    />
                  ) : null}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ── Coût par téléphoniste / par modèle (barres horizontales) ────────────────

export type RankedDatum = { key: string; label: string; value: number };

/**
 * Barres horizontales, série nominale UNIQUE — donc une seule teinte pour
 * toutes les barres : colorier chaque barre selon sa valeur ré-encoderait ce
 * que la longueur dit déjà, et brûlerait le canal d'identité pour rien.
 *
 * Sous DEUX barres, le graphique ne s'affiche pas : une valeur seule est une
 * tuile de chiffre, pas un graphique à une barre.
 */
export function RankedBarChart({
  data,
  color,
  format,
  formatAxis,
  seriesName,
}: {
  data: RankedDatum[];
  color: string;
  format: (n: number) => string;
  /** Graduations : précision adaptée à l'échelle (voir `SpendPerDayChart`). */
  formatAxis: (n: number) => string;
  /** Nom de la série — porté par l'infobulle ; le titre de la carte le redit. */
  seriesName: string;
}) {
  const positive = data.filter((d) => d.value > 0);
  if (positive.length < 2) return null;

  // 44px par ligne + la bande de l'axe : le conteneur inclut l'axe, il ne le
  // rogne pas (sinon la carte gagne une barre de défilement interne).
  const height = Math.max(140, positive.length * 44 + 36);

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={positive}
          layout="vertical"
          margin={{ top: 4, right: 64, bottom: 0, left: 0 }}
        >
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            domain={[0, niceCeil(Math.max(...positive.map((d) => d.value)))]}
            ticks={niceTicks(Math.max(...positive.map((d) => d.value)))}
            tickLine={false}
            axisLine={{ stroke: GRID_STROKE }}
            tick={AXIS_TICK}
            tickFormatter={(v: number) => formatAxis(v)}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={128}
            tickLine={false}
            axisLine={false}
            tick={NAME_TICK}
          />
          <Tooltip cursor={CURSOR} content={<VizTooltip format={format} />} />
          <Bar
            dataKey="value"
            name={seriesName}
            fill={color}
            radius={[0, 4, 4, 0]}
            maxBarSize={20}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="value"
              position="right"
              fill="var(--muted-foreground)"
              fontSize={11}
              formatter={(v: React.ReactNode) => format(Number(v))}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Segments SMS par jour (volume, jamais converti en argent) ────────────────

export type SegmentDayDatum = {
  key: string;
  label: string;
  outbound: number;
  inbound: number;
};

/**
 * Volume SMS par journée TORONTO — des SEGMENTS, l'unité facturée, comptés
 * chez nous. Ce graphique ne devient JAMAIS un graphique d'argent : segments ×
 * taux serait une estimation déguisée en facture, et la dépense réelle a déjà
 * sa place dans la pile des journées.
 *
 * Forme « emphase » : une teinte pour ce qu'on envoie (le geste qu'on décide),
 * un gris de retrait pour ce qu'on reçoit.
 */
export function SegmentsPerDayChart({
  data,
  labels,
  nf,
  height = 180,
}: {
  data: SegmentDayDatum[];
  labels: { outbound: string; inbound: string };
  nf: Intl.NumberFormat;
  height?: number;
}) {
  const t = useTranslations("admin");
  const total = data.reduce((acc, d) => acc + d.outbound + d.inbound, 0);
  const gap = data.length <= 20 ? 2 : data.length <= 45 ? 1 : 0;
  const fmt = (n: number) => nf.format(Math.round(n));

  return (
    <div className="space-y-3">
      <ValueLegend
        items={[
          {
            key: "out",
            color: "var(--viz-src-sms)",
            label: labels.outbound,
            value: fmt(data.reduce((acc, d) => acc + d.outbound, 0)),
          },
          {
            key: "in",
            color: "var(--viz-deemph)",
            label: labels.inbound,
            value: fmt(data.reduce((acc, d) => acc + d.inbound, 0)),
          },
        ]}
      />
      {total === 0 ? (
        <NoData>{t("billing.chartEmpty")}</NoData>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={{ stroke: GRID_STROKE }}
                tick={AXIS_TICK}
                minTickGap={24}
                interval="preserveStartEnd"
              />
              <YAxis
                width={32}
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={AXIS_TICK}
              />
              <Tooltip cursor={CURSOR} content={<VizTooltip format={fmt} />} />
              <Bar
                dataKey="outbound"
                name={labels.outbound}
                stackId="seg"
                fill="var(--viz-src-sms)"
                stroke="var(--card)"
                strokeWidth={gap}
                maxBarSize={24}
                isAnimationActive={false}
              />
              <Bar
                dataKey="inbound"
                name={labels.inbound}
                stackId="seg"
                fill="var(--viz-deemph)"
                stroke="var(--card)"
                strokeWidth={gap}
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
