import { asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { apiUser } from "@/lib/auth/guards";

/**
 * GET /api/categories — statuts du pipeline, dans l'ordre du tableau.
 * Accessible aux téléphonistes : le popup d'après-appel s'en sert pour ses
 * boutons (classer l'appel = déplacer la fiche dans ce statut).
 */
export async function GET() {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const rows = await db
    .select({
      id: categories.id,
      key: categories.key,
      nameFr: categories.nameFr,
      nameEn: categories.nameEn,
      color: categories.color,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .orderBy(asc(categories.sortOrder));

  return NextResponse.json({ categories: rows });
}
