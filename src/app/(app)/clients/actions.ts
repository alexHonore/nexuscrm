"use server";

import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { db } from "@/db";
import {
  appointments,
  auditLogs,
  categories,
  clients,
  comments,
  followups,
  notifications,
  sources,
  users,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/guards";
import { diffFields, getClientIp, logAudit, type AuditChanges } from "@/lib/audit";
import { cancelEvent } from "@/lib/google";
import { normalizePhone } from "@/lib/phone";
import {
  commentExcerpt,
  extractMentionIds,
  notificationContent,
} from "@/components/clients/notification-content";
import { APP_TZ } from "@/components/clients/timezone";
import { BULK_MAX } from "@/lib/bulk";

export type ActionResult =
  | { ok: true; id?: string }
  | { ok: false; error: "invalid" | "invalidPhone" | "forbidden" | "notFound" };

/** Résultat des actions en masse : nombre de fiches réellement modifiées. */
export type BulkResult =
  | { ok: true; count: number }
  | { ok: false; error: "invalid" | "forbidden" | "notFound" };

// `as const` : les mêmes constantes servent ActionResult ET BulkResult.
const INVALID = { ok: false, error: "invalid" } as const;
const FORBIDDEN = { ok: false, error: "forbidden" } as const;
const NOT_FOUND = { ok: false, error: "notFound" } as const;

// ── Schemas ──────────────────────────────────────────────────────────────────

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim() || null)
    .nullish()
    .transform((v) => v ?? null);

const clientFormSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(3).max(30),
  phoneAlt: optionalText(30),
  email: optionalText(200),
  language: z.enum(["fr", "en"]),
  city: optionalText(120),
  address: optionalText(300),
  projectType: optionalText(60),
  timing: optionalText(120),
  budget: optionalText(120),
  categoryId: z.number().int().nullable().optional(),
  sourceId: z.number().int().nullable().optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  notes: optionalText(5000),
});

export type ClientFormInput = z.input<typeof clientFormSchema>;

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^\d{2}:\d{2}$/);

/** Champs de la fiche client suivis par le journal d'audit (avant → après). */
const CLIENT_AUDIT_FIELDS = [
  "fullName",
  "phone",
  "phoneAlt",
  "email",
  "language",
  "city",
  "address",
  "projectType",
  "timing",
  "budget",
  "categoryId",
  "sourceId",
  "assignedToId",
  "notes",
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Keep clients.nextFollowupAt = earliest OPEN follow-up (or null). */
async function syncNextFollowup(clientId: string): Promise<void> {
  const next = await db.query.followups.findFirst({
    where: and(eq(followups.clientId, clientId), isNull(followups.doneAt)),
    orderBy: [asc(followups.dueAt)],
  });
  await db
    .update(clients)
    .set({ nextFollowupAt: next?.dueAt ?? null, updatedAt: new Date() })
    .where(eq(clients.id, clientId));
}

function revalidateClient(clientId: string): void {
  revalidatePath("/clients");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
  revalidatePath("/pipeline");
}

// ── Client CRUD ──────────────────────────────────────────────────────────────

/** Admin only — callers can never create clients manually. */
export async function createClientAction(input: ClientFormInput): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (user.role !== "admin") return FORBIDDEN;

  const parsed = clientFormSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const data = parsed.data;

  const phone = normalizePhone(data.phone);
  if (!phone) return { ok: false, error: "invalidPhone" };
  const phoneAlt = data.phoneAlt ? normalizePhone(data.phoneAlt) : null;

  const values = {
    fullName: data.fullName,
    phone,
    phoneAlt,
    email: data.email,
    language: data.language,
    city: data.city,
    address: data.address,
    projectType: data.projectType,
    timing: data.timing,
    budget: data.budget,
    categoryId: data.categoryId ?? null,
    sourceId: data.sourceId ?? null,
    assignedToId: data.assignedToId ?? null,
    notes: data.notes,
  };

  const [created] = await db
    .insert(clients)
    .values({ ...values, createdById: user.id })
    .returning({ id: clients.id });

  // Création : « rien → valeur » pour chaque champ renseigné.
  const changes = diffFields(null, values, CLIENT_AUDIT_FIELDS);
  await logAudit({
    userId: user.id,
    action: "client.create",
    entity: "client",
    entityId: created.id,
    detail: { fullName: data.fullName, phone, ...(changes ? { changes } : {}) },
  });
  revalidateClient(created.id);
  return { ok: true, id: created.id };
}

