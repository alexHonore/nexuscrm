import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories, clients, notifications, sources, users, webhookKeys } from "@/db/schema";
import { notificationContent } from "@/components/clients/notification-content";
import { runAfterResponse } from "@/lib/after-response";
import { logAudit } from "@/lib/audit";
import { sha256Hex } from "@/lib/crypto";
import { formatPhone, normalizePhone, phoneMatchKey } from "@/lib/phone";
import { clientPhoneMatch } from "@/lib/webhooks/client-match";
import {
  LEAD_FIELD_ALIASES,
  LEAD_MAX_BODY_BYTES,
  type LeadField,
} from "@/lib/webhooks/lead-fields";

/**
 * Webhook entrant public (n8n / Facebook Lead Ads / site web).
 * Auth : en-tête `x-api-key` OU `Authorization: Bearer <clé>`.
 * Tolérant sur les noms de champs (français accentués Facebook inclus) et sur
 * la forme n8n `{ data: { ... } }` — les champs sont cherchés à la racine ET
 * dans `.data`.
 */


function coerce(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(coerce).filter(Boolean);
    return parts.length ? parts.join(", ") : undefined;
  }
  return undefined;
}

function extract(payload: Record<string, unknown>): Partial<Record<LeadField, string>> {
  // Clés normalisées (minuscules, espaces → _) pour tolérer les variantes.
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(payload)) {
    normalized.set(k.trim().toLowerCase().replace(/\s+/g, "_"), v);
  }
  const out: Partial<Record<LeadField, string>> = {};
  for (const [field, aliases] of Object.entries(LEAD_FIELD_ALIASES) as [
    LeadField,
    readonly string[],
  ][]) {
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
  if (contentLength > LEAD_MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const raw = await req.text();
  if (raw.length > LEAD_MAX_BODY_BYTES) {
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

  // ── Dédoublonnage par téléphone — E.164 exact, sinon les 10 derniers
  // chiffres (principal ET secondaire), jamais une clé plus courte. ──
  // Recherche et écriture sous UN verrou consultatif transactionnel par numéro :
  // deux livraisons du même lead à quelques millisecondes (relance n8n,
  // double envoi Facebook, formulaire soumis deux fois) lisaient toutes deux
  // « aucune fiche » et créaient deux clients — puis deux inscriptions de
  // campagne, deux SMS d'ouverture. La seconde attend la première, la voit, et
  // prend la branche « existant ». Le verrou tombe avec la transaction, y
  // compris sur un pooler en mode transaction (même motif que enroll.ts).
  const lockKey = `lead:${phoneMatchKey(phone) ?? phone}`;
  const phoneMatch = clientPhoneMatch(phone);
  const { clientId, created, clientName, assignedToId } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const existing = await tx.query.clients.findFirst({
      where: phoneMatch.where,
      orderBy: phoneMatch.orderBy,
    });

    if (existing) {
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
      await tx.update(clients).set(set).where(eq(clients.id, existing.id));
      return {
        clientId: existing.id,
        created: false,
        clientName: existing.fullName,
        assignedToId: existing.assignedToId,
      };
    }

    const name = fields.name || formatPhone(phone);
    const [inserted] = await tx
      .insert(clients)
      .values({
        fullName: name,
        phone,
        email: fields.email ?? null,
        city: fields.city ?? null,
        projectType: fields.projectType ?? null,
        timing: fields.timing ?? null,
        notes: fields.notes ?? null,
        language: "fr",
        categoryId: defaultCategoryId ?? newCategory?.id ?? null,
        sourceId,
        assignedToId: defaultAssignedToId,
        meta: root,
      })
      .returning({ id: clients.id });
    return {
      clientId: inserted.id,
      created: true,
      clientName: name,
      assignedToId: defaultAssignedToId,
    };
  });

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

  // Le moteur de campagnes tourne APRÈS la réponse. n8n attend un 200 ; le
  // faire patienter pendant l'évaluation des audiences et la mise en file des
  // barreaux finirait par un délai dépassé côté n8n, un renvoi du lead, et un
  // deuxième client. Une campagne qui échoue ne doit pas non plus faire échouer
  // l'entrée du lead — d'où le catch silencieux, le détail étant journalisé.
  runAfterResponse(async () => {
    try {
      const { matchCampaigns } = await import("@/lib/campaigns-server/match");
      const matches = await matchCampaigns(clientId);
      const enrolled = matches.filter((m) => m.enrolled);
      if (enrolled.length > 0) {
        await logAudit({
          userId: null,
          action: "campaign.enroll",
          entity: "client",
          entityId: clientId,
          detail: { campaignIds: enrolled.map((m) => m.campaignId), via: "lead_created" },
        });
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          at: "webhooks/leads",
          event: "match_campaigns_failed",
          clientId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  return NextResponse.json({ ok: true, clientId, created });
}
