import "server-only";
import { asc, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { categories, clients } from "@/db/schema";

/** Nombre maximal de cartes chargées par colonne du tableau. */
export const BOARD_CARD_LIMIT = 40;

export type BoardCategory = typeof categories.$inferSelect;

export type BoardClientRow = {
  id: string;
  fullName: string;
  phone: string;
  city: string | null;
  categoryId: number | null;
  nextFollowupAt: Date | null;
  doNotCall: boolean;
  lastDisposition: string | null;
  updatedAt: Date;
};

export type BoardData = {
  /** Toutes les catégories, ordonnées par sortOrder. */
  categories: BoardCategory[];
  /** Comptes totaux par catégorie (clé null = sans catégorie). */
  totals: Map<number | null, number>;
  /** Les ~BOARD_CARD_LIMIT clients les plus récents par catégorie (clé null = sans catégorie). */
  clientsByCategory: Map<number | null, BoardClientRow[]>;
  /** Instant de génération (ms epoch) — référence « suivi en retard » côté client. */
  generatedAt: number;
};

/**
 * Données du tableau Kanban — partagées entre la page /pipeline et
 * GET /api/clients/board. Deux requêtes seulement :
 * 1. comptes totaux groupés par catégorie ;
 * 2. sélection fenêtrée row_number() OVER (PARTITION BY category_id
 *    ORDER BY updated_at DESC) ≤ BOARD_CARD_LIMIT.
 */
export async function getBoardData(): Promise<BoardData> {
  const ranked = db
    .select({
      id: clients.id,
      fullName: clients.fullName,
      phone: clients.phone,
      city: clients.city,
      categoryId: clients.categoryId,
      nextFollowupAt: clients.nextFollowupAt,
      doNotCall: clients.doNotCall,
      lastDisposition: clients.lastDisposition,
      updatedAt: clients.updatedAt,
      rowNo: sql<number>`row_number() over (partition by ${clients.categoryId} order by ${clients.updatedAt} desc, ${clients.id})`.as(
        "row_no",
      ),
    })
    .from(clients)
    .as("ranked");

  const [allCategories, countRows, clientRows] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db
      .select({ categoryId: clients.categoryId, total: sql<number>`count(*)::int` })
      .from(clients)
      .groupBy(clients.categoryId),
    db
      .select()
      .from(ranked)
      .where(lte(ranked.rowNo, BOARD_CARD_LIMIT))
      .orderBy(asc(ranked.categoryId), asc(ranked.rowNo)),
  ]);

  const totals = new Map<number | null, number>();
  for (const row of countRows) totals.set(row.categoryId, row.total);

  const clientsByCategory = new Map<number | null, BoardClientRow[]>();
  for (const row of clientRows) {
    const client: BoardClientRow = {
      id: row.id,
      fullName: row.fullName,
      phone: row.phone,
      city: row.city,
      categoryId: row.categoryId,
      nextFollowupAt: row.nextFollowupAt,
      doNotCall: row.doNotCall,
      lastDisposition: row.lastDisposition,
      updatedAt: row.updatedAt,
    };
    const list = clientsByCategory.get(client.categoryId);
    if (list) list.push(client);
    else clientsByCategory.set(client.categoryId, [client]);
  }

  return { categories: allCategories, totals, clientsByCategory, generatedAt: Date.now() };
}
