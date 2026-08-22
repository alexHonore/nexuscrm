import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { assistants, campaignEnrollments, campaigns, smsNumbers } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { campaignConfigSchema, campaignRowToConfig } from "@/lib/campaigns/schema";
import { closeCampaignEnrollments } from "@/lib/campaigns-server/lifecycle";

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
 * Ce qu'il faut pour qu'une campagne ACTIVE fasse vraiment quelque chose.
 *
 * Activer est refusé ICI, côté serveur, dès qu'un élément manque : une
 * campagne active qui inscrit des gens sans jamais leur écrire paraît vivante,
 * et rien à l'écran ne dit pourquoi il ne se passe rien.
 *
 *  · `empty_ladder` — aucun barreau.
 *  · `assistant_inactive` — un barreau « l'assistant rédige » (corps vide) sans
 *    assistant ACTIF : le tour d'agent se terminerait « pas d'assistant » à
 *    chaque barreau, l'échelle avancerait, rien ne partirait.
 *  · `no_sender` — numéro épinglé inactif, ou aucun numéro actif quand la
 *    campagne s'en remet au premier disponible : chaque barreau serait repoussé
 *    d'heure en heure, indéfiniment.
 */
async function activationProblem(config: {
  ladder: { body: string | null }[];
  assistantId: string | null;
  smsNumberId: string | null;
}): Promise<string | null> {
  if (config.ladder.length === 0) return "empty_ladder";

  if (config.ladder.some((rung) => rung.body === null)) {
    const assistant = config.assistantId
      ? await db.query.assistants.findFirst({
          where: eq(assistants.id, config.assistantId),
          columns: { status: true },
        })
      : undefined;
    if (!assistant || assistant.status !== "active") return "assistant_inactive";
  }

  const sender = config.smsNumberId
    ? await db.query.smsNumbers.findFirst({
        where: eq(smsNumbers.id, config.smsNumberId),
        columns: { active: true },
      })
    : await db.query.smsNumbers.findFirst({
        where: eq(smsNumbers.active, true),
        columns: { active: true },
      });
  if (!sender?.active) return "no_sender";

  return null;
}

/**
 * PATCH /api/campaigns/:id — configuration et/ou état.
 *
 * Archiver clôt les inscriptions en vol (voir `lifecycle.ts`) : sinon elles
 * resteraient « actives » pour toujours, comptées en cours et bloquant
 * d'autres campagnes. Mettre en pause ne clôt rien — la file ignore déjà les
 * campagnes en pause, et les inscriptions doivent repartir à la reprise.
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

  // Un assistant inconnu passe zod (c'est un UUID) et ferait sauter la clé
  // étrangère : on le dit proprement au lieu d'un 500.
  if (config?.assistantId) {
    const exists = await db.query.assistants.findFirst({
      where: eq(assistants.id, config.assistantId),
      columns: { id: true },
    });
    if (!exists) return NextResponse.json({ error: "assistant_not_found" }, { status: 409 });
  }

  if (nextStatus === "active") {
    // La configuration qui sera ACTIVE : celle envoyée, sinon celle en base.
    const effective = config ?? campaignRowToConfig(row);
    const problem = await activationProblem(effective);
    if (problem) return NextResponse.json({ error: problem }, { status: 409 });
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
          }
        : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      updatedAt: new Date(),
    })
    .where(eq(campaigns.id, id));

  const closed =
    parsed.data.status === "archived" && row.status !== "archived"
      ? await closeCampaignEnrollments(id)
      : null;

  await logAudit({
    userId: admin.id,
    action: parsed.data.status ? `campaign.${parsed.data.status}` : "campaign.update",
    entity: "campaign",
    entityId: id,
    detail: { name: config?.name ?? row.name, ...(closed ? { closedEnrollments: closed.closed } : {}) },
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
    const closed = await closeCampaignEnrollments(id);
    await logAudit({
      userId: admin.id,
      action: "campaign.archive",
      entity: "campaign",
      entityId: id,
      detail: { name: row.name, reason: "has_enrollments", closedEnrollments: closed.closed },
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
