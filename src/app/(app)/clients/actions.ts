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
import { notifyCategoryChanged, notifyCategoryChanges } from "@/lib/campaigns-server/match";
import { diffFields, getClientIp, logAudit, type AuditChanges } from "@/lib/audit";
import { isForeignKeyViolation } from "@/lib/db-errors";
import { categoryEntryPatch } from "@/lib/dispositions";
import { cancelEvent } from "@/lib/google";
import type { AssignRefusal } from "@/lib/permissions/access";
import {
  currentActor,
  grantsOnClient,
  guardClient,
  ownedCount,
  verifyAssignment,
  type Actor,
  type Grants,
} from "@/lib/permissions/server";
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
  | {
      ok: false;
      error:
        | "invalid"
        | "invalidPhone"
        | "invalidPhoneAlt"
        | "forbidden"
        | "notFound"
        | "locked"
        | "capReached";
    };

/** Résultat des actions en masse : nombre de fiches réellement modifiées. */
export type BulkResult =
  | { ok: true; count: number }
  | { ok: false; error: "invalid" | "forbidden" | "notFound" | "locked" | "capReached" };

// `as const` : les mêmes constantes servent ActionResult ET BulkResult.
const INVALID = { ok: false, error: "invalid" } as const;
const FORBIDDEN = { ok: false, error: "forbidden" } as const;
const NOT_FOUND = { ok: false, error: "notFound" } as const;
const LOCKED = { ok: false, error: "locked" } as const;
const CAP_REACHED = { ok: false, error: "capReached" } as const;

/**
 * Un refus d'assignation se NOMME.
 *
 * « Verrouillée » (la fiche est à quelqu'un et son verrou tient) et « plafond
 * atteint » ne se corrigent pas comme un droit manquant : l'un s'attend ou se
 * fait débloquer par un supérieur, l'autre demande de rendre des fiches. Les
 * phrases existent déjà (clients.access.locked / lockedForever / capReached) ;
 * il ne manquait que de leur transmettre le motif au lieu d'un « interdit »
 * qui n'apprend rien.
 */
function assignRefusal(reason: AssignRefusal) {
  if (reason === "locked") return LOCKED;
  if (reason === "cap_reached") return CAP_REACHED;
  return FORBIDDEN;
}

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

/**
 * Ne garde d'un lot que les fiches VISIBLES dont la case demandée est ouverte.
 *
 * Une action en masse reçoit des identifiants venus du navigateur : les croire
 * sur parole, c'est offrir en une requête ce que la matrice refuse fiche par
 * fiche. Le filtre coûte peu — l'annuaire des rôles est mis en cache pour la
 * requête, donc juger 200 fiches ne fait aucune lecture supplémentaire.
 */
async function keepGranted<T extends { assignedToId: string | null }>(
  actor: Actor,
  rows: T[],
  grant: keyof Grants,
): Promise<T[]> {
  const kept: T[] = [];
  for (const row of rows) {
    const grants = await grantsOnClient(actor, row);
    if (grants.visible && grants[grant]) kept.push(row);
  }
  return kept;
}

/** Une fiche qui change de main : d'où elle vient, où elle va. */
type HandOver = {
  clientId: string;
  clientName: string;
  from: string | null;
  to: string | null;
};

/**
 * Prévient les personnes CONCERNÉES par un changement de main, chacune dans SA
 * langue : celle qui reçoit la fiche, et celle à qui on la retire — mais
 * seulement si les règles globales le demandent (`notifyAssignee` /
 * `notifyPreviousOwner`).
 *
 * L'auteur du geste ne se prévient jamais lui-même : se servir dans le bassin
 * n'est pas une nouvelle, et la cloche perdrait tout son sens si elle sonnait
 * pour chacun de ses propres clics.
 */
