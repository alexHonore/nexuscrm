import { and, eq, like, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories, clients, notifications, sources, users, webhookKeys } from "@/db/schema";
import { notificationContent } from "@/components/clients/notification-content";
import { logAudit } from "@/lib/audit";
import { sha256Hex } from "@/lib/crypto";
import { formatPhone, normalizePhone, phoneMatchKey } from "@/lib/phone";

/**
 * Webhook entrant public (n8n / Facebook Lead Ads / site web).
 * Auth : en-tête `x-api-key` OU `Authorization: Bearer <clé>`.
 * Tolérant sur les noms de champs (français accentués Facebook inclus) et sur
 * la forme n8n `{ data: { ... } }` — les champs sont cherchés à la racine ET
 * dans `.data`.
 */

const MAX_BODY_BYTES = 100_000;

const ALIASES = {
  name: ["name", "nom_complet", "full_name", "fullname", "nom"],
  phone: [
    "phone",
    "numéro_de_téléphone",
    "numero_de_telephone",
    "telephone",
    "téléphone",
    "phone_number",
  ],
  email: ["email", "e-mail", "courriel"],
  projectType: [
    "type",
    "quel_est_votre_besoin_?",
    "quel_est_votre_besoin?",
    "besoin",
    "project_type",
  ],
  timing: [
    "timing",
    "votre_projet_est_prévu_pour_quand_?",
    "votre_projet_est_prevu_pour_quand_?",
    "votre_projet_est_prévu_pour_quand?",
    "délai",
    "delai",
  ],
  source: ["source"],
  notes: ["notes", "note", "message"],
  city: ["city", "ville"],
} as const;

function coerce(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(coerce).filter(Boolean);
    return parts.length ? parts.join(", ") : undefined;
  }
  return undefined;
}

function extract(payload: Record<string, unknown>): Partial<Record<keyof typeof ALIASES, string>> {
  // Clés normalisées (minuscules, espaces → _) pour tolérer les variantes.
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(payload)) {
    normalized.set(k.trim().toLowerCase().replace(/\s+/g, "_"), v);
  }
  const out: Partial<Record<keyof typeof ALIASES, string>> = {};
  for (const [field, aliases] of Object.entries(ALIASES) as [keyof typeof ALIASES, readonly string[]][]) {
    for (const alias of aliases) {
      const value = coerce(normalized.get(alias));
      if (value !== undefined) {
        out[field] = value;
        break;
      }
    }
  }
  return out;
}

type KeyDefaults = {
  categoryId?: number | null;
  sourceId?: number | null;
  assignedToId?: string | null;
};

