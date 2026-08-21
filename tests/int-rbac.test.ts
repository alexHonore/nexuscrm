/**
 * Tests d'intégration — RBAC (la garantie la plus importante du produit).
 *
 * 1. TOUTES les routes sous src/app/api/admin/** (énumérées sur le disque) :
 *    anonyme → 401, téléphoniste → 403, admin → ni 401 ni 403.
 * 2. Les chemins « côté téléphoniste » refusent les actions réservées à l'admin
 *    et l'accès aux données d'autrui.
 * 3. Les routes /api/cron/* exigent le bon Bearer CRON_SECRET.
 *
 * Seuls next/headers, next/cache et le réseau externe (voip.ms, Google) sont
 * simulés — les gardes, les JWT et la base sont réels.
 */
import { readdirSync } from "fs";
import { join, relative, sep } from "path";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeCategory, makeClient, makeUser, resetDb, seedSystemCategories, testDb } from "./helpers/db";
import { calls, categories, clients, notifications, sources, users, webhookKeys } from "@/db/schema";
import { assistants, campaigns } from "@/db/schema-sms";

vi.mock("server-only", () => ({}));

// ── Contexte de requête simulé ───────────────────────────────────────────────

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, { name: string; value: string; options?: Record<string, unknown> }>(),
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const c = ctx.cookies.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    getAll() {
      return [...ctx.cookies.values()].map((c) => ({ name: c.name, value: c.value }));
    },
    has(name: string) {
      return ctx.cookies.has(name);
    },
    set(name: string, value: string, options?: Record<string, unknown>) {
      ctx.cookies.set(name, { name, value, options });
    },
    delete(name: string) {
      ctx.cookies.delete(name);
    },
  }),
  headers: async () => ctx.headers,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

// ── Réseau externe : jamais appelé pour de vrai ──────────────────────────────

vi.mock("@/lib/voipms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voipms")>();
  return {
    ...actual,
    voipms: vi.fn(async () => ({})),
    getSubAccounts: vi.fn(async () => []),
    createSubAccount: vi.fn(async () => ({ account: "551013_test" })),
    setSubAccountPassword: vi.fn(async () => ({})),
    getDids: vi.fn(async () => []),
    routeDidToSubAccount: vi.fn(async () => ({})),
    getCdr: vi.fn(async () => []),
    getCallRecordings: vi.fn(async () => []),
  };
});

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials() {}
        generateAuthUrl() {
          return "https://accounts.google.com/o/oauth2/v2/auth";
        }
      },
    },
    calendar: () => ({ calendarList: { list: async () => ({ data: { items: [] } }) } }),
  },
}));

vi.mock("@/lib/google", () => ({
  GoogleNotConnectedError: class extends Error {},
  GOOGLE_STATE_COOKIE: "google_oauth_state",
  GOOGLE_SCOPES: [],
  getOAuthClient: () => ({}),
  cancelEvent: vi.fn(async () => {}),
  createEvent: vi.fn(async () => ({ id: "evt" })),
  getAuthedCalendar: vi.fn(async () => ({})),
}));

const fetchSpy = vi.fn(async () => {
  throw new Error("réseau interdit dans les tests");
});
vi.stubGlobal("fetch", fetchSpy);

import { markAllNotificationsReadAction, markNotificationReadAction } from "@/app/(app)/notifications/actions";
import {
  assignClientAction,
  createClientAction,
  deleteClientAction,
  updateClientAction,
} from "@/app/(app)/clients/actions";
import { apiAdmin, apiUser, getCurrentUser, requireAdmin, requireUser } from "@/lib/auth/guards";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { encryptSecret, sha256Hex } from "@/lib/crypto";
import proxy from "@/proxy";

// ── Outils de session ────────────────────────────────────────────────────────

type Actor = Awaited<ReturnType<typeof makeUser>>;

async function signFor(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  return new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
}

