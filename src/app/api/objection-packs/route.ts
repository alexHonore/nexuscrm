import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { objectionPacks } from "@/db/schema-sms";
import { logAudit } from "@/lib/audit";
import { objectionItemSchema } from "@/lib/guardrails/types";
import { apiPerm } from "@/lib/permissions/server";

/**
 * Les paquets d'objections — jusqu'ici semés une fois et jamais modifiables.
 *
 * L'onglet n'offrait que des cases à cocher : on choisissait entre deux
 * paquets écrits par quelqu'un d'autre, sans pouvoir en lire le contenu, en
 * corriger une phrase ni en ajouter une. Or une objection est ce qu'un
 * courtier entend tous les jours et reformule sans arrêt — c'est la matière la
 * plus vivante de la configuration.
 *
 * Rien n'est codé en dur, comme pour les garde-fous : tout paquet, y compris
 * ceux de la semence, se lit, se modifie et se supprime.
 */

/**
 * Un identifiant STABLE, écrit une fois.
 *
 * C'est lui que `assistants.objection_packs` référence et que le fichier
 * d'export transporte : le renommer romprait chaque assistant qui l'utilise,
 * d'où l'absence de `id` dans le schéma de modification.
 */
const idSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9_]+$/, "minuscules, chiffres et tirets bas seulement");

export const packInputSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(120),
  language: z.string().trim().min(2).max(10).default("fr-CA"),
  items: z.array(objectionItemSchema).max(40).default([]),
});

/** GET /api/objection-packs — tous les paquets, contenu compris. */
export async function GET() {
  const actor = await apiPerm("admin.assistants");
  if (actor instanceof NextResponse) return actor;

  const rows = await db.select().from(objectionPacks).orderBy(asc(objectionPacks.label));
  return NextResponse.json({ packs: rows });
}

/** POST /api/objection-packs — crée un paquet. */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.assistants");
  if (actor instanceof NextResponse) return actor;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = packInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  const existing = await db.query.objectionPacks.findFirst({
    where: (p, { eq }) => eq(p.id, parsed.data.id),
  });
  // Un identifiant déjà pris écraserait le paquet d'un autre assistant.
  if (existing) return NextResponse.json({ error: "id_taken" }, { status: 409 });

  const [row] = await db
    .insert(objectionPacks)
    .values({
      id: parsed.data.id,
      label: parsed.data.label,
      language: parsed.data.language,
      items: parsed.data.items,
      isBuiltin: false,
      updatedAt: new Date(),
    })
    .returning();

  await logAudit({
    userId: actor.user.id,
    action: "objection_pack.create",
    entity: "objection_pack",
    entityId: row.id,
    detail: { label: row.label, items: parsed.data.items.length },
  });

  return NextResponse.json({ pack: row }, { status: 201 });
}
