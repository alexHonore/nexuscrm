"use client";

import { ChevronDown, ChevronUp, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type UserStatsRow = {
  userId: string;
  name: string;
  calls: number;
  connected: number;
  totalSec: number;
  answeredSec: number;
  rdv: number;
};

type SortKey = "name" | "calls" | "pct" | "minutes" | "avg" | "rdv" | "per100";

type ComputedRow = UserStatsRow & {
  pct: number;
  minutes: number;
  avg: number;
  per100: number;
};

function mmss(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function compute(row: UserStatsRow): ComputedRow {
  return {
    ...row,
    pct: row.calls > 0 ? (row.connected / row.calls) * 100 : 0,
    minutes: Math.round(row.totalSec / 60),
    avg: row.connected > 0 ? row.answeredSec / row.connected : 0,
    per100: row.calls > 0 ? (row.rdv / row.calls) * 100 : 0,
  };
}

export function UserStatsTable({ rows }: { rows: UserStatsRow[] }) {
  const t = useTranslations("analytics");
  const [sortKey, setSortKey] = useState<SortKey>("calls");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const computed = useMemo(() => rows.map(compute), [rows]);

  const sorted = useMemo(() => {
    const list = [...computed];
    list.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortKey === "name") return a.name.localeCompare(b.name) * dir;
      return (a[sortKey] - b[sortKey]) * dir;
    });
    return list;
  }, [computed, sortKey, sortDir]);

  const totals = useMemo(() => {
    const sum = computed.reduce(
      (acc, r) => ({
        calls: acc.calls + r.calls,
        connected: acc.connected + r.connected,
        totalSec: acc.totalSec + r.totalSec,
        answeredSec: acc.answeredSec + r.answeredSec,
        rdv: acc.rdv + r.rdv,
      }),
      { calls: 0, connected: 0, totalSec: 0, answeredSec: 0, rdv: 0 },
    );
    return {
      ...sum,
      pct: sum.calls > 0 ? (sum.connected / sum.calls) * 100 : 0,
      minutes: Math.round(sum.totalSec / 60),
      avg: sum.connected > 0 ? sum.answeredSec / sum.connected : 0,
      per100: sum.calls > 0 ? (sum.rdv / sum.calls) * 100 : 0,
    };
  }, [computed]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const columns: { key: SortKey; label: string; numeric: boolean }[] = [
    { key: "name", label: t("table.user"), numeric: false },
    { key: "calls", label: t("table.calls"), numeric: true },
    { key: "pct", label: t("table.connectedPct"), numeric: true },
    { key: "minutes", label: t("table.minutes"), numeric: true },
    { key: "avg", label: t("table.avgCall"), numeric: true },
    { key: "rdv", label: t("table.rdv"), numeric: true },
    { key: "per100", label: t("table.rdvPer100"), numeric: true },
  ];

  if (rows.length === 0) {
    return <EmptyState icon={<Users />} title={t("table.empty")} className="py-8" />;
  }

  return (
    <div>
      {/* ── Tableau (md+) ── */}
      <div className="hidden overflow-hidden rounded-lg ring-1 ring-foreground/10 md:block">
        <Table className="[&_th]:h-10 [&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider">
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  aria-sort={
                    sortKey === col.key
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className={cn(col.numeric && "text-right")}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md py-1 text-left font-medium outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                      sortKey === col.key ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {col.label}
                    {sortKey === col.key ? (
                      sortDir === "asc" ? (
                        <ChevronUp className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )
                    ) : null}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow key={r.userId}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
                <TableCell className="text-right tabular-nums">{Math.round(r.pct)} %</TableCell>
                <TableCell className="text-right tabular-nums">{r.minutes}</TableCell>
                <TableCell className="text-right tabular-nums">{mmss(r.avg)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.rdv}</TableCell>
                <TableCell className="text-right tabular-nums">{r.per100.toFixed(1)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>{t("table.totals")}</TableCell>
              <TableCell className="text-right tabular-nums">{totals.calls}</TableCell>
              <TableCell className="text-right tabular-nums">{Math.round(totals.pct)} %</TableCell>
              <TableCell className="text-right tabular-nums">{totals.minutes}</TableCell>
              <TableCell className="text-right tabular-nums">{mmss(totals.avg)}</TableCell>
              <TableCell className="text-right tabular-nums">{totals.rdv}</TableCell>
              <TableCell className="text-right tabular-nums">{totals.per100.toFixed(1)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {/* ── Cartes (mobile) ── */}
      <div className="space-y-3 md:hidden">
        <div className="flex items-center justify-end">
          <Select
            value={sortKey}
            onValueChange={(value) => {
              const key = value as SortKey;
              setSortKey(key);
              setSortDir(key === "name" ? "asc" : "desc");
            }}
          >
            <SelectTrigger aria-label={t("table.sortBy")} className="min-h-11 min-w-40 md:min-h-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {columns.map((col) => (
                <SelectItem key={col.key} value={col.key}>
                  {col.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {sorted.map((r) => (
          <div key={r.userId} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs">
            <p className="mb-2 font-medium">{r.name}</p>
            <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{t("table.calls")}</dt>
                <dd className="font-medium tabular-nums">{r.calls}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("table.connectedPct")}</dt>
                <dd className="font-medium tabular-nums">{Math.round(r.pct)} %</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("table.minutes")}</dt>
                <dd className="font-medium tabular-nums">{r.minutes}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("table.avgCall")}</dt>
                <dd className="font-medium tabular-nums">{mmss(r.avg)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("table.rdv")}</dt>
                <dd className="font-medium tabular-nums">{r.rdv}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("table.rdvPer100")}</dt>
                <dd className="font-medium tabular-nums">{r.per100.toFixed(1)}</dd>
              </div>
            </dl>
          </div>
        ))}
        <div className="rounded-xl bg-muted/60 p-4 text-sm">
          <p className="mb-1 font-medium">{t("table.totals")}</p>
          <p className="text-muted-foreground">
            {t("table.totalsSummary", {
              calls: totals.calls,
              pct: Math.round(totals.pct),
              minutes: totals.minutes,
              rdv: totals.rdv,
            })}
          </p>
        </div>
      </div>
    </div>
  );
}
