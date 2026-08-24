import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { enrollClients } from "@/lib/campaigns-server/enroll";
import { applyEnrollmentAction } from "@/lib/campaigns-server/enrollment-admin";

/**
 * Collection des inscriptions d'une campagne.
 *
 *  - POST  { clientIds }              → AJOUTE ces fiches à la campagne
 *                                       (une par une ou en lot). L'éligibilité
 *                                       est vérifiée fiche par fiche (numéro,
 *                                       désabonnement, ne-pas-appeler, plafond,
 *                                       déjà inscrite) : la réponse dit qui est
 *                                       entré et qui a été écarté, et pourquoi.
 *  - PATCH { action, enrollmentIds }  → applique pause / reprise / retrait à un
 *                                       LOT d'inscriptions existantes.
 *
 * Réservé à l'admin. Chaque geste est audité.
 */

const MAX_BATCH = 500;

const UUID = z.uuid();
const addSchema = z.object({ clientIds: z.array(UUID).min(1).max(MAX_BATCH) });
const bulkSchema = z.object({
  action: z.enum(["pause", "resume", "remove"]),
  enrollmentIds: z.array(UUID).min(1).max(MAX_BATCH),
});

async function readBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S> | NextResponse> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }
  return parsed.data as z.infer<S>;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!UUID.safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const body = await readBody(req, addSchema);
  if (body instanceof NextResponse) return body;
  // Dédoublonnage : la même fiche cochée deux fois ne compte qu'une.
  const clientIds = [...new Set(body.clientIds)];

  let results;
  try {
    results = await enrollClients(id, clientIds);
  } catch (err) {
    if (err instanceof Error && err.message === "campaign_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }

  const added = results.filter((r) => r.enrolled).length;
  await logAudit({
    userId: admin.id,
    action: "campaign.enrollment.add",
    entity: "campaign",
    entityId: id,
    detail: { requested: clientIds.length, added, skipped: clientIds.length - added },
  });

  return NextResponse.json({ results, added, skipped: clientIds.length - added });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!UUID.safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const body = await readBody(req, bulkSchema);
  if (body instanceof NextResponse) return body;
  const enrollmentIds = [...new Set(body.enrollmentIds)];

  // Chaque inscription est chargée EN vérifiant qu'elle appartient à cette
  // campagne (anti-IDOR, dans applyEnrollmentAction) : un id d'une autre
  // campagne compte comme un échec, jamais comme une action croisée.
  const outcomes = await Promise.all(
    enrollmentIds.map(async (enrollmentId) => {
      const r = await applyEnrollmentAction(id, enrollmentId, body.action);
      return { enrollmentId, ok: r.ok, ...(r.ok ? {} : { error: r.error }) };
    }),
  );
  const done = outcomes.filter((o) => o.ok).length;

  await logAudit({
    userId: admin.id,
    action: `campaign.enrollment.bulk_${body.action}`,
    entity: "campaign",
    entityId: id,
    detail: { requested: enrollmentIds.length, done, failed: enrollmentIds.length - done },
  });

  return NextResponse.json({ results: outcomes, done, failed: enrollmentIds.length - done });
}

/** Un ajout peut toucher des centaines de fiches. */
export const maxDuration = 300;
