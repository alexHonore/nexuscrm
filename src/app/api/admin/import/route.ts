import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories, clients, sources, users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { isForeignKeyViolation } from "@/lib/db-errors";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import {
  apiPerm,
  loadDirectory,
  ownedCount,
  verifyAssignment,
} from "@/lib/permissions/server";
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
  /**
   * Fiche déjà en base (duplicate_in_db) — permet d'y renvoyer l'utilisateur.
   * ABSENT quand la fiche existante échappe au regard : un identifiant qui
   * ouvrirait un « introuvable » ne sert à personne, et le donner
   * confirmerait l'existence d'une fiche qu'on n'a pas le droit de connaître.
   */
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
 *
 * `clients.import` dit « il peut verser un fichier », pas « il peut réécrire
 * n'importe quelle fiche » : en mode « update », une fiche déjà en base n'est
 * modifiée que si son compartiment l'ouvre (visible ET modifiable), et le
 * responsable par défaut passe par le même verdict d'assignation que partout
 * ailleurs. Sinon l'import serait la porte dérobée de la modification et de la
 * distribution des fiches.
 */
export async function POST(req: Request) {
  const actor = await apiPerm("clients.import");
  if (actor instanceof NextResponse) return actor;

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

  // Doublons existants en base (une seule requête pour le lot). On rapatrie
  // de quoi juger l'accès à chaque fiche : son détenteur (le compartiment) et
  // ses dates (le verrou d'assignation).
  const existing = prepared.length
    ? await db
        .select({
          id: clients.id,
          phone: clients.phone,
          assignedToId: clients.assignedToId,
          lastContactedAt: clients.lastContactedAt,
          updatedAt: clients.updatedAt,
        })
        .from(clients)
        .where(
          inArray(
            clients.phone,
            prepared.map((p) => p.phone),
          ),
        )
    : [];
  const existingByPhone = new Map(existing.map((e) => [e.phone, e]));

  // Le compartiment d'une fiche ne dépend que de son DÉTENTEUR : on le résout
  // une fois par détenteur et non une fois par ligne — un lot de 500 doublons
  // ne coûte donc pas 500 questions de plus à la matrice.
  const { cfg, roleOf } = await loadDirectory();
  const grantsCache = new Map<string, Grants>();
  const grantsOfHolder = (assignedToId: string | null): Grants => {
    const key = assignedToId ?? "";
    const hit = grantsCache.get(key);
    if (hit) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const g = grantsFor(cfg, actor.role, bucketFor(actor.user.id, { assignedToId }, holder));
    grantsCache.set(key, g);
    return g;
  };

  /**
   * Le responsable par défaut, passé au crible AVANT le lot.
   *
   * Écrire `assigned_to_id` à la main ferait de l'import la porte dérobée du
   * « distribuer » : un rôle qui n'a pas le droit de donner une fiche à
   * quelqu'un d'autre se l'accorderait en versant un fichier. Toutes les
   * insertions posent la MÊME question (une fiche neuve est au bassin), donc
   * un seul verdict suffit ; refusé, la ligne entre quand même, sans
   * responsable — un import à moitié écrit serait pire que pas d'assignation.
   */
  const wantedAssignee = body.defaults.assignedToId ?? null;
  let assignOnInsert: string | null = null;
  /**
   * Le plafond se compte SUR LE LOT : le verdict le vérifie fiche par fiche
   * avec le même compte de départ, donc 500 lignes d'un coup passeraient
   * toutes sous un plafond que la première franchit déjà. Il ne concerne que
   * ce qu'on prend POUR SOI — donner ne remplit pas l'appétit de l'autre.
   */
  let headroom = Number.POSITIVE_INFINITY;
  /** Lignes écrites sans le responsable demandé — pour le journal d'audit. */
  let assignRefused = 0;
  if (wantedAssignee) {
    const cap =
      wantedAssignee === actor.user.id && !actor.role.superAdmin
        ? actor.role.assignment.maxOwned
        : 0;
    if (cap > 0) headroom = Math.max(0, cap - (await ownedCount(actor.user.id)));
    const verdict = await verifyAssignment(actor, { assignedToId: null }, wantedAssignee);
    if (verdict.ok) assignOnInsert = wantedAssignee;
  }

  /** Consomme une place sous le plafond ; faux une fois qu'il est atteint. */
  const takeSlot = (): boolean => {
    if (headroom <= 0) return false;
    headroom -= 1;
    return true;
  };

  const toInsert: (typeof clients.$inferInsert)[] = [];
  const toUpdate: { id: string; set: Partial<typeof clients.$inferInsert> }[] = [];

  for (const { phone, row, index } of prepared) {
    const match = existingByPhone.get(phone);
    if (match) {
      const grants = grantsOfHolder(match.assignedToId);
      // Une fiche invisible, ou visible mais fermée à la modification, ne se
      // réécrit pas : le mode « update » retombe alors sur le comportement du
      // mode « skip », ligne comptée et motif rendu. Et l'identifiant ne part
      // QUE si la fiche existe pour ce regard — sinon la réponse dirait quelle
      // fiche se cache derrière ce numéro, et offrirait un lien vers un
      // « introuvable ».
      const rewritable = grants.visible && grants.edit;
      if (body.mode === "skip" || !rewritable) {
        counts.skipped++;
        issues.push({
          index,
          reason: "duplicate_in_db",
          phone: row.phone,
          name: row.fullName,
          ...(grants.visible ? { existingId: match.id } : {}),
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
      // Faire changer une fiche EXISTANTE de main est un geste d'assignation à
      // part entière : son verdict dépend de son compartiment et de son verrou,
      // donc il se pose fiche par fiche. Refusé, le reste de la ligne est tout
      // de même appliqué — la fiche ne change simplement pas de responsable.
      if (wantedAssignee && match.assignedToId !== wantedAssignee) {
        const verdict = await verifyAssignment(actor, match, wantedAssignee);
        if (verdict.ok && takeSlot()) set.assignedToId = wantedAssignee;
        else assignRefused++;
      }
      toUpdate.push({ id: match.id, set });
      continue;
    }

    // Fiche neuve : le verdict d'assignation est déjà rendu (même question
    // pour toutes), il ne reste que le plafond à décompter.
    const assignedToId = assignOnInsert && takeSlot() ? assignOnInsert : null;
    if (wantedAssignee && assignedToId === null) assignRefused++;

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
      assignedToId,
      createdById: actor.user.id,
      meta: { importedAt: new Date().toISOString(), importedBy: actor.user.id },
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
    userId: actor.user.id,
    action: "import.csv",
    entity: "clients",
    // `assignRefused` : lignes écrites sans le responsable demandé (droit,
    // verrou ou plafond). Au journal et pas dans la réponse — c'est une
    // question de configuration des rôles, pas une ligne à corriger.
    detail: {
      ...counts,
      batch: body.batch ?? 0,
      mode: body.mode,
      ...(assignRefused > 0 ? { assignRefused } : {}),
    },
  });

  // Remis dans l'ordre du fichier : les doublons en base sont détectés dans
  // une seconde passe, mais l'admin lit ses lignes de haut en bas.
  issues.sort((a, b) => a.index - b.index);

  return NextResponse.json({ ...counts, issues });
}