async function notifyHandOvers(actor: Actor, moves: HandOver[]): Promise<void> {
  const rules = actor.cfg.assignment;
  const wanted = moves.flatMap((move) => [
    ...(rules.notifyAssignee && move.to && move.to !== actor.user.id
      ? [{ userId: move.to, move, taken: false }]
      : []),
    ...(rules.notifyPreviousOwner && move.from && move.from !== actor.user.id
      ? [{ userId: move.from, move, taken: true }]
      : []),
  ]);
  if (wanted.length === 0) return;

  const recipients = await db.query.users.findMany({
    where: and(
      inArray(users.id, [...new Set(wanted.map((w) => w.userId))]),
      eq(users.isActive, true),
    ),
    columns: { id: true, locale: true },
  });
  const localeOf = new Map(recipients.map((r) => [r.id, r.locale]));

  const rows = wanted.flatMap((w) => {
    // Compte désactivé entre-temps : pas de notification, pas d'échec non plus.
    const locale = localeOf.get(w.userId);
    if (!locale) return [];
    const vars = { client: w.move.clientName, actor: actor.user.name };
    return [
      {
        userId: w.userId,
        type: "assignment",
        title: notificationContent(
          locale,
          w.taken ? "clientTakenTitle" : "clientAssignedTitle",
          vars,
        ),
        body: notificationContent(locale, w.taken ? "clientTakenBody" : "clientAssignedBody", vars),
        link: `/clients/${w.move.clientId}`,
      },
    ];
  });
  if (rows.length > 0) await db.insert(notifications).values(rows);
}

// ── Client CRUD ──────────────────────────────────────────────────────────────

/** Droit `clients.create` — et l'assignation initiale passe le même verdict. */
export async function createClientAction(input: ClientFormInput): Promise<ActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.create")) return FORBIDDEN;

  const parsed = clientFormSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const data = parsed.data;

  const phone = normalizePhone(data.phone);
  if (!phone) return { ok: false, error: "invalidPhone" };
  // Même exigence que le numéro principal : un « autre téléphone » saisi mais
  // inutilisable est refusé, pas enregistré NULL en silence.
  const phoneAlt = data.phoneAlt ? normalizePhone(data.phoneAlt) : null;
  if (data.phoneAlt && !phoneAlt) return { ok: false, error: "invalidPhoneAlt" };

  // Catégorie résolue AVANT l'écriture : sa clé décide des effets d'entrée
  // (« Ne pas appeler » → doNotCall) ; une catégorie disparue répond notFound.
  const category =
    data.categoryId == null
      ? null
      : ((await db.query.categories.findFirst({
          where: eq(categories.id, data.categoryId),
          columns: { id: true, key: true },
        })) ?? null);
  if (data.categoryId != null && !category) return NOT_FOUND;

  // Créer une fiche DÉJÀ prise, c'est l'assigner : même verdict (droit,
  // compartiment, verrou, plafond) que sur une fiche existante du bassin —
  // sinon « créer » serait la porte dérobée du « distribuer ».
  const assignedToId = data.assignedToId ?? null;
  if (assignedToId !== null) {
    const verdict = await verifyAssignment(actor, { assignedToId: null }, assignedToId);
    if (!verdict.ok) return assignRefusal(verdict.reason);
  }

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
    ...categoryEntryPatch(category),
    sourceId: data.sourceId ?? null,
    assignedToId,
    notes: data.notes,
  };

  // Source / responsable supprimés entre-temps (vieil onglet) : la base refuse
  // la référence — on répond notFound au lieu de planter l'action.
  let created: { id: string };
  try {
    [created] = await db
      .insert(clients)
      .values({ ...values, createdById: actor.user.id })
      .returning({ id: clients.id });
  } catch (err) {
    if (isForeignKeyViolation(err)) return NOT_FOUND;
    throw err;
  }

  // Création : « rien → valeur » pour chaque champ renseigné.
  const changes = diffFields(null, values, CLIENT_AUDIT_FIELDS);
  await logAudit({
    userId: actor.user.id,
    action: "client.create",
    entity: "client",
    entityId: created.id,
    detail: { fullName: data.fullName, phone, ...(changes ? { changes } : {}) },
  });
  if (assignedToId !== null) {
    await notifyHandOvers(actor, [
      { clientId: created.id, clientName: data.fullName, from: null, to: assignedToId },
    ]);
  }
  revalidateClient(created.id);
  return { ok: true, id: created.id };
}

