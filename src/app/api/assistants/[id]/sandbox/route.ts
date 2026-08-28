import { NextResponse } from "next/server";
import { z } from "zod";
import { simulateTurn } from "@/lib/agent/sandbox";
import { apiPerm } from "@/lib/permissions/server";

/**
 * POST /api/assistants/:id/sandbox — un tour d'essai.
 *
 * N'écrit rien, n'envoie rien, ne réserve rien : c'est un aperçu. Les appels
 * d'outils sont simulés, jamais exécutés — un essai qui bloquerait une vraie
 * plage d'agenda serait un piège.
 *
 * Il demande pourtant `admin.assistantsEdit` et non le simple droit de LIRE :
 * chaque tour appelle un modèle et se paie. Ne rien enregistrer ne rend pas un
 * geste gratuit, et une boucle d'essais est la façon la plus rapide de brûler
 * le crédit de l'installation.
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
  /**
   * Tour proactif (ouverture ou relance) : le barreau et le contexte de
   * campagne que la production donnerait au modèle. Optionnel — les appelants
   * existants n'en envoient pas et obtiennent une ouverture sans contexte.
   */
  outreach: z
    .object({
      step: z.number().int().min(0).max(20).default(0),
      campaignName: z.string().trim().max(120).optional(),
      campaignDescription: z.string().trim().max(600).optional(),
      ladderLength: z.number().int().min(1).max(30).optional(),
    })
    .optional(),
});

/**
 * Garde-fou de débit, PAR INSTANCE et par admin : un tour d'essai enchaîne
 * classifieur, jusqu'à deux générateurs et plusieurs juges — une boucle qui
 * martèle l'endpoint coûte vite. C'est une protection de bonne foi (un
 * serverless redémarré repart à zéro), pas un compteur de facturation : le
 * coût réel est rapporté tour par tour dans `usage`, à l'écran.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_TURNS = 20;
const recentTurns = new Map<string, number[]>();

function rateLimited(adminId: string, now = Date.now()): boolean {
  const stamps = (recentTurns.get(adminId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (stamps.length >= RATE_MAX_TURNS) {
    recentTurns.set(adminId, stamps);
    return true;
  }
  stamps.push(now);
  recentTurns.set(adminId, stamps);
  return false;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistantsEdit");
  if (actor instanceof NextResponse) return actor;

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

  if (rateLimited(actor.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
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

/** Un tour peut enchaîner classifieur, générateur(s) et plusieurs juges. */
export const maxDuration = 120;
