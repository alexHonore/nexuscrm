import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { guardrailAudit, guardrailRules } from "@/db/schema-sms";
import { apiAdmin } from "@/lib/auth/guards";
import { invalidateAssistantsForGuardrails } from "@/lib/guardrails/store";
import { GUARDRAIL_SEVERITIES, safeParseRuleConfig, type GuardrailKind } from "@/lib/guardrails/types";
import { readJson } from "../../../_helpers";

/**
 * PATCH /api/admin/guardrails/rules/:id — édition d'une règle.
 *
 * Toute modification pose `modified_from_default` : une valeur par défaut qui
 * a divergé doit se voir d'un coup d'œil, jamais diverger en silence. Le
 * détail avant/après part dans `guardrail_audit`.
 *
 * Désactiver ou mettre `off` une règle la retire réellement du circuit : rien
 * dans le moteur ne la réimpose. C'est le comportement voulu de l'interrupteur.
 */
const patchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  promptText: z.string().trim().max(2000).nullable().optional(),
  severity: z.enum(GUARDRAIL_SEVERITIES).optional(),
  enabled: z.boolean().optional(),
  config: z.unknown().optional(),
  orderIndex: z.number().int().min(0).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const before = await db.query.guardrailRules.findFirst({ where: eq(guardrailRules.id, id) });
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Une config invalide n'est jamais enregistrée : une règle cassée ne garde
  // pas la sortie, elle la laisse passer.
  if (body.config !== undefined) {
    const parsed = safeParseRuleConfig(before.kind as GuardrailKind, body.config);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_config", issues: parsed.error.issues },
        { status: 422 },
      );
    }
  }

  const patch: Partial<typeof guardrailRules.$inferInsert> = { updatedAt: new Date(), updatedById: admin.id };
  if (body.label !== undefined) patch.label = body.label;
  if (body.description !== undefined) patch.description = body.description;
  if (body.promptText !== undefined) patch.promptText = body.promptText;
  if (body.severity !== undefined) patch.severity = body.severity;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.config !== undefined) patch.config = body.config as Record<string, unknown>;
  if (body.orderIndex !== undefined) patch.orderIndex = body.orderIndex;
  if (before.origin === "default") patch.modifiedFromDefault = true;

  const [after] = await db
    .update(guardrailRules)
    .set(patch)
    .where(eq(guardrailRules.id, id))
    .returning();

  // L6 recopie le texte de la règle et la suite la rejoue : les assistants
  // concernés sont périmés, et la réponse le dit.
  const staleAssistants = await invalidateAssistantsForGuardrails({ assistantId: before.assistantId });

  await db.insert(guardrailAudit).values({
    actorId: admin.id,
    action: body.enabled === false ? "rule_disabled" : "rule_edited",
    target: `rule:${before.key}`,
    before: {
      severity: before.severity,
      enabled: before.enabled,
      promptText: before.promptText,
      config: before.config,
    },
    after: {
      severity: after.severity,
      enabled: after.enabled,
      promptText: after.promptText,
      config: after.config,
      staleAssistants,
    },
  });

  return NextResponse.json({ rule: after, staleAssistants });
}

/** DELETE — supprime une règle. L'admin peut tout supprimer ; « Tout
 * réinitialiser » (§16.6) la recréera si elle venait de la semence. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const [deleted] = await db.delete(guardrailRules).where(eq(guardrailRules.id, id)).returning();
  if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Une règle disparue change L6 et ce que la suite mesure : on périme.
  const staleAssistants = await invalidateAssistantsForGuardrails({ assistantId: deleted.assistantId });

  await db.insert(guardrailAudit).values({
    actorId: admin.id,
    action: "rule_deleted",
    target: `rule:${deleted.key}`,
    before: { severity: deleted.severity, enabled: deleted.enabled, config: deleted.config },
    after: { staleAssistants },
  });
  return NextResponse.json({ ok: true, staleAssistants });
}
