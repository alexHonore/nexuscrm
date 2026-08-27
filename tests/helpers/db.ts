/**
 * Accès direct à la base de test + fabriques de données.
 * Chaque suite d'intégration part d'une base vide (resetDb).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import bcrypt from "bcryptjs";
import * as schemaCrm from "@/db/schema";
import * as schemaSms from "@/db/schema-sms";

const schema = { ...schemaCrm, ...schemaSms };

const conn = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
export const testDb = drizzle(conn, { schema });
export const sqlRaw = conn;

export async function resetDb(): Promise<void> {
  await conn.unsafe(`
    truncate table
      audit_logs, notifications, comments, followups, appointments, calls,
      password_resets, login_throttle, webhook_keys, settings, clients, users, sources, categories,
      messages, conversations, consents, suppressions, sms_numbers, scheduled_jobs,
      agent_turn_traces, agent_events, call_transcripts,
      guardrail_runs, guardrail_audit, guardrail_fixtures, guardrail_rules,
      campaign_touches, campaign_enrollments, campaigns,
      assistant_versions, assistants, objection_packs, prompt_cores, param_docs
    restart identity cascade;
  `);
}

export async function closeDb(): Promise<void> {
  await conn.end();
}

// ── Fabriques ────────────────────────────────────────────────────────────────

export async function makeUser(overrides: Partial<typeof schema.users.$inferInsert> = {}) {
  const password = overrides.passwordHash ? undefined : "TestPassword123!";
  const [user] = await testDb
    .insert(schema.users)
    .values({
      name: overrides.name ?? "Test User",
      email: overrides.email ?? `user${Math.random().toString(36).slice(2, 10)}@test.local`,
      passwordHash: overrides.passwordHash ?? (await bcrypt.hash(password!, 4)),
      role: overrides.role ?? "caller",
      locale: overrides.locale ?? "fr",
      isActive: overrides.isActive ?? true,
      sipUsername: overrides.sipUsername ?? null,
      sipPasswordEnc: overrides.sipPasswordEnc ?? null,
      didNumber: overrides.didNumber ?? null,
      ...overrides,
    })
    .returning();
  return { ...user, plainPassword: password };
}

export async function makeCategory(overrides: Partial<typeof schema.categories.$inferInsert> = {}) {
  const [row] = await testDb
    .insert(schema.categories)
    .values({
      key: overrides.key ?? null,
      nameFr: overrides.nameFr ?? "Catégorie",
      nameEn: overrides.nameEn ?? "Category",
      color: overrides.color ?? "#64748b",
      sortOrder: overrides.sortOrder ?? 0,
      isSystem: overrides.isSystem ?? false,
      ...overrides,
    })
    .returning();
  return row;
}

/** Les 7 catégories système utilisées par les dispositions d'appel. */
export async function seedSystemCategories() {
  const defs = [
    { key: "new", nameFr: "Non contacté", nameEn: "Not contacted", sortOrder: 0 },
    { key: "voicemail", nameFr: "Boîte vocale", nameEn: "Voicemail", sortOrder: 1 },
    { key: "callback", nameFr: "À rappeler", nameEn: "Callback", sortOrder: 2 },
    { key: "booked", nameFr: "Rendez-vous", nameEn: "Booked", sortOrder: 3 },
    { key: "not_interested", nameFr: "Pas intéressé", nameEn: "Not interested", sortOrder: 4 },
    { key: "not_qualified", nameFr: "Non qualifié", nameEn: "Not qualified", sortOrder: 5 },
    { key: "dncl", nameFr: "Ne pas appeler", nameEn: "Do not call", sortOrder: 6 },
  ];
  const rows = [];
  for (const d of defs) rows.push(await makeCategory({ ...d, isSystem: true }));
  return Object.fromEntries(rows.map((r) => [r.key!, r]));
}

export async function makeSource(overrides: Partial<typeof schema.sources.$inferInsert> = {}) {
  const [row] = await testDb
    .insert(schema.sources)
    .values({
      name: overrides.name ?? `Source ${Math.random().toString(36).slice(2, 10)}`,
      color: overrides.color ?? "#64748b",
      ...overrides,
    })
    .returning();
  return row;
}

export async function makeClient(overrides: Partial<typeof schema.clients.$inferInsert> = {}) {
  const [row] = await testDb
    .insert(schema.clients)
    .values({
      fullName: overrides.fullName ?? "Client Test",
      phone: overrides.phone ?? `+1418555${Math.floor(1000 + Math.random() * 8999)}`,
      ...overrides,
    })
    .returning();
  return row;
}

export async function makeSmsNumber(overrides: Partial<typeof schema.smsNumbers.$inferInsert> = {}) {
  const [row] = await testDb
    .insert(schema.smsNumbers)
    .values({
      e164: overrides.e164 ?? `+1581555${Math.floor(1000 + Math.random() * 8999)}`,
      label: overrides.label ?? "Ligne test",
      ...overrides,
    })
    .returning();
  return row;
}

export async function makeConversation(
  overrides: Partial<typeof schema.conversations.$inferInsert> &
    Pick<typeof schema.conversations.$inferInsert, "clientId" | "smsNumberId">,
) {
  const [row] = await testDb
    .insert(schema.conversations)
    .values({
      clientPhone: overrides.clientPhone ?? `+1418555${Math.floor(1000 + Math.random() * 8999)}`,
      ...overrides,
    })
    .returning();
  return row;
}