/**
 * Modification d'UNE fiche — droit `clients.edit` ET case « modifier » ouverte
 * sur cette fiche-là. Le responsable, lui, ne se change pas « au passage » :
 * voir plus bas.
 */
export async function updateClientAction(
  clientId: string,
  input: ClientFormInput,
): Promise<ActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.edit")) return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;

  const parsed = clientFormSchema.safeParse(input);
  if (!parsed.success) return INVALID;
  const data = parsed.data;

  // Invisible ou non modifiable : « introuvable ». Un refus explicite
  // confirmerait l'existence de la fiche, ce que la matrice cache justement.
  const guard = await guardClient(actor, clientId, "edit");
  if (!guard) return NOT_FOUND;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  /**
   * Les COORDONNÉES ont leur propre case, et « modifier » ne l'ouvre pas.
   *
   * Sans ce garde, un rôle qui peut modifier une fiche sans en voir le
   * téléphone les DÉCOUVRE : il écrit un numéro à lui, relit la fiche, et le
   * masque n'a plus rien à cacher — en écrasant le vrai numéro au passage. Le
   * formulaire ne lui envoie de toute façon qu'un masque (« •••-4512 »), qui
   * finirait tel quel en base.
   *
   * On IGNORE ces trois champs plutôt que de refuser tout l'envoi : le reste
   * de la fiche (ville, budget, notes) lui est bel et bien ouvert, et un refus
   * global lui apprendrait justement ce que la case cache.
   */
  const contactOpen = guard.grants.contact;
  let phone = existing.phone;
  let phoneAlt = existing.phoneAlt;
  let email = existing.email;
  if (contactOpen) {
    const nextPhone = normalizePhone(data.phone);
    if (!nextPhone) return { ok: false, error: "invalidPhone" };
    // Même exigence que le numéro principal : un « autre téléphone » saisi mais
    // inutilisable est refusé, pas enregistré NULL en silence (ce qui effaçait
    // aussi l'ancien numéro tout en affichant « Enregistré »).
    const nextPhoneAlt = data.phoneAlt ? normalizePhone(data.phoneAlt) : null;
    if (data.phoneAlt && !nextPhoneAlt) return { ok: false, error: "invalidPhoneAlt" };
    phone = nextPhone;
    phoneAlt = nextPhoneAlt;
    email = data.email;
  }

  /**
   * Le responsable a son propre droit, son propre verdict et sa notification.
   * Sans `clients.assign`, le champ garde sa valeur actuelle — le formulaire
   * ne le montre même pas, et un envoi bricolé ne doit pas le contourner. Avec
   * le droit, un changement est jugé comme une assignation à part entière
   * (verrou, plafond, compartiment) et son refus est NOMMÉ.
   *
   * Champ ABSENT ≠ champ vidé : un formulaire qui ne l'affiche pas ne libère
   * pas la fiche par omission. Seul un `null` explicite la rend au bassin.
   */
  const nextAssignee =
    data.assignedToId === undefined ? existing.assignedToId : data.assignedToId;
  const handOver = actor.can("clients.assign") && nextAssignee !== existing.assignedToId;
  if (handOver) {
    const verdict = await verifyAssignment(actor, existing, nextAssignee);
    if (!verdict.ok) return assignRefusal(verdict.reason);
  }

  const patch = {
    fullName: data.fullName,
    // Coordonnées : les valeurs ENREGISTRÉES quand la case « contact » est
    // fermée — l'écriture est alors un non-événement, journal d'audit compris.
    phone,
    phoneAlt,
    email,
    language: data.language,
    city: data.city,
    address: data.address,
    projectType: data.projectType,
    timing: data.timing,
    budget: data.budget,
    sourceId: data.sourceId ?? null,
    notes: data.notes,
    ...(handOver ? { assignedToId: nextAssignee } : {}),
  };

  // Source / responsable supprimés entre-temps (vieil onglet) : la base refuse
  // la référence — on répond notFound au lieu de planter l'action.
  try {
    await db
      .update(clients)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(clients.id, clientId));
  } catch (err) {
    if (isForeignKeyViolation(err)) return NOT_FOUND;
    throw err;
  }

  const changes = diffFields(existing, { ...existing, ...patch }, CLIENT_AUDIT_FIELDS);
  await logAudit({
    userId: actor.user.id,
    action: "client.update",
    entity: "client",
    entityId: clientId,
    detail: { fullName: data.fullName, phone, ...(changes ? { changes } : {}) },
  });
  if (handOver) {
    await notifyHandOvers(actor, [
      {
        clientId,
        clientName: data.fullName,
        from: existing.assignedToId,
        to: nextAssignee,
      },
    ]);
  }
  revalidateClient(clientId);
  return { ok: true, id: clientId };
}

