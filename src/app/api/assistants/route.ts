import { NextResponse } from "next/server";
import { asc, desc } from "drizzle-orm";
import { db } from "@/db";
import { assistants } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { assistantConfigInputSchema } from "@/lib/assistants/schema";
import { apiPerm } from "@/lib/permissions/server";

/**
 * GET /api/assistants — liste, la plus récemment modifiée d'abord.
 *
 * Deux gardes dans ce fichier, et c'est voulu : LIRE la liste demande
 * `admin.assistants`, la CRÉER demande `admin.assistantsEdit`. Un superviseur
 * doit pouvoir savoir quels robots parlent à ses clients sans pouvoir en
 * ajouter un.
 */
export async function GET() {
  const actor = await apiPerm("admin.assistants");
  if (actor instanceof NextResponse) return actor;

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
  const actor = await apiPerm("admin.assistantsEdit");
  if (actor instanceof NextResponse) return actor;

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
      secondaryLanguage: config.secondaryLanguage,
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
      createdById: actor.user.id,
    })
    .returning({ id: assistants.id, name: assistants.name });

  await logAudit({
    userId: actor.user.id,
    action: "assistant.create",
    entity: "assistant",
    entityId: row.id,
    detail: { name: row.name },
  });

  return NextResponse.json({ id: row.id, name: row.name }, { status: 201 });
}
