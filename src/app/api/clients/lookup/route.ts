import { sql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { grantsOnClient, apiActor } from "@/lib/permissions/server";
import { phoneMatchKey } from "@/lib/phone";

/**
 * GET /api/clients/lookup?phone=E164
 * → { client: { id, fullName, canOpen, contactHidden, phone, category, city } | null }
 *
 * Used by the webphone to identify incoming calls. Matching is loose:
 * last-10-digits (phoneMatchKey) against both phone and phoneAlt.
 * `category` is the category object ({ id, key, nameFr, nameEn, color }) or null.
 *
 * ── Pourquoi cette route N'EST PAS filtrée par la portée ────────────────────
 *
 * Partout ailleurs, une fiche invisible se comporte comme une fiche absente.
 * Ici, non — et c'est délibéré.
 *
 * Un appel entrant n'est pas une consultation : le téléphone SONNE, le numéro
 * est déjà sur l'écran de celui qui va décrocher, et il doit pouvoir dire
 * « bonjour Madame Tremblay » plutôt que « allô ? ». Refuser de nommer
 * l'appelant parce que sa fiche est tenue par le patron ne cache rien (le
 * numéro, lui, est arrivé quand même) et fait rater l'appel.
 *
 * Le compromis se joue donc sur le CONTENU, pas sur l'existence : on répond
 * pour n'importe quelle fiche, mais on ne rend que ce que ce regard a le droit
 * de lire — le nom pour décrocher, et rien de plus. `canOpen: false` dit à
 * l'écran de ne pas proposer de lien vers une fiche qui l'accueillerait par un
 * « introuvable », et les coordonnées ne partent que si la case `contact` du
 * compartiment est ouverte. Le reste (catégorie, ville, historique) attend
 * d'être ouvert par la matrice.
 */
export async function GET(request: NextRequest) {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;

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

  const grants = await grantsOnClient(actor, match);

  return NextResponse.json({
    client: {
      id: match.id,
      fullName: match.fullName,
      /** La fiche s'ouvre-t-elle ? Sinon l'écran affiche le nom sans lien. */
      canOpen: grants.visible,
      contactHidden: !grants.contact,
      phone: grants.contact ? match.phone : null,
      category:
        grants.visible && match.category
          ? {
              id: match.category.id,
              key: match.category.key,
              nameFr: match.category.nameFr,
              nameEn: match.category.nameEn,
              color: match.category.color,
            }
          : null,
      city: grants.visible ? match.city : null,
    },
  });
}
