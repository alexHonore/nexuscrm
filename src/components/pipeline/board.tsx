"use client";

/**
 * Tableau Kanban du pipeline — vue de travail des téléphonistes.
 *
 * L'état vit ici (useState initialisé par le payload serveur) : les
 * déplacements sont optimistes (retrait + insertion en tête de colonne),
 * confirmés par setClientCategoryAction puis router.refresh(), et annulés
 * avec un toast si l'action échoue.
 *
 * Drag & drop : événements HTML5 natifs seulement (desktop). Sur mobile,
 * le menu « Déplacer vers » de chaque carte fait le même travail.
 */

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { setClientCategoryAction } from "@/app/(app)/clients/actions";
import { PipelineColumn } from "./board-column";

export type PipelineCardData = {
  id: string;
  fullName: string;
  phone: string;
  city: string | null;
  /** ISO 8601 ou null. */
  nextFollowupAt: string | null;
  doNotCall: boolean;
  lastDisposition: string | null;
  /** ISO 8601. */
  updatedAt: string;
};

export type PipelineColumnData = {
  /** null = « Sans catégorie ». */
  id: number | null;
  name: string;
  color: string;
  /** Compte total de la catégorie (peut dépasser cards.length). */
  total: number;
  cards: PipelineCardData[];
};

export type MoveTargetData = {
  /** null = « Sans catégorie ». */
  id: number | null;
  name: string;
  color: string;
};

/** Type MIME du drag natif transportant l'id du client. */
export const CLIENT_DRAG_MIME = "application/x-nexus-client";

/** Clé React/DOM stable pour une colonne (id null inclus). */
export function columnKey(id: number | null): string {
  return id === null ? "none" : String(id);
}

export function PipelineBoard({
  initialColumns,
  targets,
  now,
}: {
  initialColumns: PipelineColumnData[];
  targets: MoveTargetData[];
  /** Instant du rendu serveur (ms epoch) — référence « en retard ». */
  now: number;
}) {
  const t = useTranslations("pipeline");
  const router = useRouter();
  const [columns, setColumns] = useState(initialColumns);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  /** Déplacements en vol — bloque la resynchro serveur pendant ce temps. */
  const pendingMovesRef = useRef(0);

  // Resynchronise l'état local quand le payload serveur change (après un
  // router.refresh()), sauf si un déplacement optimiste est encore en vol.
  useEffect(() => {
    if (pendingMovesRef.current === 0) setColumns(initialColumns);
  }, [initialColumns]);

  const moveCard = (cardId: string, toId: number | null) => {
    const from = columns.find((col) => col.cards.some((c) => c.id === cardId));
    if (!from || from.id === toId) return;
    const card = from.cards.find((c) => c.id === cardId);
    if (!card) return;

    const target = targets.find((tg) => tg.id === toId);
    const snapshot = columns;
    const movedCard: PipelineCardData = { ...card, updatedAt: new Date().toISOString() };

    let targetExists = false;
    const next = columns.map((col) => {
      if (col.id === from.id) {
        return {
          ...col,
          total: Math.max(0, col.total - 1),
          cards: col.cards.filter((c) => c.id !== cardId),
        };
      }
      if (col.id === toId) {
        targetExists = true;
        return { ...col, total: col.total + 1, cards: [movedCard, ...col.cards] };
      }
      return col;
    });
    // Colonne absente du tableau (ex. « Sans catégorie » encore vide) : la créer.
    if (!targetExists && target) {
      next.push({ id: target.id, name: target.name, color: target.color, total: 1, cards: [movedCard] });
    }

    setColumns(next);
    pendingMovesRef.current += 1;
    startTransition(async () => {
      const res = await setClientCategoryAction(cardId, toId);
      pendingMovesRef.current -= 1;
      if (res.ok) {
        if (target) toast.success(t("card.moved", { category: target.name }));
        router.refresh();
      } else {
        setColumns(snapshot);
        toast.error(t("card.moveFailed"));
      }
    });
  };

  if (columns.length === 0) {
    return (
      <p className="mx-4 rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground md:mx-8">
        {t("board.empty")}
      </p>
    );
  }

  return (
    <section
      aria-label={t("board.label")}
      className="flex h-[calc(100dvh-19.5rem)] min-h-80 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-px-4 px-4 pb-2 md:h-[calc(100dvh-10rem)] md:snap-none md:gap-4 md:scroll-px-8 md:px-8"
    >
      {columns.map((column) => {
        const key = columnKey(column.id);
        return (
          <PipelineColumn
            key={key}
            column={column}
            targets={targets}
            now={now}
            draggingId={draggingId}
            isDragOver={dragOverKey === key}
            onCardDragStart={(id) => setDraggingId(id)}
            onCardDragEnd={() => {
              setDraggingId(null);
              setDragOverKey(null);
            }}
            onDragOverColumn={() => setDragOverKey(key)}
            onDragLeaveColumn={() => setDragOverKey((k) => (k === key ? null : k))}
            onDropCard={(cardId) => {
              setDraggingId(null);
              setDragOverKey(null);
              moveCard(cardId, column.id);
            }}
            onMoveCard={moveCard}
          />
        );
      })}
    </section>
  );
}
