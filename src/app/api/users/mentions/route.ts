import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { apiPerm } from "@/lib/permissions/server";

/**
 * GET /api/users/mentions → active users [{ id, name }]
 * Used by the comment composer @mention autocomplete.
 *
 * Réservé à qui peut COMMENTER : une mention crée une notification chez
 * l'autre, avec un extrait du commentaire dedans. Sans ce droit, la liste ne
 * sert à rien — et elle donne le trombinoscope complet de l'entreprise à un
 * compte qui n'a le droit de rien écrire.
 */
export async function GET() {
  const auth = await apiPerm("clients.comment");
  if (auth instanceof NextResponse) return auth;

  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(asc(users.name));

  return NextResponse.json(rows);
}
