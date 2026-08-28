import { NextResponse } from "next/server";
import { db } from "@/db";
import { campaigns } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { campaignConfigSchema } from "@/lib/campaigns/schema";
import { listCampaignsWithCounts } from "@/lib/campaigns-server/list";
import { isForeignKeyViolation } from "@/lib/db-errors";
import { apiPerm } from "@/lib/permissions/server";

/**
 * Un assistant ou un numéro inconnu passe zod (c'est un UUID) et fait sauter
 * la clé étrangère : on le dit proprement (409) au lieu d'un 500 — même code
 * que PATCH /api/campaigns/:id.
 */
function missingReference(err: unknown): "assistant_not_found" | "sms_number_not_found" | null {
  if (isForeignKeyViolation(err, "campaigns_assistant_id_assistants_id_fk")) return "assistant_not_found";
  if (isForeignKeyViolation(err, "campaigns_sms_number_id_sms_numbers_id_fk")) return "sms_number_not_found";
  return null;
}

/** GET /api/campaigns — liste avec le décompte des inscriptions par état. */
export async function GET() {
  const actor = await apiPerm("admin.campaigns");
  if (actor instanceof NextResponse) return actor;

  const rows = await listCampaignsWithCounts();

  return NextResponse.json({ campaigns: rows });
}

/** POST /api/campaigns — crée un BROUILLON. Aucune campagne ne naît active. */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.campaigns");
  if (actor instanceof NextResponse) return actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = campaignConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const config = parsed.data;

  let row: { id: string; name: string };
  try {
    [row] = await db
      .insert(campaigns)
      .values({
        name: config.name,
        description: config.description,
        status: "draft",
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
        createdById: actor.user.id,
      })
      .returning({ id: campaigns.id, name: campaigns.name });
  } catch (err) {
    const missing = missingReference(err);
    if (missing) return NextResponse.json({ error: missing }, { status: 409 });
    throw err;
  }

  await logAudit({
    userId: actor.user.id,
    action: "campaign.create",
    entity: "campaign",
    entityId: row.id,
    detail: { name: row.name },
  });

  return NextResponse.json({ id: row.id, name: row.name }, { status: 201 });
}

