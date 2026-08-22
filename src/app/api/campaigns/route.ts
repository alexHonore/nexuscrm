import { NextResponse } from "next/server";
import { db } from "@/db";
import { campaigns } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { campaignConfigSchema } from "@/lib/campaigns/schema";
import { listCampaignsWithCounts } from "@/lib/campaigns-server/list";

/** GET /api/campaigns — liste avec le décompte des inscriptions par état. */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const rows = await listCampaignsWithCounts();

  return NextResponse.json({ campaigns: rows });
}

/** POST /api/campaigns — crée un BROUILLON. Aucune campagne ne naît active. */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

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

  const [row] = await db
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
      createdById: admin.id,
    })
    .returning({ id: campaigns.id, name: campaigns.name });

  await logAudit({
    userId: admin.id,
    action: "campaign.create",
    entity: "campaign",
    entityId: row.id,
    detail: { name: row.name },
  });

  return NextResponse.json({ id: row.id, name: row.name }, { status: 201 });
}