/** Changement rapide de statut pipeline — droit `clients.category`. */
export async function setClientCategoryAction(
  clientId: string,
  categoryId: number | null,
): Promise<ActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.category")) return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;
  if (categoryId !== null && !Number.isInteger(categoryId)) return INVALID;
  // Cible résolue AVANT l'écriture : un statut supprimé entre-temps (vieil
  // onglet) répond notFound au lieu d'une violation de clé étrangère, et sa
  // clé décide des effets d'entrée (« Ne pas appeler » → doNotCall).
  const target =
    categoryId === null
      ? null
      : ((await db.query.categories.findFirst({
          where: eq(categories.id, categoryId),
          columns: { id: true, key: true },
        })) ?? null);
  if (categoryId !== null && !target) return NOT_FOUND;

  if (!(await guardClient(actor, clientId, "category"))) return NOT_FOUND;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  await db
    .update(clients)
    .set({ ...categoryEntryPatch(target), updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  const changes = diffFields(existing, { categoryId }, ["categoryId"]);
  await logAudit({
    userId: actor.user.id,
    action: "client.category",
    entity: "client",
    entityId: clientId,
    detail: { from: existing.categoryId, to: categoryId, ...(changes ? { changes } : {}) },
  });

  // Déclencheur « changement de catégorie » — le point d'entrée commun décide
  // lui-même si la catégorie a VRAIMENT changé et travaille après la réponse.
  notifyCategoryChanged(clientId, existing.categoryId, categoryId);

  revalidateClient(clientId);
  return { ok: true, id: clientId };
}

/** Changement rapide de source depuis la vue tableau — c'est une modification. */
export async function setClientSourceAction(
  clientId: string,
  sourceId: number | null,
): Promise<ActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.edit")) return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;
  if (sourceId !== null && !Number.isInteger(sourceId)) return INVALID;
  if (sourceId !== null) {
    const target = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
    if (!target) return NOT_FOUND;
  }

  if (!(await guardClient(actor, clientId, "edit"))) return NOT_FOUND;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  await db
    .update(clients)
    .set({ sourceId, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  const changes = diffFields(existing, { sourceId }, ["sourceId"]);
  await logAudit({
    userId: actor.user.id,
    action: "client.update",
    entity: "client",
    entityId: clientId,
    detail: { from: existing.sourceId, to: sourceId, ...(changes ? { changes } : {}) },
  });
  revalidateClient(clientId);
  return { ok: true, id: clientId };
}

/**
 * Assigner (ou rendre au bassin) UNE fiche.
 *
 * Deux gardes, et pas une : la VISIBILITÉ décide si la fiche existe pour ce
 * regard (sinon « introuvable »), le verdict d'assignation décide s'il peut la
 * faire changer de main — droit, compartiment, verrou anti-vol, plafond. Une
 * fiche bien visible refusée n'est pas « introuvable » : elle est verrouillée,
 * et on le dit.
 */
export async function assignClientAction(
  clientId: string,
  assignedToId: string | null,
): Promise<ActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.assign")) return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;
  if (assignedToId !== null && !z.string().uuid().safeParse(assignedToId).success) return INVALID;
  if (assignedToId !== null) {
    const target = await db.query.users.findFirst({ where: eq(users.id, assignedToId) });
    if (!target) return NOT_FOUND;
  }

  const guard = await guardClient(actor, clientId, "visible");
  if (!guard) return NOT_FOUND;
  const verdict = await verifyAssignment(actor, guard.ref, assignedToId);
  if (!verdict.ok) return assignRefusal(verdict.reason);

  const existing = await db.query.clients.findFirst({
    where: eq(clients.id, clientId),
    columns: { id: true, fullName: true, assignedToId: true },
  });
  if (!existing) return NOT_FOUND;
  // Réassigner à la même personne n'est pas un changement de main : ni ligne
  // d'audit, ni cloche pour un clic qui ne déplace rien.
  if (existing.assignedToId === assignedToId) return { ok: true, id: clientId };

  await db
    .update(clients)
    .set({ assignedToId, updatedAt: new Date() })
    .where(eq(clients.id, clientId));

  const changes = diffFields(existing, { assignedToId }, ["assignedToId"]);
  await logAudit({
    userId: actor.user.id,
    action: "client.assign",
    entity: "client",
    entityId: clientId,
    detail: { from: existing.assignedToId, to: assignedToId, ...(changes ? { changes } : {}) },
  });
  await notifyHandOvers(actor, [
    {
      clientId,
      clientName: existing.fullName,
      from: existing.assignedToId,
      to: assignedToId,
    },
  ]);
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

/** Droit `clients.delete` ET case « supprimer » ouverte sur cette fiche. */
export async function deleteClientAction(clientId: string): Promise<ActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.delete")) return FORBIDDEN;
  if (!z.string().uuid().safeParse(clientId).success) return INVALID;

  if (!(await guardClient(actor, clientId, "delete"))) return NOT_FOUND;

  const existing = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!existing) return NOT_FOUND;

  await deleteClientCore(actor.user.id, existing, false);
  revalidatePath("/clients");
  revalidatePath("/dashboard");
  return { ok: true };
}

