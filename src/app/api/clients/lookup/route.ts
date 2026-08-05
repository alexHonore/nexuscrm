import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { apiUser } from "@/lib/auth/guards";
import { phoneMatchKey } from "@/lib/phone";

/**
 * GET /api/clients/lookup?phone=E164
 * → { client: { id, fullName, category, city } | null }
 *
 * Used by the webphone to identify incoming calls. Matching is loose:
 * last-10-digits (phoneMatchKey) against both phone and phoneAlt.
 * `category` is the category object ({ id, key, nameFr, nameEn, color }) or null.
 */
export async function GET(request: NextRequest) {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const key = phoneMatchKey(request.nextUrl.searchParams.get("phone"));
  if (!key) return NextResponse.json({ client: null });

  const match = await db.query.clients.findFirst({
    where: sql`
      RIGHT(REGEXP_REPLACE(${clients.phone}, '[^0-9]', '', 'g'), 10) = ${key}
      OR RIGHT(REGEXP_REPLACE(COALESCE(${clients.phoneAlt}, ''), '[^0-9]', '', 'g'), 10) = ${key}
    `,
    with: { category: true },
  });

  if (!match) return NextResponse.json({ client: null });

  return NextResponse.json({
    client: {
      id: match.id,
      fullName: match.fullName,
      category: match.category
        ? {
            id: match.category.id,
            key: match.category.key,
            nameFr: match.category.nameFr,
            nameEn: match.category.nameEn,
            color: match.category.color,
          }
        : null,
      city: match.city,
    },
  });
}
