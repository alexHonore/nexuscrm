import "server-only";
import { asc, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { categories, clients } from "@/db/schema";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { type Actor, loadDirectory, visibilityCondition } from "@/lib/permissions/server";

/** Nombre maximal de cartes chargées par colonne du tableau. */
export const BOARD_CARD_LIMIT = 40;

export type BoardCategory = typeof categories.$inferSelect;

export type BoardClientRow = {
  id: string;
  fullName: string;
  /** null quand le compartiment de la fiche ferme les coordonnées. */
  phone: string | null;
  /** Le numéro est absent par DROIT, pas parce que la fiche n'en a pas. */
  contactHidden: boolean;
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
 *
 * Tout part de la PORTÉE de celui qui regarde : elle entre dans la fenêtre
 * comme dans les comptes. Un compte de colonne non filtré dirait exactement ce
 * que la portée cache — « il y a 12 fiches ici, vous n'en voyez que 3 ».
 */
export async function getBoardData(actor: Actor): Promise<BoardData> {
  const [visible, { cfg, roleOf }] = await Promise.all([
    visibilityCondition(actor),
    loadDirectory(),
  ]);

  // Le compartiment ne dépend que du DÉTENTEUR : une résolution par détenteur
  // suffit pour les ~40 cartes × N colonnes que la page affiche.
  const grantsCache = new Map<string, Grants>();
  const grantsOfHolder = (assignedToId: string | null): Grants => {
    const key = assignedToId ?? "";
    const hit = grantsCache.get(key);
    if (hit) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const g = grantsFor(cfg, actor.role, bucketFor(actor.user.id, { assignedToId }, holder));
    grantsCache.set(key, g);
    return g;
  };

  const ranked = db
    .select({
      id: clients.id,
      fullName: clients.fullName,
      phone: clients.phone,
      city: clients.city,
      categoryId: clients.categoryId,
      assignedToId: clients.assignedToId,
      nextFollowupAt: clients.nextFollowupAt,
      doNotCall: clients.doNotCall,
      lastDisposition: clients.lastDisposition,
      updatedAt: clients.updatedAt,
      rowNo: sql<number>`row_number() over (partition by ${clients.categoryId} order by ${clients.updatedAt} desc, ${clients.id})`.as(
        "row_no",
      ),
    })
    .from(clients)
    // Le filtre est DANS la fenêtre, pas après : sinon les 40 premières cartes
    // seraient choisies parmi des fiches invisibles, et une colonne pleine
    // reviendrait vide.
    .where(visible)
    .as("ranked");

  const [allCategories, countRows, clientRows] = await Promise.all([
    db.query.categories.findMany({ orderBy: [asc(categories.sortOrder), asc(categories.id)] }),
    db
      .select({ categoryId: clients.categoryId, total: sql<number>`count(*)::int` })
      .from(clients)
      .where(visible)
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
    const contact = grantsOfHolder(row.assignedToId).contact;
    const client: BoardClientRow = {
      id: row.id,
      fullName: row.fullName,
      phone: contact ? row.phone : null,
      contactHidden: !contact,
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