// ── Actions en masse (vue tableau) ───────────────────────────────────────────
// Le droit `clients.bulk` ouvre la porte, le droit du GESTE (assigner,
// classer, modifier, supprimer) décide de ce qu'on peut faire, et la matrice
// tranche ENCORE fiche par fiche : un lot n'est jamais un passe-droit sur ce
// qui serait refusé à l'unité. Chaque fiche touchée reçoit SA ligne d'audit
// (marquée `bulk`), afin que « modifiée par qui » et /admin/audit restent
// exacts fiche par fiche.

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

/** Assigne (ou rend au bassin) plusieurs fiches — fiche par fiche, quand même. */
export async function bulkAssignClientsAction(
  clientIds: string[],
  assignedToId: string | null,
): Promise<BulkResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.bulk") || !actor.can("clients.assign")) return FORBIDDEN;

  const ids = bulkIdsSchema.safeParse(clientIds);
  if (!ids.success) return INVALID;
  if (assignedToId !== null && !z.string().uuid().safeParse(assignedToId).success) return INVALID;
  if (assignedToId !== null) {
    const target = await db.query.users.findFirst({ where: eq(users.id, assignedToId) });
    if (!target) return NOT_FOUND;
  }

  const existing = await db
    .select({
      id: clients.id,
      fullName: clients.fullName,
      assignedToId: clients.assignedToId,
      lastContactedAt: clients.lastContactedAt,
      updatedAt: clients.updatedAt,
    })
    .from(clients)
    .where(inArray(clients.id, ids.data));

  /**
   * Le plafond se compte SUR LE LOT. Le verdict le vérifie fiche par fiche
   * avec le même compte de départ : 200 fiches d'un coup passeraient donc
   * toutes sous un plafond que la première franchit déjà. Il ne concerne que
   * ce qu'on prend POUR SOI — donner ne remplit pas l'appétit de l'autre.
   */
  const cap =
    assignedToId !== null && assignedToId === actor.user.id && !actor.role.superAdmin
      ? actor.role.assignment.maxOwned
      : 0;
  let headroom =
    cap > 0 ? Math.max(0, cap - (await ownedCount(actor.user.id))) : Number.POSITIVE_INFINITY;

  const moves: HandOver[] = [];
  let refused: AssignRefusal | null = null;
  for (const row of await keepGranted(actor, existing, "visible")) {
    if (row.assignedToId === assignedToId) continue;
    const verdict = await verifyAssignment(actor, row, assignedToId);
    if (!verdict.ok) {
      refused ??= verdict.reason;
      continue;
    }
    if (headroom <= 0) {
      refused ??= "cap_reached";
      continue;
    }
    headroom -= 1;
    moves.push({
      clientId: row.id,
      clientName: row.fullName,
      from: row.assignedToId,
      to: assignedToId,
    });
  }

  // Rien n'a bougé ET quelque chose a été refusé : le lot mérite son motif.
  // « 0 fiche assignée » laisserait croire à un clic sans effet.
  if (moves.length === 0 && refused) return assignRefusal(refused);

  if (moves.length > 0) {
    await db
      .update(clients)
      .set({ assignedToId, updatedAt: new Date() })
      .where(
        inArray(
          clients.id,
          moves.map((m) => m.clientId),
        ),
      );
    await logBulkAudit(
      moves.map((m) => ({
        userId: actor.user.id,
        action: "client.assign",
        entityId: m.clientId,
        detail: {
          bulk: true,
          from: m.from,
          to: assignedToId,
          changes: { assignedToId: { from: m.from, to: assignedToId } } as AuditChanges,
        },
      })),
    );
    await notifyHandOvers(actor, moves);
    revalidateClientLists();
  }
  return { ok: true, count: moves.length };
}

