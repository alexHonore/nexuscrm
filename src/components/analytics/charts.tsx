"use client";

import { useTranslations } from "next-intl";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dispositionColorVar } from "@/components/analytics/viz-theme";

/**
 * Graphiques Recharts — spécifications dataviz :
 * marques fines (≤ 24px), bouts arrondis 4px côté données, grille hairline
 * horizontale pleine, axes en retrait, écart de surface entre segments,
 * légende présente dès 2 séries, infobulle sur chaque forme.
 */

const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 11 } as const;
const NAME_TICK = { fill: "var(--foreground)", fontSize: 12 } as const;
const GRID_STROKE = "var(--border)";
const CURSOR = { fill: "var(--muted)", opacity: 0.6 } as const;

// ── Infobulle partagée ───────────────────────────────────────────────────────

type TooltipItem = {
  name?: string | number;
  value?: number | string;
  color?: string;
  fill?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
};

function VizTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: string | number;
  unit?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      {label !== undefined && label !== "" ? (
        <p className="mb-1 font-medium text-muted-foreground">{label}</p>
      ) : null}
      {payload.map((item, i) => (
        <div key={`${String(item.dataKey ?? item.name)}-${i}`} className="flex items-center gap-2 py-0.5">
          <span
            aria-hidden
            className="h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: item.color ?? item.fill }}
          />
          <span className="font-semibold tabular-nums">
            {item.value}
            {unit ? ` ${unit}` : ""}
          </span>
          <span className="text-muted-foreground">{item.name}</span>
        </div>
      ))}
    </div>
  );
}

function LegendRow({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function EmptyState() {
  const t = useTranslations("analytics");
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {t("charts.noData")}
    </div>
  );
}

// ── Appels par jour (barres empilées connectés / non connectés) ──────────────

export type CallsPerDayDatum = {
  key: string;
  label: string;
  answered: number;
  missed: number;
};

export function CallsPerDayChart({ data }: { data: CallsPerDayDatum[] }) {
  const t = useTranslations("analytics");
  const total = data.reduce((acc, d) => acc + d.answered + d.missed, 0);
  // Écart de surface entre segments — s'efface quand les barres deviennent trop fines.
  const gap = data.length <= 20 ? 2 : data.length <= 45 ? 1 : 0;

  return (
    <div className="flex h-full flex-col gap-3">
      <LegendRow
        items={[
          { color: "var(--viz-answered)", label: t("charts.answered") },
          { color: "var(--viz-missed)", label: t("charts.missed") },
        ]}
      />
      <div className="min-h-0 flex-1">
        {total === 0 ? (
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
                minTickGap={28}
                interval="preserveStartEnd"
              />
              <YAxis
                width={32}
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={AXIS_TICK}
              />
              <Tooltip cursor={CURSOR} content={<VizTooltip />} />
              <Bar
                dataKey="answered"
                name={t("charts.answered")}
                stackId="calls"
                fill="var(--viz-answered)"
                stroke="var(--card)"
                strokeWidth={gap}
                maxBarSize={24}
              />
              <Bar
                dataKey="missed"
                name={t("charts.missed")}
                stackId="calls"
                fill="var(--viz-missed)"
                stroke="var(--card)"
                strokeWidth={gap}
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── RDV par semaine (série unique — pas de boîte de légende) ─────────────────

export type BookingsPerWeekDatum = { key: string; label: string; count: number };

export function BookingsPerWeekChart({ data }: { data: BookingsPerWeekDatum[] }) {
  const t = useTranslations("analytics");
  const total = data.reduce((acc, d) => acc + d.count, 0);

  return (
    <div className="h-full">
      {total === 0 ? (
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
              minTickGap={16}
              interval="preserveStartEnd"
            />
            <YAxis
              width={28}
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
            />
            <Tooltip cursor={CURSOR} content={<VizTooltip />} />
            <Bar
              dataKey="count"
              name={t("charts.bookings")}
              fill="var(--viz-rdv)"
              radius={[4, 4, 0, 0]}
              maxBarSize={24}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Répartition des dispositions (anneau + légende chiffrée) ─────────────────

export type DispositionDatum = {
  key: string;
  label: string;
  count: number;
  pct: number;
};

function DonutTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipItem[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0];
  const datum = item.payload as DispositionDatum | undefined;
  return (
    <div className="rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-0.5 w-3 shrink-0 rounded-full"
          style={{ background: item.fill ?? item.color }}
        />
        <span className="font-semibold tabular-nums">
          {item.value}
          {datum ? ` · ${datum.pct} %` : ""}
        </span>
        <span className="text-muted-foreground">{item.name}</span>
      </div>
    </div>
  );
}

export function DispositionsDonut({ data }: { data: DispositionDatum[] }) {
  const t = useTranslations("analytics");
  const total = data.reduce((acc, d) => acc + d.count, 0);

  if (total === 0) {
    return (
      <div className="h-56">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <div className="relative h-52 w-52 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<DonutTooltip />} />
            <Pie
              data={data}
              dataKey="count"
              nameKey="label"
              innerRadius="62%"
              outerRadius="90%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={1.5}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.key} fill={dispositionColorVar(d.key)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold">{total}</span>
          <span className="text-xs text-muted-foreground">{t("charts.dispositionsTotal")}</span>
        </div>
      </div>
      {/* Légende chiffrée — le canal d'identité et de valeurs, jamais la couleur seule. */}
      <ul className="w-full min-w-0 space-y-1 text-sm">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-foreground/10"
              style={{ background: dispositionColorVar(d.key) }}
            />
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
            <span className="font-medium tabular-nums">{d.count}</span>
            <span className="w-11 text-right text-xs tabular-nums text-muted-foreground">
              {d.pct} %
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Minutes par téléphoniste (barres horizontales, série nominale unique) ────

export type MinutesPerUserDatum = { name: string; minutes: number };

export function MinutesPerUserChart({ data }: { data: MinutesPerUserDatum[] }) {
  const t = useTranslations("analytics");
  const total = data.reduce((acc, d) => acc + d.minutes, 0);
  const height = Math.max(140, data.length * 44 + 32);

  if (data.length === 0 || total === 0) {
    return (
      <div className="h-36">
        <EmptyState />
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 48, bottom: 0, left: 0 }}
        >
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis
            type="number"
            allowDecimals={false}
            tickLine={false}
            axisLine={{ stroke: GRID_STROKE }}
            tick={AXIS_TICK}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={110}
            tickLine={false}
            axisLine={false}
            tick={NAME_TICK}
          />
          <Tooltip cursor={CURSOR} content={<VizTooltip unit="min" />} />
          <Bar
            dataKey="minutes"
            name={t("charts.minutes")}
            fill="var(--viz-user)"
            radius={[0, 4, 4, 0]}
            maxBarSize={20}
          >
            {/* Barres → valeur au bout (jeton texte, jamais la couleur de série). */}
            <LabelList
              dataKey="minutes"
              position="right"
              fill="var(--muted-foreground)"
              fontSize={11}
              formatter={(v: React.ReactNode) => `${String(v)} min`}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
