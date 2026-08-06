"use server";

import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { db } from "@/db";
import { appointments, clients, comments, followups, notifications, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/guards";
import { logAudit } from "@/lib/audit";
import { cancelEvent } from "@/lib/google";
import { normalizePhone } from "@/lib/phone";
import {
  commentExcerpt,
  extractMentionIds,
  notificationContent,
} from "@/components/clients/notification-content";
import { APP_TZ } from "@/components/clients/timezone";

export type ActionResult =
  | { ok: true; id?: string }
  | { ok: false; error: "invalid" | "invalidPhone" | "forbidden" | "notFound" };

const INVALID: ActionResult = { ok: false, error: "invalid" };
const FORBIDDEN: ActionResult = { ok: false, error: "forbidden" };
const NOT_FOUND: ActionResult = { ok: false, error: "notFound" };

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

  const [created] = await db
    .insert(clients)
    .values({
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
      createdById: user.id,
    })
    .returning({ id: clients.id });

  await logAudit({
    userId: user.id,
    action: "client.create",
    entity: "client",
    entityId: created.id,
    detail: { fullName: data.fullName, phone },
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

  await db
    .update(clients)
    .set({
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
      ...(user.role === "admin" ? { assignedToId: data.assignedToId ?? null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(clients.id, clientId));

  await logAudit({
    userId: user.id,
    action: "client.update",
    entity: "client",
    entityId: clientId,
    detail: { fullName: data.fullName, phone },
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

  await logAudit({
    userId: user.id,
    action: "client.category",
    entity: "client",
    entityId: clientId,
    detail: { from: existing.categoryId, to: categoryId },
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

  await logAudit({
    userId: user.id,
    action: "client.assign",
    entity: "client",
    entityId: clientId,
    detail: { from: existing.assignedToId, to: assignedToId },
  });
  revalidateClient(clientId);
  return { ok: true, id: clientId };
}

/** Admin only — callers can never delete. */
export async function deleteClientAction(clientId: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  // Annulation (au mieux) des événements Google des RDV planifiés — la cascade
  // supprime les RDV sans prévenir l'agenda de l'admin. Ne bloque jamais la suppression.
  const scheduled = await db.query.appointments.findMany({
    where: and(
      eq(appointments.clientId, clientId),
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

  await db.delete(clients).where(eq(clients.id, clientId));

  await logAudit({
    userId: user.id,
    action: "client.delete",
    entity: "client",
    entityId: clientId,
    detail: { fullName: existing.fullName, phone: existing.phone },
  });
  revalidatePath("/clients");
  revalidatePath("/dashboard");
  return { ok: true };
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
