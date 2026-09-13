"use client";

import { PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, Play, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PullRecordingButton } from "@/components/analytics/pull-recording-button";
import {
  type CallMarks,
  type CollectionOption,
  FilingChips,
  RecordingMarks,
} from "@/components/analytics/recording-marks";
import { dispositionColorVar } from "@/components/analytics/viz-theme";
import { cn } from "@/lib/utils";
import { LIBRARY_LOOK, LookGlyph } from "@/components/look";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
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
  /** Entrant jamais décroché. */
  missed: boolean;
  clientId: string | null;
  clientName: string | null;
  number: string;
  durationSec: number;
  disposition: string | null;
  dispositionLabel: string | null;
  /** Couleur du statut du pipeline — null : repli sur la variable CSS des 7 anciennes valeurs. */
  dispositionColor: string | null;
  note: string | null;
  recordingUrl: string | null;
  /**
   * Cet appel peut-il demander SON enregistrement à voip.ms tout de suite ?
   * Vrai seulement là où un enregistrement peut exister et manque encore :
   * appel voip.ms décroché, sans audio, sur une fiche dont on a le droit
   * d'écouter l'historique. Ailleurs, pas de bouton — il ne trouverait rien.
   */
  canPullRecording: boolean;
  /**
   * Étoile de CELUI qui regarde, et recueils où l'appel est rangé. `null` =
   * cette ligne n'offre aucun de ces gestes (pas le droit d'écouter, ou
   * historique fermé sur la fiche) — pas de bouton mort, pas d'aveu.
   */
  marks: CallMarks | null;
  /**
   * Le MOTIF d'écoute écrit au moment du classement — pourquoi cet appel est
   * dans ce recueil-là. Absent hors de la bibliothèque : le journal d'appels
   * montre tous les appels, il n'en range aucun.
   */
  filingNote?: string | null;
};

