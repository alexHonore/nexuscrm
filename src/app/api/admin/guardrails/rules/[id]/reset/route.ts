import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { guardrailAudit, guardrailRules } from "@/db/schema-sms";
import { apiAdmin } from "@/lib/auth/guards";
import { invalidateAssistantsForGuardrails } from "@/lib/guardrails/store";

/**
 * POST /api/admin/guardrails/rules/:id/reset — restaure EXACTEMENT l'état
 * semé depuis `default_snapshot`. Disponible seulement sur une règle d'origine
 * `default` qui a divergé. Restaurer est une modification comme une autre :
 * les assistants concernés sont périmés.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const before = await db.query.guardrailRules.findFirst({ where: eq(guardrailRules.id, id) });
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const snapshot = before.defaultSnapshot as Record<string, unknown> | null;
  if (before.origin !== "default" || !snapshot) {
    return NextResponse.json({ error: "no_default_snapshot" }, { status: 409 });
  }

  const [after] = await db
    .update(guardrailRules)
    .set({
      label: String(snapshot.label ?? before.label),
      description: (snapshot.description as string | null) ?? null,
      config: (snapshot.config as Record<string, unknown>) ?? {},
      promptText: (snapshot.promptText as string | null) ?? null,
      severity: String(snapshot.severity ?? "block"),
      enabled: snapshot.enabled !== false,
      orderIndex: Number(snapshot.orderIndex ?? before.orderIndex),
      modifiedFromDefault: false,
      updatedById: admin.id,
      updatedAt: new Date(),
    })
    .where(eq(guardrailRules.id, id))
    .returning();

  const staleAssistants = await invalidateAssistantsForGuardrails({ assistantId: before.assistantId });

  await db.insert(guardrailAudit).values({
    actorId: admin.id,
    action: "rule_reset",
    target: `rule:${before.key}`,
    before: { severity: before.severity, enabled: before.enabled, config: before.config },
    after: { severity: after.severity, enabled: after.enabled, config: after.config, staleAssistants },
  });

  return NextResponse.json({ rule: after, staleAssistants });
}
