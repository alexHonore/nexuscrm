import { NextResponse } from "next/server";
import { apiActor } from "@/lib/permissions/server";
import {
  BOARD_CARD_LIMIT,
  getBoardData,
  type BoardClientRow,
} from "@/app/(app)/pipeline/board-data";

type BoardClientPayload = {
  id: string;
  fullName: string;
  /** null quand les coordonnées ne sont pas ouvertes sur cette fiche. */
  phone: string | null;
  /** Numéro absent par DROIT — de quoi afficher la pastille « Masqué ». */
  contactHidden: boolean;
  city: string | null;
  nextFollowupAt: Date | null;
  doNotCall: boolean;
  lastDisposition: string | null;
  updatedAt: Date;
};

type BoardColumnPayload = {
  /** null = colonne « Sans catégorie » (présente seulement si de tels clients existent). */
  category: {
    id: number;
    key: string | null;
    nameFr: string;
    nameEn: string;
    color: string;
    sortOrder: number;
  } | null;
  /** Nombre total de clients dans la catégorie (peut dépasser clients.length). */
  total: number;
  /** Les ~BOARD_CARD_LIMIT clients les plus récents (updated_at desc). */
  clients: BoardClientPayload[];
};

function serializeClient(c: BoardClientRow): BoardClientPayload {
  return {
    id: c.id,
    fullName: c.fullName,
    phone: c.phone,
    contactHidden: c.contactHidden,
    city: c.city,
    nextFollowupAt: c.nextFollowupAt,
    doNotCall: c.doNotCall,
    lastDisposition: c.lastDisposition,
    updatedAt: c.updatedAt,
  };
}

/**
 * GET /api/clients/board
 * → { columns: BoardColumnPayload[], limit: number }
 *
 * Colonnes du pipeline (catégories par sortOrder), chacune avec son compte
 * total et ses ~40 clients les plus récents. Efficace : une requête de
 * comptes groupés + une sélection fenêtrée (voir getBoardData).
 *
 * Cartes ET comptes sont bornés à la portée de celui qui demande : le sondage
 * de fond du tableau ne doit pas rendre ce que la page a refusé d'afficher.
 */
export async function GET() {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;

  const board = await getBoardData(actor);

  const columns: BoardColumnPayload[] = board.categories.map((cat) => ({
    category: {
      id: cat.id,
      key: cat.key,
      nameFr: cat.nameFr,
      nameEn: cat.nameEn,
      color: cat.color,
      sortOrder: cat.sortOrder,
    },
    total: board.totals.get(cat.id) ?? 0,
    clients: (board.clientsByCategory.get(cat.id) ?? []).map(serializeClient),
  }));

  const uncategorizedTotal = board.totals.get(null) ?? 0;
  if (uncategorizedTotal > 0) {
    columns.push({
      category: null,
      total: uncategorizedTotal,
      clients: (board.clientsByCategory.get(null) ?? []).map(serializeClient),
    });
  }

  return NextResponse.json({ columns, limit: BOARD_CARD_LIMIT });
}