async function loginAs(user: Actor | null) {
  ctx.cookies.clear();
  if (!user) return;
  ctx.cookies.set(SESSION_COOKIE_NAME, {
    name: SESSION_COOKIE_NAME,
    value: await signFor(user),
  });
}

// ── Énumération des routes admin ─────────────────────────────────────────────

const APP_DIR = join(process.cwd(), "src", "app");
const ADMIN_API_DIR = join(APP_DIR, "api", "admin");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectRouteFiles(full));
    else if (/^route\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/**
 * Les routes d'assistants vivent hors de /api/admin mais sont tout aussi
 * réservées : compiler, activer, exporter ou importer un assistant sont des
 * gestes d'administrateur. Elles sont balayées avec les autres — une route
 * ajoutée sous /api/assistants sans garde fait échouer ce test.
 */
const ASSISTANT_API_DIR = join(APP_DIR, "api", "assistants");
const CAMPAIGN_API_DIR = join(APP_DIR, "api", "campaigns");

const ADMIN_ROUTES = [
  ...collectRouteFiles(ADMIN_API_DIR),
  ...collectRouteFiles(ASSISTANT_API_DIR),
  ...collectRouteFiles(CAMPAIGN_API_DIR),
]
  .sort()
  .map((file) => ({
    file,
    /** ex. "/api/admin/users/[id]" */
    pattern: "/" + relative(APP_DIR, file).split(sep).slice(0, -1).join("/"),
  }));

/** Identifiants concrets injectés dans les segments dynamiques + les corps. */
type Fixtures = {
  admin: Actor;
  caller: Actor;
  categoryId: number;
  sourceId: number;
  webhookKeyId: number;
  assistantId: string;
  campaignId: string;
};

function concreteUrl(pattern: string, f: Fixtures): { path: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const path = pattern.replace(/\[([^\]]+)\]/g, (_m, name: string) => {
    let value: string;
    if (pattern.includes("/campaigns/")) value = f.campaignId;
    else if (pattern.includes("/assistants/")) value = f.assistantId;
    else if (pattern.includes("/users/")) value = f.caller.id;
    else if (pattern.includes("/categories/")) value = String(f.categoryId);
    else if (pattern.includes("/sources/")) value = String(f.sourceId);
    else if (pattern.includes("/webhook-keys/")) value = String(f.webhookKeyId);
    else value = "1";
    params[name] = value;
    return value;
  });
  return { path, params };
}

/** Corps plausible par route — évite les 500 parasites lors du passage « admin ». */
function bodyFor(pattern: string, f: Fixtures): unknown {
  switch (pattern) {
    case "/api/admin/categories":
      return { nameFr: "Test", nameEn: "Test", color: "#123456" };
    case "/api/admin/categories/[id]":
      return { nameFr: "Modifiée", nameEn: "Updated", color: "#654321" };
    case "/api/admin/categories/reorder":
      return { orderedIds: [f.categoryId] };
    case "/api/admin/sources":
      return { name: `Source ${Math.random().toString(36).slice(2, 8)}`, color: "#123456" };
    case "/api/admin/sources/[id]":
      return { name: `Source ${Math.random().toString(36).slice(2, 8)}` };
    case "/api/admin/users":
      return {
        name: "Nouveau",
        email: `nouveau${Math.random().toString(36).slice(2, 8)}@nexus.test`,
        role: "caller",
        locale: "fr",
      };
    case "/api/admin/users/[id]":
      return { name: "Renommé" };
    case "/api/admin/webhook-keys":
      return { name: "Clé n8n" };
    case "/api/admin/webhook-keys/[id]":
      return { name: "Clé renommée" };
    case "/api/admin/settings/booking":
      return { meetDurationMin: 45 };
    case "/api/admin/settings/google":
      return { calendarId: "primary" };
    case "/api/admin/settings/telephony":
      return { provider: "voipms" };
    case "/api/admin/import":
      return { rows: [{ fullName: "Importé", phone: "4185551234" }], defaults: {}, mode: "skip" };
    case "/api/admin/password":
      return { current: "TestPassword123!", next: "NouveauMotDePasse!42" };
    case "/api/admin/voipms/subaccounts":
      return { userId: f.caller.id, username: "test_sub" };
    case "/api/admin/voipms/route-did":
      return { did: "4184761542", account: "551013_test", userId: f.caller.id };
    case "/api/campaigns":
      return {
        name: "Campagne de test",
        trigger: { kind: "manual" },
        ladder: [{ delayHours: 0, body: "Bonjour." }],
      };
    case "/api/campaigns/[id]":
      return { status: "paused" };
    case "/api/assistants/import":
      // Volontairement vide de sens : la garde doit refuser AVANT de regarder
      // le contenu, donc un corps invalide ne doit pas masquer un 401/403.
      return { mode: "preview", bundle: {} };
    default:
      return {};
  }
}

