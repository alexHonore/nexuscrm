import { NextResponse } from "next/server";
import { asc, desc } from "drizzle-orm";
import { db } from "@/db";
import { assistants } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { assistantConfigInputSchema } from "@/lib/assistants/schema";

/** GET /api/assistants — liste, la plus récemment modifiée d'abord. */
export async function GET() {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const rows = await db
    .select({
      id: assistants.id,
      name: assistants.name,
      description: assistants.description,
      status: assistants.status,
      version: assistants.version,
      suitePassed: assistants.suitePassed,
      needsRecompile: assistants.needsRecompile,
      compiledAt: assistants.compiledAt,
      updatedAt: assistants.updatedAt,
    })
    .from(assistants)
    .orderBy(desc(assistants.updatedAt), asc(assistants.name));

  return NextResponse.json({ assistants: rows });
}

/**
 * POST /api/assistants — crée un BROUILLON.
 *
 * Aucun assistant ne naît actif : il n'a ni prompt compilé ni suite exécutée,
 * et la porte d'activation le refuserait de toute façon.
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = assistantConfigInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }
  const config = parsed.data;

  const [row] = await db
    .insert(assistants)
    .values({
      name: config.name,
      description: config.description,
      status: "draft",
      language: config.language,
      identity: config.identity,
      goal: config.goal,
      approach: config.approach,
      knowledge: config.knowledge,
      objectionPacks: config.objectionPacks,
      tools: config.tools,
      model: config.model,
      promptMode: config.promptMode,
      systemPromptOverride: config.systemPromptOverride,
      layerOverrides: config.layerOverrides,
      turnInstructions: config.turnInstructions,
      includeRuntimeLayer: config.includeRuntimeLayer,
      requireSuitePass: config.requireSuitePass,
      needsRecompile: true,
      createdById: admin.id,
    })
    .returning({ id: assistants.id, name: assistants.name });

  await logAudit({
    userId: admin.id,
    action: "assistant.create",
    entity: "assistant",
    entityId: row.id,
    detail: { name: row.name },
  });

  return NextResponse.json({ id: row.id, name: row.name }, { status: 201 });
}
