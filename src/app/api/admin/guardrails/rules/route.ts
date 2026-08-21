import { asc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { guardrailAudit, guardrailRules } from "@/db/schema-sms";
import { apiAdmin } from "@/lib/auth/guards";
import {
  GUARDRAIL_KINDS,
  GUARDRAIL_SEVERITIES,
  safeParseRuleConfig,
  type GuardrailKind,
} from "@/lib/guardrails/types";
import { readJson } from "../../_helpers";

/**
 * POST /api/admin/guardrails/rules — crée une règle.
 *
 * `origin: "custom"` et non « default » : « Tout réinitialiser » restaure les
 * règles semées et ne doit pas faire disparaître celles écrites à la main —
 * perdre le travail de quelqu'un en cliquant « réinitialiser » serait la pire
 * surprise possible.
 *
 * La clé est unique par portée. Elle sert d'identifiant stable quand le libellé
 * change, et c'est elle qu'un fork d'assistant surcharge.
 */
const createSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(60)
    // Une clé sert d'identifiant : on la garde lisible et sans surprise.
    .regex(/^[a-z0-9_]+$/, "minuscules, chiffres et tirets bas seulement"),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().default(null),
  kind: z.enum(GUARDRAIL_KINDS),
  config: z.unknown(),
  promptText: z.string().trim().max(2000).nullable().default(null),
  severity: z.enum(GUARDRAIL_SEVERITIES).default("block"),
  enabled: z.boolean().default(true),
  /** null = règle du noyau (tous les assistants). */
  assistantId: z.uuid().nullable().default(null),
});

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  // Une config invalide n'est jamais enregistrée : une règle cassée ne garde
  // pas la sortie, elle la laisse passer.
  const parsed = safeParseRuleConfig(body.kind as GuardrailKind, body.config ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_config", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  const existing = await db.query.guardrailRules.findFirst({
    where: body.assistantId
      ? (r, { and, eq: e }) => and(e(r.key, body.key), e(r.assistantId, body.assistantId!))
      : (r, { and, eq: e, isNull: n }) => and(e(r.key, body.key), n(r.assistantId)),
  });
  if (existing) return NextResponse.json({ error: "key_taken" }, { status: 409 });

  const [last] = await db
    .select({ orderIndex: guardrailRules.orderIndex })
    .from(guardrailRules)
    .where(body.assistantId ? eq(guardrailRules.assistantId, body.assistantId) : isNull(guardrailRules.assistantId))
    .orderBy(asc(guardrailRules.orderIndex))
    .limit(1);

  const [row] = await db
    .insert(guardrailRules)
    .values({
      scope: body.assistantId ? "assistant" : "core",
      assistantId: body.assistantId,
      key: body.key,
      label: body.label,
      description: body.description,
      kind: body.kind,
      config: parsed.data as Record<string, unknown>,
      promptText: body.promptText,
      severity: body.severity,
      origin: "custom",
      enabled: body.enabled,
      orderIndex: (last?.orderIndex ?? 0) + 100,
      updatedById: admin.id,
    })
    .returning();

  await db.insert(guardrailAudit).values({
    actorId: admin.id,
    action: "rule_created",
    target: `rule:${row.key}`,
    before: null,
    after: { kind: row.kind, severity: row.severity, config: row.config },
  });

  return NextResponse.json({ rule: row }, { status: 201 });
}
