import { asc, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { guardrailAudit, guardrailFixtures } from "@/db/schema-sms";
import { apiAdmin } from "@/lib/auth/guards";
import { invalidateAssistantsForGuardrails } from "@/lib/guardrails/store";
import {
  GUARDRAIL_SEVERITIES,
  fixtureExpectationsSchema,
  fixtureSetupSchema,
} from "@/lib/guardrails/types";
import { readJson } from "../../_helpers";

/**
 * POST /api/admin/guardrails/fixtures — crée une fixture.
 *
 * `origin: "custom"` : « Tout réinitialiser » restaure les fixtures semées et
 * ne doit pas emporter les scénarios écrits à la main.
 *
 * Une fixture nouvelle périme la suite de chaque assistant : leur vert a été
 * obtenu sans ce scénario. On pose les deux drapeaux (recompilation + suite),
 * comme pour les règles, pour que la liste le montre d'un coup d'œil.
 */
const createSchema = z.object({
  label: z.string().trim().min(1).max(160),
  inbound: z.string().trim().min(1).max(1000),
  setup: fixtureSetupSchema.prefault({}),
  expectations: fixtureExpectationsSchema.prefault({}),
  severity: z.enum(GUARDRAIL_SEVERITIES).default("block"),
  enabled: z.boolean().default(true),
});

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  const [last] = await db
    .select({ orderIndex: guardrailFixtures.orderIndex })
    .from(guardrailFixtures)
    .where(isNull(guardrailFixtures.assistantId))
    .orderBy(asc(guardrailFixtures.orderIndex))
    .limit(1);

  const [row] = await db
    .insert(guardrailFixtures)
    .values({
      scope: "core",
      assistantId: null,
      key: null,
      label: body.label,
      setup: body.setup,
      inbound: body.inbound,
      expectations: body.expectations,
      severity: body.severity,
      origin: "custom",
      enabled: body.enabled,
      orderIndex: (last?.orderIndex ?? 0) + 100,
      updatedById: admin.id,
    })
    .returning();

  const staleAssistants = await invalidateAssistantsForGuardrails({ assistantId: null });

  await db.insert(guardrailAudit).values({
    actorId: admin.id,
    action: "fixture_created",
    target: `fixture:${row.id}`,
    before: null,
    after: { label: row.label, severity: row.severity, staleAssistants },
  });

  return NextResponse.json({ fixture: row, staleAssistants }, { status: 201 });
}
