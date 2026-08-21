import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { importAssistant, previewImport } from "@/lib/assistants/transfer";

/**
 * POST /api/assistants/import — prévisualise ou importe un fichier.
 *
 * Deux temps volontairement séparés : `preview` ne touche à rien et sert à
 * choisir les liaisons ; `commit` écrit. Sans ce détour, un fichier venu d'une
 * autre base rattacherait des rendez-vous à des identifiants qui, ici,
 * désignent quelqu'un d'autre.
 */

const bodySchema = z.object({
  mode: z.enum(["preview", "commit"]).default("preview"),
  bundle: z.unknown(),
  /** valeur d'origine → identifiant local choisi. */
  resolution: z.record(z.string(), z.string().nullable()).default({}),
  nameOverride: z.string().trim().min(1).max(120).optional(),
  runSuite: z.boolean().default(true),
});

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

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
    if (parsed.data.mode === "preview") {
      const preview = await previewImport(parsed.data.bundle);
      return NextResponse.json(preview);
    }

    const result = await importAssistant(parsed.data.bundle, {
      actorId: admin.id,
      resolution: parsed.data.resolution,
      nameOverride: parsed.data.nameOverride,
      runSuite: parsed.data.runSuite,
    });
    await logAudit({
      userId: admin.id,
      action: "assistant.import",
      entity: "assistant",
      entityId: result.assistantId,
      detail: {
        warnings: result.warnings.map((w) => w.code),
        compiled: result.compiled,
        suitePassed: result.suitePassed,
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // Un fichier mal formé est une erreur de l'appelant, pas du serveur.
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_bundle", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "import_failed";
    return NextResponse.json({ error: "import_failed", message }, { status: 500 });
  }
}

/** La suite peut prendre plusieurs minutes : même marge que /suite. */
export const maxDuration = 300;
