"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  CLIENT_DRAG_MIME,
  type MoveTargetData,
  type PipelineColumnData,
} from "./board";
import { PipelineClientCard } from "./client-card";

/**
 * Colonne du tableau : bordure supérieure colorée, nom + jeton de compte,
 * défilement vertical interne, zone de dépôt (drag & drop natif).
 */
export function PipelineColumn({
  column,
  targets,
  now,
  draggingId,
  isDragOver,
  onCardDragStart,
  onCardDragEnd,
  onDragOverColumn,
  onDragLeaveColumn,
  onDropCard,
  onMoveCard,
}: {
  column: PipelineColumnData;
  targets: MoveTargetData[];
  /** Instant du rendu serveur (ms epoch) — référence « en retard ». */
  now: number;
  draggingId: string | null;
  isDragOver: boolean;
  onCardDragStart: (cardId: string) => void;
  onCardDragEnd: () => void;
  onDragOverColumn: () => void;
  onDragLeaveColumn: () => void;
  onDropCard: (cardId: string) => void;
  onMoveCard: (cardId: string, toId: number | null) => void;
}) {
  const t = useTranslations("pipeline");
  const remaining = column.total - column.cards.length;

  const handleDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes(CLIENT_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    onDragOverColumn();
  };

  const handleDragLeave = (e: React.DragEvent<HTMLElement>) => {
    // Ignorer les sorties vers un enfant de la colonne.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    onDragLeaveColumn();
  };

  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    const cardId =
      e.dataTransfer.getData(CLIENT_DRAG_MIME) || e.dataTransfer.getData("text/plain");
    if (cardId) onDropCard(cardId);
  };

  return (
    <section
      aria-label={column.name}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "flex h-full w-[calc(100vw-4.5rem)] max-w-80 shrink-0 snap-start flex-col rounded-xl border-t-4 bg-muted/40 transition-shadow md:w-[300px]",
        isDragOver ? "ring-2 ring-primary/60" : "ring-1 ring-foreground/5",
      )}
      style={{ borderTopColor: column.color }}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <h2 className="min-w-0 truncate text-sm font-semibold">{column.name}</h2>
        <span
          className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums"
          style={{ color: column.color, backgroundColor: `${column.color}1a` }}
        >
          {column.total}
        </span>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {column.cards.length === 0 ? (
          <p className="rounded-lg border border-dashed border-foreground/10 p-4 text-center text-xs text-muted-foreground">
            {t("column.empty")}
          </p>
        ) : (
          column.cards.map((card) => (
            <PipelineClientCard
              key={card.id}
              card={card}
              columnId={column.id}
              targets={targets}
              now={now}
              isDragging={draggingId === card.id}
              onDragStart={onCardDragStart}
              onDragEnd={onCardDragEnd}
              onMove={onMoveCard}
            />
          ))
        )}

        {remaining > 0 ? (
          <Link
            href={column.id === null ? "/clients" : `/clients?categoryId=${column.id}`}
            className="flex min-h-11 items-center justify-center rounded-lg text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t("column.more", { count: remaining })}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
