import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { apiUser } from "@/lib/auth/guards";

/**
 * GET /api/users/mentions → active users [{ id, name }]
 * Used by the comment composer @mention autocomplete.
 */
export async function GET() {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.isActive, true))
    .orderBy(asc(users.name));

  return NextResponse.json(rows);
}