export async function POST(req: Request) {
  // ── Taille du corps ──
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  // ── Authentification par clé API ──
  const authHeader = req.headers.get("authorization") ?? "";
  const apiKey =
    req.headers.get("x-api-key")?.trim() ||
    (authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "");
  if (!apiKey) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const key = await db.query.webhookKeys.findFirst({
    where: and(eq(webhookKeys.keyHash, sha256Hex(apiKey)), eq(webhookKeys.isActive, true)),
  });
  if (!key) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // ── Corps JSON — racine + .data (forme n8n) ──
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const root = body as Record<string, unknown>;
  const nested =
    typeof root.data === "object" && root.data !== null && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : {};
  // Les champs de `.data` ont priorité sur la racine.
  const fields = { ...extract(root), ...extract(nested) };

  const phone = normalizePhone(fields.phone);
  if (!phone) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 422 });
  }

  const defaults = (key.defaults ?? {}) as KeyDefaults;

  // ── Défauts de la clé : ignorer les ids qui ne référencent plus rien ──
  // (catégorie/source/utilisateur supprimés → violation de FK et lead perdu).
  const defaultCategoryId =
    defaults.categoryId != null &&
    (await db.query.categories.findFirst({
      where: eq(categories.id, defaults.categoryId),
      columns: { id: true },
    }))
      ? defaults.categoryId
      : null;
  const defaultSourceId =
    defaults.sourceId != null &&
    (await db.query.sources.findFirst({
      where: eq(sources.id, defaults.sourceId),
      columns: { id: true },
    }))
      ? defaults.sourceId
      : null;
  const defaultAssignedToId =
    defaults.assignedToId != null &&
    (await db.query.users.findFirst({
      where: eq(users.id, defaults.assignedToId),
      columns: { id: true },
    }))
      ? defaults.assignedToId
      : null;

  // ── Résolution de la source : payload (par nom) sinon défauts de la clé ──
  let sourceId: number | null = defaultSourceId;
  if (fields.source) {
    const match = await db.query.sources.findFirst({
      where: sql`lower(${sources.name}) = ${fields.source.toLowerCase()}`,
    });
    if (match) sourceId = match.id;
  }

  const newCategory = await db.query.categories.findFirst({ where: eq(categories.key, "new") });

  // ── Dédoublonnage par téléphone (10 derniers chiffres) — principal ET secondaire ──
  const matchKey = phoneMatchKey(phone);
  const existing = matchKey
    ? await db.query.clients.findFirst({
        where: or(like(clients.phone, `%${matchKey}`), like(clients.phoneAlt, `%${matchKey}`)),
      })
    : undefined;

  let clientId: string;
  let created: boolean;
  let clientName: string;
  let assignedToId: string | null;

  if (existing) {
    created = false;
    clientId = existing.id;
    clientName = existing.fullName;
    assignedToId = existing.assignedToId;

    const set: Partial<typeof clients.$inferInsert> = { updatedAt: new Date() };
    if (!existing.timing && fields.timing) set.timing = fields.timing;
    if (!existing.projectType && fields.projectType) set.projectType = fields.projectType;
    if (!existing.email && fields.email) set.email = fields.email;
    if (!existing.city && fields.city) set.city = fields.city;
    // Catégorie « Non contacté » SEULEMENT si le client n'a aucune catégorie.
    if (existing.categoryId == null && newCategory) set.categoryId = newCategory.id;
    // Trace du nouveau lead dans meta (les commentaires exigent un utilisateur).
    const prevMeta =
      typeof existing.meta === "object" && existing.meta !== null && !Array.isArray(existing.meta)
        ? (existing.meta as Record<string, unknown>)
        : {};
    set.meta = {
      ...prevMeta,
      lastWebhook: { at: new Date().toISOString(), keyName: key.name, payload: root },
    };
    await db.update(clients).set(set).where(eq(clients.id, existing.id));
  } else {
    created = true;
    clientName = fields.name || formatPhone(phone);
    assignedToId = defaultAssignedToId;
    const [inserted] = await db
      .insert(clients)
      .values({
        fullName: clientName,
        phone,
        email: fields.email ?? null,
        city: fields.city ?? null,
        projectType: fields.projectType ?? null,
        timing: fields.timing ?? null,
        notes: fields.notes ?? null,
        language: "fr",
        categoryId: defaultCategoryId ?? newCategory?.id ?? null,
        sourceId,
        assignedToId,
        meta: root,
      })
      .returning({ id: clients.id });
    clientId = inserted.id;
  }

  // ── Notifications : tous les admins actifs + l'assigné (dans LEUR langue) ──
  const admins = await db.query.users.findMany({
    where: and(eq(users.role, "admin"), eq(users.isActive, true)),
    columns: { id: true, locale: true },
  });
  const recipients = new Map(admins.map((a) => [a.id, a.locale]));
  if (assignedToId && !recipients.has(assignedToId)) {
    const assignee = await db.query.users.findFirst({
      where: eq(users.id, assignedToId),
      columns: { id: true, locale: true },
    });
    if (assignee) recipients.set(assignee.id, assignee.locale);
  }
  if (recipients.size > 0) {
    await db.insert(notifications).values(
      Array.from(recipients, ([userId, locale]) => ({
        userId,
        type: "incoming_lead",
        title: notificationContent(locale, "incomingLeadTitle", { name: clientName }),
        body: notificationContent(
          locale,
          created ? "incomingLeadNewBody" : "incomingLeadExistingBody",
          { phone: formatPhone(phone), source: key.name },
        ),
        link: `/clients/${clientId}`,
      })),
    );
  }

  await db.update(webhookKeys).set({ lastUsedAt: new Date() }).where(eq(webhookKeys.id, key.id));

  await logAudit({
    userId: null,
    action: "webhook.lead",
    entity: "client",
    entityId: clientId,
    detail: { keyId: key.id, keyName: key.name, created },
  });

  return NextResponse.json({ ok: true, clientId, created });
}