type Outcome = { status: number; threw?: unknown };

async function callRoute(
  file: string,
  method: string,
  pattern: string,
  f: Fixtures,
): Promise<Outcome> {
  const mod = (await import(/* @vite-ignore */ file)) as Record<
    string,
    (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
  >;
  const { path, params } = concreteUrl(pattern, f);
  const hasBody = method === "POST" || method === "PATCH" || method === "PUT";
  const req = new NextRequest(`http://localhost:3000${path}`, {
    method,
    ...(hasBody
      ? { body: JSON.stringify(bodyFor(pattern, f)), headers: { "content-type": "application/json" } }
      : {}),
  });
  try {
    const res = await mod[method](req, { params: Promise.resolve(params) });
    // L'export CSV répond en flux et journalise son audit APRÈS fermeture du
    // flux : on le draine ici pour que tout se termine à l'intérieur du test.
    if (res.headers.get("content-type")?.includes("text/csv")) {
      await res.text();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { status: res.status };
  } catch (err) {
    // Une exception signifie que la garde a laissé passer (donc ni 401 ni 403).
    return { status: 500, threw: err };
  }
}

async function methodsOf(file: string): Promise<string[]> {
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  return HTTP_METHODS.filter((m) => typeof mod[m] === "function");
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let fixtures: Fixtures;

beforeEach(async () => {
  await resetDb();
  ctx.cookies.clear();
  ctx.headers = new Headers();
  fetchSpy.mockClear();

  const admin = await makeUser({ email: "admin@nexus.test", role: "admin", name: "Admin" });
  const caller = await makeUser({ email: "caller@nexus.test", role: "caller", name: "Téléphoniste" });
  const category = await makeCategory({ nameFr: "Perso", nameEn: "Custom", isSystem: false });
  const [source] = await testDb.insert(sources).values({ name: "Facebook" }).returning();
  const key = "cle-webhook-de-test-0123456789";
  const [webhookKey] = await testDb
    .insert(webhookKeys)
    .values({
      name: "n8n",
      keyEnc: encryptSecret(key),
      keyHash: sha256Hex(key),
      keyLast4: key.slice(-4),
    })
    .returning();

  const [assistant] = await testDb
    .insert(assistants)
    .values({
      name: "Assistant de test",
      identity: {},
      goal: { primary: { type: "qualify_only" }, fallbacks: [] },
      approach: {},
      model: {},
    })
    .returning({ id: assistants.id });

  const [campaign] = await testDb
    .insert(campaigns)
    .values({
      name: "Campagne de test",
      trigger: { kind: "manual" },
      ladder: [{ delayHours: 0, body: "Bonjour.", label: "" }],
    })
    .returning({ id: campaigns.id });

  fixtures = {
    admin,
    caller,
    categoryId: category.id,
    sourceId: source.id,
    webhookKeyId: webhookKey.id,
    assistantId: assistant.id,
    campaignId: campaign.id,
  };
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("routes /api/admin/** — énumération complète", () => {
  it("trouve bien toutes les routes admin sur le disque", () => {
    expect(ADMIN_ROUTES.length).toBeGreaterThanOrEqual(24);
    expect(ADMIN_ROUTES.map((r) => r.pattern)).toContain("/api/admin/users/[id]");
    expect(ADMIN_ROUTES.map((r) => r.pattern)).toContain("/api/assistants/[id]/activate");
    expect(ADMIN_ROUTES.map((r) => r.pattern)).toContain("/api/assistants/import");
    expect(ADMIN_ROUTES.map((r) => r.pattern)).toContain("/api/campaigns/[id]/enroll");
  });

  it.each(ADMIN_ROUTES.map((r) => [r.pattern, r.file] as const))(
    "%s → 401 sans session",
    async (pattern, file) => {
      await loginAs(null);
      const methods = await methodsOf(file);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        const out = await callRoute(file, method, pattern, fixtures);
        expect(out.threw, `${method} ${pattern} a levé une exception`).toBeUndefined();
        expect(out.status, `${method} ${pattern}`).toBe(401);
      }
    },
  );

  it.each(ADMIN_ROUTES.map((r) => [r.pattern, r.file] as const))(
    "%s → 403 pour un téléphoniste",
    async (pattern, file) => {
      await loginAs(fixtures.caller);
      const methods = await methodsOf(file);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        const out = await callRoute(file, method, pattern, fixtures);
        expect(out.threw, `${method} ${pattern} a levé une exception`).toBeUndefined();
        expect(out.status, `${method} ${pattern}`).toBe(403);
      }
    },
  );

  it.each(ADMIN_ROUTES.map((r) => [r.pattern, r.file] as const))(
    "%s → ni 401 ni 403 pour un admin",
    async (pattern, file) => {
      await loginAs(fixtures.admin);
      const methods = await methodsOf(file);
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) {
        const out = await callRoute(file, method, pattern, fixtures);
        expect([401, 403], `${method} ${pattern} refusé à un admin`).not.toContain(out.status);
      }
    },
  );

  it("un téléphoniste ne modifie RIEN via les routes admin", async () => {
    const snapshot = async () => ({
      users: (await testDb.select().from(users)).length,
      categories: (await testDb.select().from(categories)).length,
      sources: (await testDb.select().from(sources)).length,
      clients: (await testDb.select().from(clients)).length,
      keys: (await testDb.select().from(webhookKeys)).length,
      callerHash: (await testDb.select().from(users).where(eq(users.id, fixtures.caller.id)))[0]
        .passwordHash,
    });

    const before = await snapshot();
    await loginAs(fixtures.caller);
    for (const { pattern, file } of ADMIN_ROUTES) {
      for (const method of await methodsOf(file)) {
        await callRoute(file, method, pattern, fixtures);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it("une session de téléphoniste falsifiée en admin est rejetée", async () => {
    // JWT signé avec le bon secret mais rôle mensonger : la garde relit la base.
    ctx.cookies.clear();
    const token = await new SignJWT({
      uid: fixtures.caller.id,
      role: "admin",
      tv: fixtures.caller.tokenVersion,
      remember: false,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
    ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: token });

    const res = await apiAdmin();
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);

    const users0 = await testDb.select().from(users);
    const before = users0.length;
    const mod = await import("@/app/api/admin/users/route");
    const created = await mod.POST(
      new NextRequest("http://localhost:3000/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ name: "X", email: "x@nexus.test", role: "admin", locale: "fr" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(created.status).toBe(403);
    expect((await testDb.select().from(users)).length).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("gardes de pages et d'API", () => {
  it("requireUser redirige vers /login sans session", async () => {
    await loginAs(null);
    await expect(requireUser()).rejects.toMatchObject({
      digest: expect.stringContaining("/login"),
    });
  });

  it("requireAdmin renvoie un téléphoniste vers /dashboard", async () => {
    await loginAs(fixtures.caller);
    await expect(requireAdmin()).rejects.toMatchObject({
      digest: expect.stringContaining("/dashboard"),
    });
  });

  it("apiUser/apiAdmin : 401 anonyme, 403 téléphoniste, utilisateur pour un admin", async () => {
    await loginAs(null);
    expect(((await apiUser()) as Response).status).toBe(401);
    expect(((await apiAdmin()) as Response).status).toBe(401);

    await loginAs(fixtures.caller);
    expect((await apiUser()) as { id: string }).toMatchObject({ id: fixtures.caller.id });
    expect(((await apiAdmin()) as Response).status).toBe(403);

    await loginAs(fixtures.admin);
    expect((await apiAdmin()) as { id: string }).toMatchObject({ id: fixtures.admin.id });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("actions serveur côté clients — le téléphoniste ne contourne rien", () => {
  it("createClientAction refuse un téléphoniste et n'insère rien", async () => {
    await loginAs(fixtures.caller);

    const res = await createClientAction({
      fullName: "Interdit",
      phone: "4185551234",
      language: "fr",
    });

    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(await testDb.select().from(clients)).toHaveLength(0);
  });

  it("createClientAction refuse un anonyme", async () => {
    await loginAs(null);
    expect(
      await createClientAction({ fullName: "Anonyme", phone: "4185551234", language: "fr" }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await testDb.select().from(clients)).toHaveLength(0);
  });

  it("createClientAction fonctionne pour un admin", async () => {
    await loginAs(fixtures.admin);

    const res = await createClientAction({
      fullName: "Client Admin",
      phone: "418 555 1234",
      language: "fr",
    });

    expect(res).toMatchObject({ ok: true });
    const rows = await testDb.select().from(clients);
    expect(rows).toHaveLength(1);
    expect(rows[0].phone).toBe("+14185551234");
    expect(rows[0].createdById).toBe(fixtures.admin.id);
  });

  it("deleteClientAction refuse un téléphoniste et la fiche survit", async () => {
    const client = await makeClient({ fullName: "À garder" });
    await loginAs(fixtures.caller);

    expect(await deleteClientAction(client.id)).toEqual({ ok: false, error: "forbidden" });

    expect(await testDb.select().from(clients).where(eq(clients.id, client.id))).toHaveLength(1);
  });

  it("assignClientAction refuse un téléphoniste et l'affectation ne bouge pas", async () => {
    const client = await makeClient({ assignedToId: null });
    await loginAs(fixtures.caller);

    expect(await assignClientAction(client.id, fixtures.caller.id)).toEqual({
      ok: false,
      error: "forbidden",
    });

    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.assignedToId).toBeNull();
  });

  it("updateClientAction : un téléphoniste peut éditer mais pas réaffecter", async () => {
    const client = await makeClient({ fullName: "Ancien", assignedToId: fixtures.caller.id });
    await loginAs(fixtures.caller);

    const res = await updateClientAction(client.id, {
      fullName: "Nouveau nom",
      phone: "4185559999",
      language: "fr",
      assignedToId: fixtures.admin.id, // tentative de réaffectation
    });

    expect(res).toMatchObject({ ok: true });
    const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(row.fullName).toBe("Nouveau nom");
    expect(row.assignedToId).toBe(fixtures.caller.id); // inchangé
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("PATCH /api/calls/[id] — propriété stricte", () => {
  async function patchCall(id: string, body: unknown) {
    const mod = await import("@/app/api/calls/[id]/route");
    return mod.PATCH(
      new NextRequest(`http://localhost:3000/api/calls/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  async function seedCall(userId: string, clientId: string | null) {
    const [row] = await testDb
      .insert(calls)
      .values({
        userId,
        clientId,
        direction: "outbound",
        startedAt: new Date(),
      })
      .returning();
    return row;
  }

  it("refuse de finaliser l'appel d'un AUTRE utilisateur (404, aucune écriture)", async () => {
    await seedSystemCategories();
    const client = await makeClient({});
    const call = await seedCall(fixtures.admin.id, client.id);

    await loginAs(fixtures.caller);
    const res = await patchCall(call.id, { disposition: "booked", durationSec: 120 });

    expect(res.status).toBe(404);
    const [row] = await testDb.select().from(calls).where(eq(calls.id, call.id));
    expect(row.disposition).toBeNull();
    expect(row.durationSec).toBe(0);
    const [clientRow] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(clientRow.lastDisposition).toBeNull();
  });

  it("401 sans session", async () => {
    const call = await seedCall(fixtures.caller.id, null);
    await loginAs(null);

    const res = await patchCall(call.id, { disposition: "no_answer" });

    expect(res.status).toBe(401);
  });

  it("accepte le propriétaire et applique la disposition", async () => {
    const cats = await seedSystemCategories();
    const client = await makeClient({});
    const call = await seedCall(fixtures.caller.id, client.id);

    await loginAs(fixtures.caller);
    const res = await patchCall(call.id, { disposition: "booked", durationSec: 42 });

    expect(res.status).toBe(200);
    const [row] = await testDb.select().from(calls).where(eq(calls.id, call.id));
    expect(row.disposition).toBe("booked");
    expect(row.durationSec).toBe(42);
    const [clientRow] = await testDb.select().from(clients).where(eq(clients.id, client.id));
    expect(clientRow.categoryId).toBe(cats.booked.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("notifications — chacun les siennes", () => {
  async function seedNotification(userId: string) {
    const [row] = await testDb
      .insert(notifications)
      .values({ userId, type: "mention", title: "Coucou", link: "/clients/x" })
      .returning();
    return row;
  }

  it("ne marque pas comme lue la notification d'un autre utilisateur", async () => {
    const target = await seedNotification(fixtures.admin.id);
    await loginAs(fixtures.caller);

    await markNotificationReadAction(target.id);

    const [row] = await testDb.select().from(notifications).where(eq(notifications.id, target.id));
    expect(row.readAt).toBeNull();
  });

  it("markAll ne touche que les siennes", async () => {
    const mine = await seedNotification(fixtures.caller.id);
    const other = await seedNotification(fixtures.admin.id);
    await loginAs(fixtures.caller);

    await markAllNotificationsReadAction();

    const [mineRow] = await testDb.select().from(notifications).where(eq(notifications.id, mine.id));
    const [otherRow] = await testDb
      .select()
      .from(notifications)
      .where(eq(notifications.id, other.id));
    expect(mineRow.readAt).toBeInstanceOf(Date);
    expect(otherRow.readAt).toBeNull();
  });

  it("refuse un anonyme", async () => {
    const target = await seedNotification(fixtures.caller.id);
    await loginAs(null);

    expect(await markNotificationReadAction(target.id)).toEqual({ ok: false });
    const [row] = await testDb.select().from(notifications).where(eq(notifications.id, target.id));
    expect(row.readAt).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("GET /api/clients/lookup — session obligatoire", () => {
  async function lookup(phone: string) {
    const mod = await import("@/app/api/clients/lookup/route");
    return mod.GET(
      new NextRequest(`http://localhost:3000/api/clients/lookup?phone=${encodeURIComponent(phone)}`),
    );
  }

  it("401 sans session (aucune fuite de fiche client)", async () => {
    await makeClient({ phone: "+14185551234", fullName: "Secret" });
    await loginAs(null);

    const res = await lookup("+14185551234");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("répond au téléphoniste connecté", async () => {
    await makeClient({ phone: "+14185551234", fullName: "Secret" });
    await loginAs(fixtures.caller);

    const res = await lookup("+14185551234");

    expect(res.status).toBe(200);
    expect((await res.json()).client).toMatchObject({ fullName: "Secret" });
  });

  it("401 avec un cookie de session bidon", async () => {
    ctx.cookies.clear();
    ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: "pas.un.jwt" });

    expect((await lookup("+14185551234")).status).toBe(401);
    expect(await getCurrentUser()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("routes /api/cron/* — Bearer CRON_SECRET", () => {
  const CRON_ROUTES = collectRouteFiles(join(APP_DIR, "api", "cron")).map((file) => ({
    file,
    pattern: "/" + relative(APP_DIR, file).split(sep).slice(0, -1).join("/"),
  }));

  it("trouve les routes cron", () => {
    expect(CRON_ROUTES.length).toBeGreaterThanOrEqual(2);
  });

  it.each(CRON_ROUTES.map((r) => [r.pattern, r.file] as const))(
    "%s refuse l'absence d'en-tête, un mauvais secret et une session admin",
    async (pattern, file) => {
      const mod = (await import(/* @vite-ignore */ file)) as {
        GET: (req: NextRequest) => Promise<Response>;
      };
      const url = `http://localhost:3000${pattern}`;

      const noHeader = await mod.GET(new NextRequest(url));
      expect(noHeader.status).toBe(401);

      const wrong = await mod.GET(
        new NextRequest(url, { headers: { authorization: "Bearer mauvais-secret" } }),
      );
      expect(wrong.status).toBe(401);

      const noBearer = await mod.GET(
        new NextRequest(url, { headers: { authorization: process.env.CRON_SECRET! } }),
      );
      expect(noBearer.status).toBe(401);

      // Être admin ne remplace pas le secret cron.
      await loginAs(fixtures.admin);
      const asAdmin = await mod.GET(new NextRequest(url));
      expect(asAdmin.status).toBe(401);
      await loginAs(null);
    },
  );

  it.each(CRON_ROUTES.map((r) => [r.pattern, r.file] as const))(
    "%s accepte le bon secret",
    async (pattern, file) => {
      const mod = (await import(/* @vite-ignore */ file)) as {
        GET: (req: NextRequest) => Promise<Response>;
      };
      const res = await mod.GET(
        new NextRequest(`http://localhost:3000${pattern}`, {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
        }),
      );
      expect(res.status).toBe(200);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
describe("proxy (garde de routage)", () => {
  function request(path: string, cookie?: string) {
    return new NextRequest(`http://localhost:3000${path}`, {
      headers: cookie ? { cookie } : {},
    });
  }

  it("redirige vers /login sans cookie de session", () => {
    const res = proxy(request("/clients"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("laisse passer les pages publiques et les routes API", () => {
    for (const path of ["/login", "/forgot-password", "/reset-password", "/api/clients/lookup"]) {
      const res = proxy(request(path));
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("laisse passer quand un cookie existe (la vraie vérification est côté serveur)", () => {
    const res = proxy(request("/clients", `${SESSION_COOKIE_NAME}=peu-importe`));
    expect(res.headers.get("location")).toBeNull();
  });

  it("un cookie bidon ne donne accès à rien : les gardes serveur refusent", async () => {
    ctx.cookies.clear();
    ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: "peu-importe" });
    await expect(requireUser()).rejects.toMatchObject({
      digest: expect.stringContaining("/login"),
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("routes admin — l'énumération couvre bien chaque fichier", () => {
  it("chaque fichier route.ts exporte au moins une méthode HTTP testée", async () => {
    for (const { file, pattern } of ADMIN_ROUTES) {
      const methods = await methodsOf(file);
      expect(methods.length, `${pattern} n'exporte aucune méthode HTTP`).toBeGreaterThan(0);
    }
  });

  it("aucune route réservée n'a été oubliée par rapport au disque", () => {
    const onDisk = [
      ...collectRouteFiles(ADMIN_API_DIR),
      ...collectRouteFiles(ASSISTANT_API_DIR),
      ...collectRouteFiles(CAMPAIGN_API_DIR),
    ].sort();
    expect(ADMIN_ROUTES.map((r) => r.file)).toEqual(onDisk);
  });
});
