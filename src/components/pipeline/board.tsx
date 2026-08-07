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
 *
 * « Vivant » : le tableau se recharge sur GET /api/clients/board dès qu'une
 * mutation locale le signale (useDataChange) et toutes les 20 s tant que
 * l'onglet est visible — pour voir les fiches déplacées par les collègues.
 */

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { setClientCategoryAction } from "@/app/(app)/clients/actions";
import { emitDataChange, useDataChange, useVisiblePolling } from "@/lib/live";
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

/** Cadence du rechargement de fond (collègues, leads entrants). */
const BOARD_POLL_MS = 20_000;

/** Couleur neutre de repli pour « Sans catégorie ». */
const NO_CATEGORY_COLOR = "#94a3b8";

/** Réponse de GET /api/clients/board (dates sérialisées en ISO). */
type BoardPayload = {
  columns: {
    category: { id: number; nameFr: string; nameEn: string; color: string } | null;
    total: number;
    clients: {
      id: string;
      fullName: string;
      phone: string;
      city: string | null;
      nextFollowupAt: string | null;
      doNotCall: boolean;
      lastDisposition: string | null;
      updatedAt: string;
    }[];
  }[];
};

/** Empreinte d'affichage du tableau — évite un rendu inutile à chaque sondage. */
function boardSignature(columns: PipelineColumnData[]): string {
  return columns
    .map(
      (col) =>
        `${columnKey(col.id)}#${col.name}#${col.total}#${col.cards
          .map(
            (c) =>
              `${c.id}:${c.fullName}:${c.phone}:${c.city ?? ""}:${c.nextFollowupAt ?? ""}:${c.doNotCall ? 1 : 0}:${c.lastDisposition ?? ""}`,
          )
          .join(",")}`,
    )
    .join("|");
}

/** Clé React/DOM stable pour une colonne (id null inclus). */
export function columnKey(id: number | null): string {
  return id === null ? "none" : String(id);
}

export function PipelineBoard({
  initialColumns,
  targets,
  now: serverNow,
}: {
  initialColumns: PipelineColumnData[];
  targets: MoveTargetData[];
  /** Instant du rendu serveur (ms epoch) — référence « en retard ». */
  now: number;
}) {
  const t = useTranslations("pipeline");
  const locale = useLocale();
  const [columns, setColumns] = useState(initialColumns);
  /** Référence « en retard » : suit le dernier chargement de données. */
  const [now, setNow] = useState(serverNow);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  /** Déplacements en vol — bloque la resynchro serveur pendant ce temps. */
  const pendingMovesRef = useRef(0);
  /** Rechargement de fond en cours. */
  const refreshingRef = useRef(false);
  /** Un rechargement a été demandé pendant qu'un autre était en vol. */
  const rerunRef = useRef(false);
  /** Incrémenté à chaque déplacement — invalide les réponses parties avant. */
  const versionRef = useRef(0);
  /** Drag en cours — remplacer les cartes casserait le glisser natif. */
  const draggingRef = useRef(false);

  // Resynchronise l'état local quand un NOUVEAU payload serveur arrive (après
  // un router.refresh() venu de la coquille), sauf si un déplacement optimiste
  // ou un glisser est en cours : dans ce cas c'est l'état local qui fait foi.
  useEffect(() => {
    if (pendingMovesRef.current === 0 && !draggingRef.current) {
      setColumns(initialColumns);
      setNow(serverNow);
    }
  }, [initialColumns, serverNow]);

  /**
   * Rechargement de fond du tableau — même source que la page (getBoardData),
   * mais sans re-rendre tout l'arbre serveur. Jamais appliqué si un
   * déplacement optimiste est en vol : il gagne toujours.
   */
  const refreshBoard = useCallback(async function run(): Promise<void> {
    if (pendingMovesRef.current > 0 || draggingRef.current) return;
    if (refreshingRef.current) {
      rerunRef.current = true;
      return;
    }
    refreshingRef.current = true;
    const startedVersion = versionRef.current;
    try {
      const res = await fetch("/api/clients/board");
      if (!res.ok) return;
      const data = (await res.json()) as BoardPayload;
      // Un déplacement (ou un drag) a démarré pendant la requête → réponse
      // périmée : elle écraserait le déplacement optimiste.
      if (
        pendingMovesRef.current > 0 ||
        draggingRef.current ||
        versionRef.current !== startedVersion
      ) {
        return;
      }

      const next: PipelineColumnData[] = data.columns.map((col) => {
        const id = col.category?.id ?? null;
        const target = targets.find((tg) => tg.id === id);
        const fallbackName = col.category
          ? locale === "en"
            ? col.category.nameEn
            : col.category.nameFr
          : t("board.noCategory");
        return {
          id,
          name: target?.name ?? fallbackName,
          color: target?.color ?? col.category?.color ?? NO_CATEGORY_COLOR,
          total: col.total,
          cards: col.clients.map((c) => ({
            id: c.id,
            fullName: c.fullName,
            phone: c.phone,
            city: c.city,
            nextFollowupAt: c.nextFollowupAt,
            doNotCall: c.doNotCall,
            lastDisposition: c.lastDisposition,
            updatedAt: c.updatedAt,
          })),
        };
      });

      setNow(Date.now());
      setColumns((current) => (boardSignature(current) === boardSignature(next) ? current : next));
    } catch {
      // Réseau indisponible : on retentera au prochain sondage.
    } finally {
      refreshingRef.current = false;
      if (rerunRef.current) {
        rerunRef.current = false;
        await run();
      }
    }
  }, [locale, t, targets]);

  // Mutations locales (fiche client, suivis, déplacements) + collègues.
  useDataChange(["clients", "followups"], () => {
    versionRef.current += 1;
    void refreshBoard();
  });
  useVisiblePolling(BOARD_POLL_MS, () => {
    void refreshBoard();
  });

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
    versionRef.current += 1;
    startTransition(async () => {
      const res = await setClientCategoryAction(cardId, toId);
      pendingMovesRef.current -= 1;
      if (res.ok) {
        if (target) toast.success(t("card.moved", { category: target.name }));
        // Le tableau se resynchronise via useDataChange (fetch léger), et le
        // panneau /clients — s'il est monté — recharge sa liste au passage.
        emitDataChange("clients");
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
            onCardDragStart={(id) => {
              draggingRef.current = true;
              setDraggingId(id);
            }}
            onCardDragEnd={() => {
              draggingRef.current = false;
              setDraggingId(null);
              setDragOverKey(null);
            }}
            onDragOverColumn={() => setDragOverKey(key)}
            onDragLeaveColumn={() => setDragOverKey((k) => (k === key ? null : k))}
            onDropCard={(cardId) => {
              draggingRef.current = false;
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
