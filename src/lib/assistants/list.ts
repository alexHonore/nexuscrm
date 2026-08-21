import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistants } from "@/db/schema-sms";

/**
 * La liste des assistants avec le nombre de messages écrits par chacun.
 *
 * Sous-requête en SQL BRUT, qualificateur explicite : dans la liste des
 * champs d'un select, drizzle rend `${assistants.id}` comme « "id" » tout
 * court, que la sous-requête résout sur messages — le compte valait toujours
 * 0, et « un assistant qui a écrit ne peut être qu'archivé » ne tenait plus.
 */
export async function listAssistantsWithCounts() {
  const rows = await db
    .select({
      id: assistants.id,
      name: assistants.name,
      description: assistants.description,
      status: assistants.status,
      version: assistants.version,
      goal: assistants.goal,
      suitePassed: assistants.suitePassed,
      needsRecompile: assistants.needsRecompile,
      compiledAt: assistants.compiledAt,
      updatedAt: assistants.updatedAt,
      messageCount: sql<number>`(select count(*)::int from messages m where m.assistant_id = assistants.id)`,
    })
    .from(assistants)
    .where(sql`${assistants.status} <> 'archived'`)
    .orderBy(desc(assistants.updatedAt), asc(assistants.name));
  const archived = await db
    .select({ id: assistants.id })
    .from(assistants)
    .where(eq(assistants.status, "archived"));
  return { rows, archivedCount: archived.length };
}
