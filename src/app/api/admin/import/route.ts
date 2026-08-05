import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories, clients } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
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
 * Import CSV — reçoit des lots (max 500 lignes) déjà mappés côté client.
 * Lignes sans téléphone valide → invalid. Doublons par téléphone (E.164) →
 * ignorés ou mis à jour selon le mode.
 */
export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await readJson(req, bodySchema);
  if (body instanceof NextResponse) return body;

  const counts = { created: 0, updated: 0, skipped: 0, invalid: 0 };

  // Catégorie par défaut : celle choisie, sinon « Non contacté » (key: new).
  let categoryId = body.defaults.categoryId ?? null;
  if (categoryId == null) {
    const newCat = await db.query.categories.findFirst({ where: eq(categories.key, "new") });
    categoryId = newCat?.id ?? null;
  }

  // Normalisation + dédoublonnage intra-lot.
  type Prepared = { phone: string; row: z.infer<typeof rowSchema> };
  const seen = new Set<string>();
  const prepared: Prepared[] = [];
  for (const row of body.rows) {
    const phone = normalizePhone(row.phone);
    if (!phone) {
      counts.invalid++;
      continue;
    }
    if (seen.has(phone)) {
      counts.skipped++;
      continue;
    }
    seen.add(phone);
    prepared.push({ phone, row });
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

  for (const { phone, row } of prepared) {
    const existingId = existingByPhone.get(phone);
    if (existingId) {
      if (body.mode === "skip") {
        counts.skipped++;
        continue;
      }
      const set: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
      if (row.fullName) set.fullName = row.fullName;
      if (row.phoneAlt) set.phoneAlt = normalizePhone(row.phoneAlt);
      if (row.email) set.email = row.email;
      if (row.city) set.city = row.city;
      if (row.address) set.address = row.address;
      if (row.projectType) set.projectType = row.projectType;
      if (row.timing) set.timing = row.timing;
      if (row.budget) set.budget = row.budget;
      if (row.notes) set.notes = row.notes;
      if (body.defaults.sourceId != null) set.sourceId = body.defaults.sourceId;
      if (body.defaults.assignedToId != null) set.assignedToId = body.defaults.assignedToId;
      await db.update(clients).set(set).where(eq(clients.id, existingId));
      counts.updated++;
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

  if (toInsert.length > 0) {
    await db.insert(clients).values(toInsert);
    counts.created += toInsert.length;
  }

  await logAudit({
    userId: admin.id,
    action: "import.csv",
    entity: "clients",
    detail: { ...counts, batch: body.batch ?? 0, mode: body.mode },
  });

  return NextResponse.json(counts);
}