function mmss(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function proxyUrl(recordingUrl: string, callId: string): string {
  return `/api/admin/recordings?url=${encodeURIComponent(recordingUrl)}&callId=${encodeURIComponent(callId)}`;
}

function DirectionIcon({
  direction,
  missed,
}: {
  direction: "outbound" | "inbound";
  missed?: boolean;
}) {
  const t = useTranslations("analytics");
  const Icon = missed ? PhoneMissed : direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
  return (
    <span
      className={
        missed
          ? "inline-flex items-center text-red-600 dark:text-red-400"
          : "inline-flex items-center text-muted-foreground"
      }
    >
      <Icon aria-hidden className="size-4" />
      <span className="sr-only">
        {missed
          ? t("callsPage.missedCall")
          : direction === "outbound"
            ? t("callsPage.outbound")
            : t("callsPage.inbound")}
      </span>
    </span>
  );
}

function DispositionChip({
  disposition,
  label,
  color,
}: {
  disposition: string;
  label: string;
  color?: string | null;
}) {
  const swatch = color ?? dispositionColorVar(disposition);
  return (
    <span
      className="inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium ring-1 ring-foreground/10"
      style={{
        // Voile translucide de la couleur de disposition — jamais d'aplat opaque.
        background: `color-mix(in srgb, ${swatch} 10%, transparent)`,
      }}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full ring-1 ring-foreground/10"
        style={{ background: swatch }}
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

/**
 * Le motif d'écoute — ce que le classeur a voulu faire remarquer.
 *
 * Il passe AVANT la note d'après-appel, parce qu'il ne dit pas la même chose :
 * la note raconte le client, le motif raconte l'appel comme leçon. Le
 * pictogramme double le libellé, il ne le remplace pas (règle 11).
 */
function FilingReason({ note }: { note: string }) {
  const t = useTranslations("analytics");
  return (
    <span className="mb-1 flex items-start gap-1.5 text-sm" title={note}>
      <LookGlyph look={LIBRARY_LOOK.folder} className="mt-0.5 size-3.5" />
      <span className="min-w-0">
        <span className="sr-only">{t("library.reason")} : </span>
        <span className="line-clamp-2">{note}</span>
      </span>
    </span>
  );
}

/** Lecteur paresseux : l'élément <audio> (et la requête au proxy) n'existe qu'après le clic. */
function RecordingCell({
  row,
  active,
  onToggle,
  compact,
  explainMissing,
}: {
  row: CallRow;
  active: boolean;
  onToggle: () => void;
  compact?: boolean;
  /** Dans la bibliothèque, un appel rangé SANS audio doit dire pourquoi. */
  explainMissing?: boolean;
}) {
  const t = useTranslations("analytics");
  if (!row.recordingUrl) {
    // voip.ms a peut-être déjà l'audio : le demander pour CET appel, tout de
    // suite, plutôt que d'attendre la synchro de toute la journée.
    if (row.canPullRecording) return <PullRecordingButton callId={row.id} compact={compact} />;
    // La synchronisation voip.ms ne passe qu'une fois par jour : un appel
    // marqué le matin n'a son enregistrement que le lendemain. Un tiret
    // laisserait croire qu'il n'y en aura jamais.
    if (explainMissing) {
      return <span className="text-xs text-muted-foreground">{t("library.noRecording")}</span>;
    }
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

export function CallsList({
  rows,
  collections,
  canCurate,
  variant = "log",
  hideCollectionId,
}: {
  rows: CallRow[];
  /** Les recueils où l'on peut ranger — vides pour qui n'a pas le droit. */
  collections: CollectionOption[];
  canCurate: boolean;
  /**
   * « log » = le journal d'appels, où l'absence d'enregistrement est la
   * normale. « library » = un recueil, où elle mérite une explication : on a
   * rangé cet appel POUR l'écouter.
   */
  variant?: "log" | "library";
  /**
   * Le recueil qu'on est en train d'ouvrir. Sa pastille est retirée des
   * lignes : à l'intérieur de « Objections — le prix », lire « Objections —
   * le prix » sur chaque ligne n'apprend rien et cache les AUTRES recueils,
   * qui eux sont une information.
   */
  hideCollectionId?: string;
}) {
  const t = useTranslations("analytics");
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);

  const toggleAudio = (id: string) =>
    setActiveAudioId((cur) => (cur === id ? null : id));

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<PhoneOff />}
        title={t("callsPage.empty")}
        hint={t("callsPage.emptyHint")}
      />
    );
  }

  return (
    <div>
      {/* ── Tableau (md+), journal seulement ──
          La bibliothèque ne l'affiche PAS : elle sert la même liste dans une
          colonne amputée de son rayonnage, où neuf colonnes ne tiennent pas —
          les deux dernières, écouter et marquer, passaient sous le bord.
          Elle garde les cartes à toutes les largeurs, comme l'historique
          d'une fiche : on y vient lire un motif et appuyer sur lecture, pas
          balayer trois cents lignes. `overflow-x-auto` reste au cas où une
          note très longue pousserait quand même. */}
      <div
        className={cn(
          "overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10 shadow-xs",
          variant === "library" ? "hidden" : "hidden md:block",
        )}
      >
        <Table className="[&_th]:h-10 [&_th]:whitespace-nowrap [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wider">
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
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
              <TableHead>
                <span className="sr-only">{t("callsPage.file")}</span>
              </TableHead>
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
                  <DirectionIcon direction={row.direction} missed={row.missed} />
                </TableCell>
                <TableCell className="max-w-56">
                  <ClientCell row={row} />
                  {row.marks ? (
                    <span className="mt-1 flex">
                      <FilingChips collections={row.marks.collections} hide={hideCollectionId} />
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {mmss(row.durationSec)}
                </TableCell>
                <TableCell>
                  {row.disposition && row.dispositionLabel ? (
                    <DispositionChip
                      disposition={row.disposition}
                      label={row.dispositionLabel}
                      color={row.dispositionColor}
                    />
                  ) : row.missed ? (
                    <span className="text-xs font-medium text-red-600 dark:text-red-400">
                      {t("callsPage.missedCall")}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="max-w-56">
                  {row.filingNote ? <FilingReason note={row.filingNote} /> : null}
                  {row.note ? (
                    <span className="block truncate text-muted-foreground" title={row.note}>
                      {row.note}
                    </span>
                  ) : row.filingNote ? null : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <RecordingCell
                    row={row}
                    active={activeAudioId === row.id}
                    onToggle={() => toggleAudio(row.id)}
                    explainMissing={variant === "library"}
                  />
                </TableCell>
                <TableCell className="w-0 whitespace-nowrap">
                  {row.marks ? (
                    <RecordingMarks
                      callId={row.id}
                      marks={row.marks}
                      collections={collections}
                      canCurate={canCurate}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Cartes (mobile — et la bibliothèque à toutes les largeurs) ── */}
      <ul className={cn("space-y-3", variant === "library" ? undefined : "md:hidden")}>
        {rows.map((row) => (
          <li key={row.id} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs">
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
                  color={row.dispositionColor}
                />
              ) : row.missed ? (
                <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">
                  {t("callsPage.missedCall")}
                </span>
              ) : null}
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <DirectionIcon direction={row.direction} missed={row.missed} />
              <span>
                {row.dateLabel} · {row.timeLabel}
              </span>
              <span className="tabular-nums">{mmss(row.durationSec)}</span>
              <span>{row.userName}</span>
            </p>
            {row.filingNote ? (
              <div className="mt-2">
                <FilingReason note={row.filingNote} />
              </div>
            ) : null}
            {row.note ? (
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{row.note}</p>
            ) : null}
            {row.marks ? (
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1">
                  <FilingChips collections={row.marks.collections} hide={hideCollectionId} />
                </span>
                <RecordingMarks
                  callId={row.id}
                  marks={row.marks}
                  collections={collections}
                  canCurate={canCurate}
                  compact
                />
              </div>
            ) : null}
            {row.recordingUrl || row.canPullRecording || variant === "library" ? (
              <div className="mt-3">
                <RecordingCell
                  row={row}
                  active={activeAudioId === row.id}
                  onToggle={() => toggleAudio(row.id)}
                  compact
                  explainMissing={variant === "library"}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
