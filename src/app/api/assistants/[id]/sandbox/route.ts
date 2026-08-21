import { NextResponse } from "next/server";
import { z } from "zod";
import { apiAdmin } from "@/lib/auth/guards";
import { simulateTurn } from "@/lib/agent/sandbox";

/**
 * POST /api/assistants/:id/sandbox — un tour d'essai.
 *
 * N'écrit rien, n'envoie rien, ne réserve rien : c'est un aperçu. Les appels
 * d'outils sont rapportés, jamais exécutés — un essai qui bloquerait une vraie
 * plage d'agenda serait un piège.
 */
const bodySchema = z.object({
  history: z
    .array(z.object({ role: z.enum(["assistant", "user"]), content: z.string().max(2000) }))
    .max(40)
    .default([]),
  // Vide autorisé : c'est le cas « l'assistant ouvre la conversation ».
  inbound: z.string().trim().max(2000).default(""),
  lead: z
    .object({
      firstName: z.string().trim().max(80).optional(),
      city: z.string().trim().max(80).optional(),
      budget: z.string().trim().max(80).optional(),
      projectType: z.string().trim().max(80).optional(),
    })
    .optional(),
  qualification: z.record(z.string(), z.unknown()).default({}),
  softRefusals: z.number().int().min(0).max(10).default(0),
  /** Défaut vrai : l'assistant reprend une conversation ouverte par une campagne. */
  openerSent: z.boolean().default(true),
  trigger: z.enum(["inbound", "lead_created", "category_changed", "manual"]).default("inbound"),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const result = await simulateTurn({ assistantId: id, ...parsed.data });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "sandbox_failed";
    if (message === "assistant_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (message === "assistant_not_compiled") {
      return NextResponse.json({ error: "not_compiled" }, { status: 409 });
    }
    return NextResponse.json({ error: "sandbox_failed", message }, { status: 500 });
  }
}

/** Un tour peut enchaîner classifieur, générateur et plusieurs juges. */
export const maxDuration = 120;
