"use client";

import { PhoneIncoming, PhoneOutgoing, Play, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { dispositionColorVar } from "@/components/analytics/viz-theme";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type CallRow = {
  id: string;
  dateLabel: string;
  timeLabel: string;
  userName: string;
  direction: "outbound" | "inbound";
  clientId: string | null;
  clientName: string | null;
  number: string;
  durationSec: number;
  disposition: string | null;
  dispositionLabel: string | null;
  note: string | null;
  recordingUrl: string | null;
};

function mmss(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function proxyUrl(recordingUrl: string, callId: string): string {
  return `/api/admin/recordings?url=${encodeURIComponent(recordingUrl)}&callId=${encodeURIComponent(callId)}`;
}

function DirectionIcon({ direction }: { direction: "outbound" | "inbound" }) {
  const t = useTranslations("analytics");
  const Icon = direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
  return (
    <span className="inline-flex items-center text-muted-foreground">
      <Icon aria-hidden className="size-4" />
      <span className="sr-only">
        {direction === "outbound" ? t("callsPage.outbound") : t("callsPage.inbound")}
      </span>
    </span>
  );
}

function DispositionChip({
  disposition,
  label,
}: {
  disposition: string;
  label: string;
}) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted/60 px-2 text-xs font-medium ring-1 ring-foreground/10">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full ring-1 ring-foreground/10"
        style={{ background: dispositionColorVar(disposition) }}
      />
      {label}
    </span>
  );
}

function ClientCell({ row }: { row: CallRow }) {
  if (row.clientId && row.clientName) {
    return (
      <Link
        href={`/clients/${row.clientId}`}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        {row.clientName}
      </Link>
    );
  }
  return <span className="tabular-nums">{row.number}</span>;
}

/** Lecteur paresseux : l'élément <audio> (et la requête au proxy) n'existe qu'après le clic. */
function RecordingCell({
  row,
  active,
  onToggle,
  compact,
}: {
  row: CallRow;
  active: boolean;
  onToggle: () => void;
  compact?: boolean;
}) {
  const t = useTranslations("analytics");
  if (!row.recordingUrl) {
    return compact ? null : <span className="text-xs text-muted-foreground">—</span>;
  }
  if (!active) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={compact ? "h-11 w-full" : "h-8"}
        onClick={onToggle}
      >
        <Play className="size-3.5" />
        {t("callsPage.listen")}
      </Button>
    );
  }
  return (
    <span className={compact ? "flex w-full items-center gap-1" : "inline-flex items-center gap-1"}>
      <audio
        controls
        autoPlay
        preload="none"
        src={proxyUrl(row.recordingUrl, row.id)}
        className={compact ? "h-11 min-w-0 flex-1" : "h-8 w-60"}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("callsPage.close")}
        className={compact ? "size-11" : undefined}
        onClick={onToggle}
      >
        <X className="size-4" />
      </Button>
    </span>
  );
}

export function CallsList({ rows }: { rows: CallRow[] }) {
  const t = useTranslations("analytics");
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);

  const toggleAudio = (id: string) =>
    setActiveAudioId((cur) => (cur === id ? null : id));

  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {t("callsPage.empty")}
      </p>
    );
  }

  return (
    <div>
      {/* ── Tableau (md+) ── */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("callsPage.date")}</TableHead>
              <TableHead>{t("callsPage.user")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("callsPage.direction")}</span>
              </TableHead>
              <TableHead>{t("callsPage.client")}</TableHead>
              <TableHead className="text-right">{t("callsPage.duration")}</TableHead>
              <TableHead>{t("callsPage.disposition")}</TableHead>
              <TableHead>{t("callsPage.note")}</TableHead>
              <TableHead>{t("callsPage.recording")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="text-muted-foreground">
                  <span className="block text-foreground">{row.dateLabel}</span>
                  <span className="text-xs">{row.timeLabel}</span>
                </TableCell>
                <TableCell>{row.userName}</TableCell>
                <TableCell>
                  <DirectionIcon direction={row.direction} />
                </TableCell>
                <TableCell>
                  <ClientCell row={row} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {mmss(row.durationSec)}
                </TableCell>
                <TableCell>
                  {row.disposition && row.dispositionLabel ? (
                    <DispositionChip
                      disposition={row.disposition}
                      label={row.dispositionLabel}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="max-w-56">
                  {row.note ? (
                    <span className="block truncate text-muted-foreground" title={row.note}>
                      {row.note}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <RecordingCell
                    row={row}
                    active={activeAudioId === row.id}
                    onToggle={() => toggleAudio(row.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Cartes (mobile) ── */}
      <ul className="space-y-3 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <ClientCell row={row} />
                {row.clientId && row.clientName ? (
                  <p className="text-xs tabular-nums text-muted-foreground">{row.number}</p>
                ) : null}
              </div>
              {row.disposition && row.dispositionLabel ? (
                <DispositionChip
                  disposition={row.disposition}
                  label={row.dispositionLabel}
                />
              ) : null}
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <DirectionIcon direction={row.direction} />
              <span>
                {row.dateLabel} · {row.timeLabel}
              </span>
              <span className="tabular-nums">{mmss(row.durationSec)}</span>
              <span>{row.userName}</span>
            </p>
            {row.note ? (
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{row.note}</p>
            ) : null}
            {row.recordingUrl ? (
              <div className="mt-3">
                <RecordingCell
                  row={row}
                  active={activeAudioId === row.id}
                  onToggle={() => toggleAudio(row.id)}
                  compact
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