/** Change le statut pipeline de plusieurs fiches d'un coup. */
export async function bulkSetClientsCategoryAction(
  clientIds: string[],
  categoryId: number | null,
): Promise<BulkResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.bulk") || !actor.can("clients.category")) return FORBIDDEN;

  const ids = bulkIdsSchema.safeParse(clientIds);
  if (!ids.success) return INVALID;
  if (categoryId !== null && !Number.isInteger(categoryId)) return INVALID;
  // La clé de la cible décide des effets d'entrée (« Ne pas appeler » → doNotCall).
  const target =
    categoryId === null
      ? null
      : ((await db.query.categories.findFirst({
          where: eq(categories.id, categoryId),
          columns: { id: true, key: true },
        })) ?? null);
  if (categoryId !== null && !target) return NOT_FOUND;

  const existing = await db
    .select({
      id: clients.id,
      categoryId: clients.categoryId,
      assignedToId: clients.assignedToId,
    })
    .from(clients)
    .where(inArray(clients.id, ids.data));
  const allowed = await keepGranted(actor, existing, "category");
  const changed = allowed.filter((c) => c.categoryId !== categoryId);

  if (changed.length > 0) {
    await db
      .update(clients)
      .set({ ...categoryEntryPatch(target), updatedAt: new Date() })
      .where(
        inArray(
          clients.id,
          changed.map((c) => c.id),
        ),
      );
    await logBulkAudit(
      changed.map((c) => ({
        userId: actor.user.id,
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
    // Même déclencheur de campagne qu'un changement à l'unité : une mise en
    // masse vers « chaud » est une arrivée dans « chaud » pour chaque fiche.
    notifyCategoryChanges(changed.map((c) => ({ clientId: c.id, from: c.categoryId, to: categoryId })));
    revalidateClientLists();
  }
  return { ok: true, count: changed.length };
}

/** Change la source de plusieurs fiches d'un coup — c'est une modification. */
export async function bulkSetClientsSourceAction(
  clientIds: string[],
  sourceId: number | null,
): Promise<BulkResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.bulk") || !actor.can("clients.edit")) return FORBIDDEN;

  const ids = bulkIdsSchema.safeParse(clientIds);
  if (!ids.success) return INVALID;
  if (sourceId !== null && !Number.isInteger(sourceId)) return INVALID;
  if (sourceId !== null) {
    const target = await db.query.sources.findFirst({ where: eq(sources.id, sourceId) });
    if (!target) return NOT_FOUND;
  }

  const existing = await db
    .select({ id: clients.id, sourceId: clients.sourceId, assignedToId: clients.assignedToId })
    .from(clients)
    .where(inArray(clients.id, ids.data));
  const allowed = await keepGranted(actor, existing, "edit");
  const changed = allowed.filter((c) => c.sourceId !== sourceId);

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
        userId: actor.user.id,
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

/** Suppression en masse, avec annulation des événements Google. */
export async function bulkDeleteClientsAction(clientIds: string[]): Promise<BulkResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.bulk") || !actor.can("clients.delete")) return FORBIDDEN;

  const ids = bulkIdsSchema.safeParse(clientIds);
  if (!ids.success) return INVALID;

  const rows = await db.query.clients.findMany({ where: inArray(clients.id, ids.data) });
  const existing = await keepGranted(actor, rows, "delete");
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
        userId: actor.user.id,
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
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.followup")) return FORBIDDEN;

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

  // La garde charge déjà la fiche RÉDUITE à ce qui décide de l'accès — dont le
  // responsable, seule chose dont la relance ait besoin ici.
  const guard = await guardClient(actor, clientId, "followup");
  if (!guard) return NOT_FOUND;

  const dueAt = fromZonedTime(`${date}T${time}:00`, APP_TZ);
  if (Number.isNaN(dueAt.getTime())) return INVALID;

  await db.insert(followups).values({
    clientId,
    assignedToId: guard.ref.assignedToId ?? actor.user.id,
    dueAt,
    note,
    createdById: actor.user.id,
  });

  await syncNextFollowup(clientId);
  revalidateClient(clientId);
  return { ok: true };
}

export async function completeFollowupAction(followupId: string): Promise<ActionResult> {
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.followup")) return FORBIDDEN;
  if (!z.string().uuid().safeParse(followupId).success) return INVALID;

  const followup = await db.query.followups.findFirst({ where: eq(followups.id, followupId) });
  if (!followup) return NOT_FOUND;
  // La relance suit sa fiche : invisible, elle n'existe pas non plus.
  if (!(await guardClient(actor, followup.clientId, "followup"))) return NOT_FOUND;

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
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.followup")) return FORBIDDEN;

  const parsed = z
    .object({ followupId: z.string().uuid(), date: dateStr, time: timeStr })
    .safeParse(input);
  if (!parsed.success) return INVALID;
  const { followupId, date, time } = parsed.data;

  const followup = await db.query.followups.findFirst({ where: eq(followups.id, followupId) });
  if (!followup) return NOT_FOUND;
  if (!(await guardClient(actor, followup.clientId, "followup"))) return NOT_FOUND;

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
  const actor = await currentActor();
  if (!actor) return FORBIDDEN;
  if (!actor.can("clients.comment")) return FORBIDDEN;

  const parsed = z
    .object({ clientId: z.string().uuid(), body: z.string().trim().min(1).max(5000) })
    .safeParse(input);
  if (!parsed.success) return INVALID;
  const { clientId, body } = parsed.data;

  if (!(await guardClient(actor, clientId, "comment"))) return NOT_FOUND;

  await db.insert(comments).values({ clientId, userId: actor.user.id, body });

  // Notify mentioned users (in THEIR locale), excluding the author.
  const mentionIds = extractMentionIds(body).filter((id) => id !== actor.user.id);
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
          title: notificationContent(m.locale, "mentionTitle", { name: actor.user.name }),
          body: excerpt,
          link: `/clients/${clientId}`,
        })),
      );
    }
  }

  revalidateClient(clientId);
  return { ok: true };
}
