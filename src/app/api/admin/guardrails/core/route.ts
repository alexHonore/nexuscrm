import { desc, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { assistants, guardrailAudit, promptCores } from "@/db/schema-sms";
import { apiAdmin } from "@/lib/auth/guards";
import { readJson } from "../../_helpers";

/**
 * POST /api/admin/guardrails/core — publie une NOUVELLE version du noyau L0.
 *
 * Une version existante n'est JAMAIS modifiée. Un message envoyé le mois
 * dernier doit rester reconstituable : `assistant_versions` et
 * `agent_turn_traces` référencent un numéro de version, et le réécrire ferait
 * mentir tout l'historique.
 *
 * Publier rend périmé le prompt compilé de CHAQUE assistant — la porte
 * d'activation (application + trigger) exige déjà que le noyau compilé soit le
 * plus récent. On pose donc `needs_recompile` explicitement, pour que l'écran
 * le dise au lieu de laisser la découverte à l'activation suivante.
 */
const bodySchema = z.object({
  body: z.string().trim().min(50).max(20_000),
  notes: z.string().trim().max(500).nullable().default(null),
});

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const input = await readJson(req, bodySchema);
  if (input instanceof NextResponse) return input;

  const [latest] = await db
    .select({ version: promptCores.version, body: promptCores.body })
    .from(promptCores)
    .orderBy(desc(promptCores.version))
    .limit(1);

  if (latest && latest.body === input.body) {
    // Republier un texte identique créerait une version qui périme tous les
    // assistants sans rien changer à ce qu'ils disent.
    return NextResponse.json({ error: "unchanged", version: latest.version }, { status: 409 });
  }

  const nextVersion = (latest?.version ?? 0) + 1;

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(promptCores)
      .values({
        version: nextVersion,
        body: input.body,
        notes: input.notes,
        createdById: admin.id,
      })
      .returning({ version: promptCores.version });

    // Tout assistant compilé contre l'ancien noyau devient périmé.
    const stale = await tx
      .update(assistants)
      .set({ needsRecompile: true, suitePassed: false, updatedAt: new Date() })
      .where(sql`${assistants.status} <> 'archived'`)
      .returning({ id: assistants.id });

    await tx.insert(guardrailAudit).values({
      actorId: admin.id,
      action: "core_published",
      target: `core:v${row.version}`,
      before: latest ? { version: latest.version } : null,
      after: { version: row.version, staleAssistants: stale.length },
    });

    return { version: row.version, staleAssistants: stale.length };
  });

  return NextResponse.json(result, { status: 201 });
}