/** Single-record edit — allowed for callers. assignedToId applied for admin only. */
export async function updateClientAction(
  clientId: string,
  input: ClientFormInput,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;

  const parsed = clientFormSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const data = parsed.data;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  const phone = normalizePhone(data.phone);
  if (!phone) return { ok: false, error: "invalidPhone" };
  const phoneAlt = data.phoneAlt ? normalizePhone(data.phoneAlt) : null;

  const patch = {
    fullName: data.fullName,
    phone,
    phoneAlt,
    email: data.email,
    language: data.language,
    city: data.city,
    address: data.address,
    projectType: data.projectType,
    timing: data.timing,
    budget: data.budget,
    sourceId: data.sourceId ?? null,
    notes: data.notes,
    // Un téléphoniste ne réassigne pas : le champ garde sa valeur actuelle.
    ...(user.role === "admin" ? { assignedToId: data.assignedToId ?? null } : {}),
  };

  await db
    .update(clients)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  const changes = diffFields(existing, { ...existing, ...patch }, CLIENT_AUDIT_FIELDS);
  await logAudit({
    userId: user.id,
    action: "client.update",
    entity: "client",
    entityId: clientId,
    detail: { fullName: data.fullName, phone, ...(changes ? { changes } : {}) },
  });
  revalidateClient(clientId);
  return { ok: true, id: clientId };
}

