import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories, clients, sources, users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { isForeignKeyViolation } from "@/lib/db-errors";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { readJson } from "../_helpers";

const rowSchema = z.object({
  fullName: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(64).optional(),
  phoneAlt: z.string().trim().max(64).optional(),
  email: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
  projectType: z.string().trim().max(200).optional(),
  timing: z.string().trim().max(200).optional(),
  budget: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(5000).optional(),
});

const bodySchema = z.object({
  rows: z.array(rowSchema).min(1).max(500),
  defaults: z
    .object({
      categoryId: z.number().int().nullable().optional(),
      sourceId: z.number().int().nullable().optional(),
      assignedToId: z.uuid().nullable().optional(),
    })
    .default({}),
  /** "skip" = ignorer les doublons par téléphone ; "update" = mettre à jour. */
  mode: z.enum(["skip", "update"]).default("skip"),
  /** Index du lot (pour l'audit seulement). */
  batch: z.number().int().min(0).optional(),
});

/**
 * Motif de rejet d'une ligne — jamais de rejet muet : chaque ligne écartée
 * repart avec sa raison, pour que l'UI puisse l'expliquer et proposer une
 * suite (corriger et réimporter, mettre à jour la fiche existante…).
 */
export type ImportIssue = {
  /** Index de la ligne DANS LE LOT ; le client y ajoute l'offset du lot. */
  index: number;
  reason: "phone_missing" | "phone_invalid" | "duplicate_in_file" | "duplicate_in_db";
  /** Valeur brute du téléphone, pour que l'admin reconnaisse sa ligne. */
  phone?: string;
  name?: string;
  /** Fiche déjà en base (duplicate_in_db) — permet d'y renvoyer l'admin. */
  existingId?: string;
};

type DefaultField = "categoryId" | "sourceId" | "assignedToId";

/** Réponse 422 quand une valeur par défaut pointe vers une ligne qui n'existe plus. */
function invalidDefault(field: DefaultField): NextResponse {
  return NextResponse.json({ error: "invalid_default", field }, { status: 422 });
}

/** Contrainte de clé étrangère de `clients` → champ par défaut fautif. */
const FK_TO_FIELD: Record<string, DefaultField> = {
  clients_category_id_categories_id_fk: "categoryId",
  clients_source_id_sources_id_fk: "sourceId",
  clients_assigned_to_id_users_id_fk: "assignedToId",
};

/**
 * Les valeurs par défaut (catégorie, source, assigné) sont de vraies clés
 * étrangères : une catégorie / source / un compte supprimé entre l'ouverture
 * de la page et l'envoi du lot ferait lever Postgres sur TOUT le lot (500 nu,
 * sans le motif ligne à ligne que ce module promet). On refuse donc d'emblée,
 * en nommant le champ, comme le fait le webhook de leads.
 */
async function missingDefault(defaults: {
  categoryId?: number | null;
  sourceId?: number | null;
  assignedToId?: string | null;
}): Promise<DefaultField | null> {
  if (defaults.categoryId != null) {
    const cat = await db.query.categories.findFirst({
      where: eq(categories.id, defaults.categoryId),
      columns: { id: true },
    });
    if (!cat) return "categoryId";
  }
  if (defaults.sourceId != null) {
    const src = await db.query.sources.findFirst({
      where: eq(sources.id, defaults.sourceId),
      columns: { id: true },
    });
    if (!src) return "sourceId";
  }
  if (defaults.assignedToId != null) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, defaults.assignedToId),
      columns: { id: true },
    });
    if (!user) return "assignedToId";
  }
  return null;
}

