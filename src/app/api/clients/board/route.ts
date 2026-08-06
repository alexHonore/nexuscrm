import { NextResponse } from "next/server";
import { apiUser } from "@/lib/auth/guards";
import {
  BOARD_CARD_LIMIT,
  getBoardData,
  type BoardClientRow,
} from "@/app/(app)/pipeline/board-data";

type BoardClientPayload = {
  id: string;
  fullName: string;
  phone: string;
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
 */
export async function GET() {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const board = await getBoardData();

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
