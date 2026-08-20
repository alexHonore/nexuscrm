import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { guardrailAudit, guardrailFixtures } from "@/db/schema-sms";
import { apiAdmin } from "@/lib/auth/guards";
import {
  GUARDRAIL_SEVERITIES,
  fixtureExpectationsSchema,
  fixtureSetupSchema,
} from "@/lib/guardrails/types";
import { readJson } from "../../../_helpers";

/** PATCH /api/admin/guardrails/fixtures/:id — édition d'une fixture de test. */
const patchSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  inbound: z.string().trim().min(1).max(1000).optional(),
  setup: fixtureSetupSchema.optional(),
  expectations: fixtureExpectationsSchema.optional(),
  severity: z.enum(GUARDRAIL_SEVERITIES).optional(),
  enabled: z.boolean().optional(),
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

  const before = await db.query.guardrailFixtures.findFirst({ where: eq(guardrailFixtures.id, id) });
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const patch: Partial<typeof guardrailFixtures.$inferInsert> = {
    updatedAt: new Date(),
    updatedById: admin.id,
  };
  if (body.label !== undefined) patch.label = body.label;
  if (body.inbound !== undefined) patch.inbound = body.inbound;
  if (body.setup !== undefined) patch.setup = body.setup;
  if (body.expectations !== undefined) patch.expectations = body.expectations;
  if (body.severity !== undefined) patch.severity = body.severity;
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.orderIndex !== undefined) patch.orderIndex = body.orderIndex;
  if (before.origin === "default") patch.modifiedFromDefault = true;

  const [after] = await db
    .update(guardrailFixtures)
    .set(patch)
    .where(eq(guardrailFixtures.id, id))
    .returning();

  await db.insert(guardrailAudit).values({
    actorId: admin.id,
    action: "fixture_edited",
    target: `fixture:${before.label}`,
    before: { severity: before.severity, enabled: before.enabled },
    after: { severity: after.severity, enabled: after.enabled },
  });

  return NextResponse.json({ fixture: after });
}