/** Quick pipeline-category change from the client header. */
export async function setClientCategoryAction(
  clientId: string,
  categoryId: number | null,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;
  if (categoryId !== null && !Number.isInteger(categoryId)) return INVALID;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  await db
    .update(clients)
    .set({ categoryId, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  const changes = diffFields(existing, { categoryId }, ["categoryId"]);
  await logAudit({
    userId: user.id,
    action: "client.category",
    entity: "client",
    entityId: clientId,
    detail: { from: existing.categoryId, to: categoryId, ...(changes ? { changes } : {}) },
  });
  revalidateClient(clientId);
  return { ok: true, id: clientId };
}

/** Admin only — changement rapide de source depuis la vue tableau. */
export async function setClientSourceAction(
  clientId: string,
  sourceId: number | null,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;
  if (sourceId !== null && !Number.isInteger(sourceId)) return INVALID;
  if (sourceId !== null) {
    const target = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
    if (!target) return NOT_FOUND;
  }

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  await db
    .update(clients)
    .set({ sourceId, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  const changes = diffFields(existing, { sourceId }, ["sourceId"]);
  await logAudit({
    userId: user.id,
    action: "client.update",
    entity: "client",
    entityId: clientId,
    detail: { from: existing.sourceId, to: sourceId, ...(changes ? { changes } : {}) },
  });
  revalidateClient(clientId);
  return { ok: true, id: clientId };
}

/** Admin only. */
export async function assignClientAction(
  clientId: string,
  assignedToId: string | null,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;
  if (assignedToId !== null && !z.string().uuid().safeParse(assignedToId).success) return INVALID;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  await db
    .update(clients)
    .set({ assignedToId, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  const changes = diffFields(existing, { assignedToId }, ["assignedToId"]);
  await logAudit({
    userId: user.id,
    action: "client.assign",
    entity: "client",
    entityId: clientId,
    detail: { from: existing.assignedToId, to: assignedToId, ...(changes ? { changes } : {}) },
  });
  revalidateClient(clientId);
  return { ok: true, id: clientId };
}

/**
 * Cœur de la suppression d'UNE fiche, partagé entre l'action unitaire et la
 * suppression en masse : annulation (au mieux) des événements Google des RDV
 * planifiés — la cascade supprime les RDV sans prévenir l'agenda de l'admin —
 * puis suppression et journal d'audit. Ne bloque jamais sur Google.
 */
async function deleteClientCore(
  userId: string,
  existing: typeof clients.$inferSelect,
  bulk: boolean,
): Promise<void> {
  const scheduled = await db.query.appointments.findMany({
    where: and(
      eq(appointments.clientId, existing.id),
      eq(appointments.status, "scheduled"),
      isNotNull(appointments.googleEventId),
    ),
    columns: { googleEventId: true },
  });
  for (const appt of scheduled) {
    if (!appt.googleEventId) continue;
    try {
      await cancelEvent(appt.googleEventId);
    } catch (err) {
      console.error("google event cancellation failed", err);
    }
  }

  await db.delete(clients).where(eq(clients.id, existing.id));

  // Suppression : instantané de la fiche disparue (« valeur → rien »).
  const changes = diffFields(existing, null, CLIENT_AUDIT_FIELDS);
  await logAudit({
    userId,
    action: "client.delete",
    entity: "client",
    entityId: existing.id,
    detail: {
      fullName: existing.fullName,
      phone: existing.phone,
      ...(bulk ? { bulk: true } : {}),
      ...(changes ? { changes } : {}),
    },
  });
}

/** Admin only — callers can never delete. */
export async function deleteClientAction(clientId: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  await deleteClientCore(user.id, existing, false);
  revalidatePath("/clients");
  revalidatePath("/dashboard");
  return { ok: true };
}

// ── Actions en masse (vue tableau) ───────────────────────────────────────────
// Admin uniquement — règle du dépôt : un téléphoniste ne fait JAMAIS d'action
// en masse. Chaque fiche touchée reçoit SA ligne d'audit (marquée `bulk`), afin
// que « modifiée par qui » et /admin/audit restent exacts fiche par fiche.

const bulkIdsSchema = z.array(z.string().uuid()).min(1).max(BULK_MAX);

/** Insertion d'audit groupée — même contrat que logAudit : ne casse jamais l'action. */
async function logBulkAudit(
  rows: Array<{
    userId: string;
    action: string;
    entityId: string;
    detail: Record<string, unknown>;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const ip = await getClientIp();
    await db.insert(auditLogs).values(
      rows.map((r) => ({
        userId: r.userId,
        action: r.action,
        entity: "client",
        entityId: r.entityId,
        detail: r.detail,
        ip,
      })),
    );
  } catch (err) {
    console.error("bulk audit log failed", err);
  }
}

function revalidateClientLists(): void {
  revalidatePath("/clients");
  revalidatePath("/dashboard");
  revalidatePath("/pipeline");
}

/** Admin only — assigne (ou désassigne) plusieurs fiches d'un coup. */
export async function bulkAssignClientsAction(
  clientIds: string[],
  assignedToId: string | null,
): Promise<BulkResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return FORBIDDEN;

  const ids = bulkIdsSchema.safeParse(clientIds);
  if (!ids.success) return INVALID;
  if (assignedToId !== null && !z.string().uuid().safeParse(assignedToId).success) return INVALID;
  if (assignedToId !== null) {
    const target = await db.query.users.findFirst({ where: eq(users.id, assignedToId) });
    if (!target) return NOT_FOUND;
  }

  const existing = await db
    .select({ id: clients.id, assignedToId: clients.assignedToId })
    .from(clients)
    .where(inArray(clients.id, ids.data));
  const changed = existing.filter((c) => c.assignedToId !== assignedToId);

  if (changed.length > 0) {
    await db
      .update(clients)
      .set({ assignedToId, updatedAt: new Date() })
      .where(
        inArray(
          clients.id,
          changed.map((c) => c.id),
        ),
      );
    await logBulkAudit(
      changed.map((c) => ({
        userId: user.id,
        action: "client.assign",
        entityId: c.id,
        detail: {
          bulk: true,
          from: c.assignedToId,
          to: assignedToId,
          changes: { assignedToId: { from: c.assignedToId, to: assignedToId } } as AuditChanges,
        },
      })),
    );
    revalidateClientLists();
  }
  return { ok: true, count: changed.length };
}

/** Admin only — change la catégorie pipeline de plusieurs fiches d'un coup. */
export async function bulkSetClientsCategoryAction(
  clientIds: string[],
  categoryId: number | null,
): Promise<BulkResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return FORBIDDEN;

  const ids = bulkIdsSchema.safeParse(clientIds);
  if (!ids.success) return INVALID;
  if (categoryId !== null && !Number.isInteger(categoryId)) return INVALID;
  if (categoryId !== null) {
    const target = await db.query.categories.findFirst({ where: eq(categories.id, categoryId) });
    if (!target) return NOT_FOUND;
  }

  const existing = await db
    .select({ id: clients.id, categoryId: clients.categoryId })
    .from(clients)
    .where(inArray(clients.id, ids.data));
  const changed = existing.filter((c) => c.categoryId !== categoryId);

  if (changed.length > 0) {
    await db
      .update(clients)
      .set({ categoryId, updatedAt: new Date() })
      .where(
        inArray(
          clients.id,
          changed.map((c) => c.id),
        ),
      );
    await logBulkAudit(
      changed.map((c) => ({
        userId: user.id,
        action: "client.category",
        entityId: c.id,
        detail: {
          bulk: true,
          from: c.categoryId,
          to: categoryId,
          changes: { categoryId: { from: c.categoryId, to: categoryId } } as AuditChanges,
        },
      })),
    );
    revalidateClientLists();
  }
  return { ok: true, count: changed.length };
}

/** Admin only — change la source de plusieurs fiches d'un coup. */
export async function bulkSetClientsSourceAction(
  clientIds: string[],
  sourceId: number | null,
): Promise<BulkResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return FORBIDDEN;

  const ids = bulkIdsSchema.safeParse(clientIds);
  if (!ids.success) return INVALID;
  if (sourceId !== null && !Number.isInteger(sourceId)) return INVALID;
  if (sourceId !== null) {
    const target = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
    if (!target) return NOT_FOUND;
  }

  const existing = await db
    .select({ id: clients.id, sourceId: clients.sourceId })
    .from(clients)
    .where(inArray(clients.id, ids.data));
  const changed = existing.filter((c) => c.sourceId !== sourceId);

  if (changed.length > 0) {
    await db
      .update(clients)
      .set({ sourceId, updatedAt: new Date() })
      .where(
        inArray(
          clients.id,
          changed.map((c) => c.id),
        ),
      );
    await logBulkAudit(
      changed.map((c) => ({
        userId: user.id,
        action: "client.update",
        entityId: c.id,
        detail: {
          bulk: true,
          from: c.sourceId,
          to: sourceId,
          changes: { sourceId: { from: c.sourceId, to: sourceId } } as AuditChanges,
        },
      })),
    );
    revalidateClientLists();
  }
  return { ok: true, count: changed.length };
}

/** Admin only — suppression en masse, avec annulation des événements Google. */
export async function bulkDeleteClientsAction(clientIds: string[]): Promise<BulkResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return FORBIDDEN;

  const ids = bulkIdsSchema.safeParse(clientIds);
  if (!ids.success) return INVALID;

  const existing = await db.query.clients.findMany({ where: inArray(clients.id, ids.data) });
  if (existing.length === 0) return { ok: true, count: 0 };
  const found = existing.map((c) => c.id);

  // Annuler les événements Google des RDV planifiés AVANT la cascade, sinon
  // ils resteraient dans l'agenda du courtier. Une seule requête pour le lot.
  const scheduled = await db.query.appointments.findMany({
    where: and(
      inArray(appointments.clientId, found),
      eq(appointments.status, "scheduled"),
      isNotNull(appointments.googleEventId),
    ),
    columns: { googleEventId: true },
  });
  for (const appt of scheduled) {
    if (!appt.googleEventId) continue;
    try {
      await cancelEvent(appt.googleEventId);
    } catch (err) {
      console.error("google event cancellation failed", err);
    }
  }

  // Une seule suppression (la cascade emporte appels, RDV, commentaires…) puis
  // un seul insert d'audit — une fiche à la fois faisait des centaines
  // d'allers-retours et finissait par expirer sur des lots de cette taille.
  await db.delete(clients).where(inArray(clients.id, found));
  await logBulkAudit(
    existing.map((row) => {
      const changes = diffFields(row, null, CLIENT_AUDIT_FIELDS);
      return {
        userId: user.id,
        action: "client.delete",
        entityId: row.id,
        detail: {
          fullName: row.fullName,
          phone: row.phone,
          bulk: true,
          ...(changes ? { changes } : {}),
        },
      };
    }),
  );

  revalidateClientLists();
  return { ok: true, count: existing.length };
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

export async function createFollowupAction(input: {
  clientId: string;
  date: string;
  time: string;
  note?: string;
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = z
    .object({
      clientId: z.string().uuid(),
      date: dateStr,
      time: timeStr,
      note: optionalText(1000),
    })
    .safeParse(input);
  if (!parsed.success) return INVALID;
  const { clientId, date, time, note } = parsed.data;

  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) return NOT_FOUND;

  const dueAt = fromZonedTime(`${date}T${time}:00`, APP_TZ);
  if (Number.isNaN(dueAt.getTime())) return INVALID;

  await db.insert(followups).values({
    clientId,
    assignedToId: client.assignedToId ?? user.id,
    dueAt,
    note,
    createdById: user.id,
  });

  await syncNextFollowup(clientId);
  revalidateClient(clientId);
  return { ok: true };
}

export async function completeFollowupAction(followupId: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  if (!z.string().uuid().safeParse(followupId).success) return INVALID;

  const followup = await db.query.followups.findFirst({ where: eq(followups.id, followupId) });
  if (!followup) return NOT_FOUND;

  await db
    .update(followups)
    .set({ doneAt: followup.doneAt ?? new Date() })
    .where(eq(followups.id, followupId));

  await syncNextFollowup(followup.clientId);
  revalidateClient(followup.clientId);
  return { ok: true };
}

export async function updateFollowupDueAction(input: {
  followupId: string;
  date: string;
  time: string;
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = z
    .object({ followupId: z.string().uuid(), date: dateStr, time: timeStr })
    .safeParse(input);
  if (!parsed.success) return INVALID;
  const { followupId, date, time } = parsed.data;

  const followup = await db.query.followups.findFirst({ where: eq(followups.id, followupId) });
  if (!followup) return NOT_FOUND;

  const dueAt = fromZonedTime(`${date}T${time}:00`, APP_TZ);
  if (Number.isNaN(dueAt.getTime())) return INVALID;

  await db.update(followups).set({ dueAt }).where(eq(followups.id, followupId));

  await syncNextFollowup(followup.clientId);
  revalidateClient(followup.clientId);
  return { ok: true };
}

// ── Comments + mentions ──────────────────────────────────────────────────────

export async function addCommentAction(input: {
  clientId: string;
  body: string;
}): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = z
    .object({ clientId: z.string().uuid(), body: z.string().trim().min(1).max(5000) })
    .safeParse(input);
  if (!parsed.success) return INVALID;
  const { clientId, body } = parsed.data;

  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) return NOT_FOUND;

  await db.insert(comments).values({ clientId, userId: user.id, body });

  // Notify mentioned users (in THEIR locale), excluding the author.
  const mentionIds = extractMentionIds(body).filter((id) => id !== user.id);
  if (mentionIds.length > 0) {
    const mentioned = await db.query.users.findMany({
      where: and(inArray(users.id, mentionIds), eq(users.isActive, true)),
    });
    if (mentioned.length > 0) {
      const excerpt = commentExcerpt(body);
      await db.insert(notifications).values(
        mentioned.map((m) => ({
          userId: m.id,
          type: "mention",
          title: notificationContent(m.locale, "mentionTitle", { name: user.name }),
          body: excerpt,
          link: `/clients/${clientId}`,
        })),
      );
    }
  }

  revalidateClient(clientId);
  return { ok: true };
}