/**
 * Import CSV — reçoit des lots (max 500 lignes) déjà mappés côté client.
 * Lignes sans téléphone exploitable → invalid. Doublons par téléphone (E.164),
 * dans le fichier ou déjà en base → ignorés ou mis à jour selon le mode.
 * Chaque ligne écartée est renvoyée dans `issues` avec son motif.
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, bodySchema);
  if (body instanceof NextResponse) return body;

  const missing = await missingDefault(body.defaults);
  if (missing) return invalidDefault(missing);

  const counts = { created: 0, updated: 0, skipped: 0, invalid: 0 };
  const issues: ImportIssue[] = [];

  // Catégorie par défaut : celle choisie, sinon « Non contacté » (key: new).
  let categoryId = body.defaults.categoryId ?? null;
  if (categoryId == null) {
    const newCat = await db.query.categories.findFirst({ where: eq(categories.key, "new") });
    categoryId = newCat?.id ?? null;
  }

  // Normalisation + dédoublonnage intra-lot.
  type Prepared = { phone: string; row: z.infer<typeof rowSchema>; index: number };
  const seen = new Set<string>();
  const prepared: Prepared[] = [];
  for (const [index, row] of body.rows.entries()) {
    const phone = normalizePhone(row.phone);
    if (!phone) {
      counts.invalid++;
      // Cellule vide vs cellule remplie mais sans un seul chiffre : les deux
      // se corrigent différemment, on ne les confond pas.
      issues.push({
        index,
        reason: row.phone?.trim() ? "phone_invalid" : "phone_missing",
        phone: row.phone,
        name: row.fullName,
      });
      continue;
    }
    if (seen.has(phone)) {
      counts.skipped++;
      issues.push({ index, reason: "duplicate_in_file", phone: row.phone, name: row.fullName });
      continue;
    }
    seen.add(phone);
    prepared.push({ phone, row, index });
  }

  // Doublons existants en base (une seule requête pour le lot).
  const existing = prepared.length
    ? await db
        .select({ id: clients.id, phone: clients.phone })
        .from(clients)
        .where(
          inArray(
            clients.phone,
            prepared.map((p) => p.phone),
          ),
        )
    : [];
  const existingByPhone = new Map(existing.map((e) => [e.phone, e.id]));

  const toInsert: (typeof clients.$inferInsert)[] = [];
  const toUpdate: { id: string; set: Partial<typeof clients.$inferInsert> }[] = [];

  for (const { phone, row, index } of prepared) {
    const existingId = existingByPhone.get(phone);
    if (existingId) {
      if (body.mode === "skip") {
        counts.skipped++;
        issues.push({
          index,
          reason: "duplicate_in_db",
          phone: row.phone,
          name: row.fullName,
          existingId,
        });
        continue;
      }
      const set: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
      if (row.fullName) set.fullName = row.fullName;
      if (row.phoneAlt) {
        // Ne pas écraser un phoneAlt existant avec null si la cellule est invalide.
        const alt = normalizePhone(row.phoneAlt);
        if (alt) set.phoneAlt = alt;
      }
      if (row.email) set.email = row.email;
      if (row.city) set.city = row.city;
      if (row.address) set.address = row.address;
      if (row.projectType) set.projectType = row.projectType;
      if (row.timing) set.timing = row.timing;
      if (row.budget) set.budget = row.budget;
      if (row.notes) set.notes = row.notes;
      if (body.defaults.sourceId != null) set.sourceId = body.defaults.sourceId;
      if (body.defaults.assignedToId != null) set.assignedToId = body.defaults.assignedToId;
      toUpdate.push({ id: existingId, set });
      continue;
    }

    toInsert.push({
      fullName: row.fullName || formatPhone(phone),
      phone,
      phoneAlt: row.phoneAlt ? normalizePhone(row.phoneAlt) : null,
      email: row.email || null,
      city: row.city || null,
      address: row.address || null,
      projectType: row.projectType || null,
      timing: row.timing || null,
      budget: row.budget || null,
      notes: row.notes || null,
      language: "fr",
      categoryId,
      sourceId: body.defaults.sourceId ?? null,
      assignedToId: body.defaults.assignedToId ?? null,
      createdById: admin.id,
      meta: { importedAt: new Date().toISOString(), importedBy: admin.id },
    });
  }

  // Un lot est tout ou rien : sans transaction, une mise à jour déjà écrite
  // survivrait à l'échec de l'insertion qui suit, et l'admin ne verrait ni
  // compte ni journal pour ce qui a pourtant été appliqué.
  try {
    await db.transaction(async (tx) => {
      for (const { id, set } of toUpdate) {
        await tx.update(clients).set(set).where(eq(clients.id, id));
      }
      if (toInsert.length > 0) await tx.insert(clients).values(toInsert);
    });
  } catch (err) {
    // Filet pour la course « supprimé entre la vérification et l'écriture ».
    if (isForeignKeyViolation(err)) {
      const field = Object.entries(FK_TO_FIELD).find(([name]) => isForeignKeyViolation(err, name));
      if (field) return invalidDefault(field[1]);
    }
    throw err;
  }
  counts.updated += toUpdate.length;
  counts.created += toInsert.length;

  await logAudit({
    userId: admin.id,
    action: "import.csv",
    entity: "clients",
    detail: { ...counts, batch: body.batch ?? 0, mode: body.mode },
  });

  // Remis dans l'ordre du fichier : les doublons en base sont détectés dans
  // une seconde passe, mais l'admin lit ses lignes de haut en bas.
  issues.sort((a, b) => a.index - b.index);

  return NextResponse.json({ ...counts, issues });
}
