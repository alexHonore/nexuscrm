import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { campaignEnrollments, campaigns } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { campaignConfigSchema, campaignRowToConfig } from "@/lib/campaigns/schema";

const CAMPAIGN_STATUSES = ["draft", "active", "paused", "archived"] as const;

const patchSchema = z.object({
  config: campaignConfigSchema.optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ config: campaignRowToConfig(row), status: row.status });
}

/**
 * PATCH /api/campaigns/:id — configuration et/ou état.
 *
 * Activer une campagne dont l'échelle est vide est refusé ICI : elle
 * inscrirait des gens sans jamais leur écrire, et rien à l'écran ne dirait
 * pourquoi il ne se passe rien.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const config = parsed.data.config;
  const nextStatus = parsed.data.status ?? row.status;
  const ladder = config ? config.ladder : (row.ladder as unknown[]);

  if (nextStatus === "active" && ladder.length === 0) {
    return NextResponse.json({ error: "empty_ladder" }, { status: 409 });
  }

  await db
    .update(campaigns)
    .set({
      ...(config
        ? {
            name: config.name,
            description: config.description,
            assistantId: config.assistantId,
            smsNumberId: config.smsNumberId,
            trigger: config.trigger,
            audience: config.audience,
            ladder: config.ladder,
            variants: config.variants,
            dailyEnrollmentCap: config.dailyEnrollmentCap,
            totalEnrollmentCap: config.totalEnrollmentCap,
            startsAt: config.startsAt,
            endsAt: config.endsAt,
            requireConsent: config.requireConsent,
          }
        : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, id));

  await logAudit({
    userId: admin.id,
    action: parsed.data.status ? `campaign.${parsed.data.status}` : "campaign.update",
    entity: "campaign",
    entityId: id,
    detail: { name: config?.name ?? row.name },
  });

  return NextResponse.json({ saved: true, status: nextStatus });
}

/**
 * DELETE — archive dès qu'une inscription existe. Les messages envoyés et leur
 * motif d'arrêt doivent rester lisibles : supprimer la campagne emporterait les
 * inscriptions en cascade, et avec elles la seule trace de qui a reçu quoi.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [used] = await db
    .select({ id: campaignEnrollments.id })
    .from(campaignEnrollments)
    .where(eq(campaignEnrollments.campaignId, id))
    .limit(1);

  if (used) {
    await db
      .update(campaigns)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(campaigns.id, id));
    await logAudit({
      userId: admin.id,
      action: "campaign.archive",
      entity: "campaign",
      entityId: id,
      detail: { name: row.name, reason: "has_enrollments" },
    });
    return NextResponse.json({ archived: true, deleted: false });
  }

  await db.delete(campaigns).where(eq(campaigns.id, id));
  await logAudit({
    userId: admin.id,
    action: "campaign.delete",
    entity: "campaign",
    entityId: id,
    detail: { name: row.name },
  });
  return NextResponse.json({ archived: false, deleted: true });
}
