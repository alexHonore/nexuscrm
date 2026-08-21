/**
 * Intégration — noyau L0 versionné et CRUD des fixtures.
 *
 * La garantie centrale : publier un noyau crée une NOUVELLE version et périme
 * tous les assistants. Réécrire une version existante ferait mentir tout
 * l'historique — les traces et les instantanés d'assistant référencent un
 * numéro de version.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { assistants, guardrailAudit, guardrailFixtures, promptCores } from "@/db/schema-sms";

const ctx = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = ctx.cookies.get(name);
      return v ? { name, value: v } : undefined;
    },
    set: (n: string, v: string) => ctx.cookies.set(n, v),
    delete: (n: string) => ctx.cookies.delete(n),
  }),
  headers: async () => new Headers(),
}));

const core = await import("@/app/api/admin/guardrails/core/route");
const fixtureCollection = await import("@/app/api/admin/guardrails/fixtures/route");
const fixtureSingle = await import("@/app/api/admin/guardrails/fixtures/[id]/route");
const { seedGuardrailDefaults } = await import("@/lib/guardrails/store");

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

const LONG = "A".repeat(80);

beforeEach(async () => {
  await resetDb();
  ctx.cookies.clear();
  const admin = await makeUser({ role: "admin" });
  const token = await new SignJWT({ uid: admin.id, role: "admin", tv: admin.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set("nexus_session", token);
});

afterAll(async () => {
  await closeDb();
});

describe("noyau L0", () => {
  it("publier crée une NOUVELLE version, sans toucher l'ancienne", async () => {
    await seedGuardrailDefaults();
    const [before] = await testDb
      .select()
      .from(promptCores)
      .orderBy(desc(promptCores.version))
      .limit(1);

    const res = await core.POST(
      req("/api/admin/guardrails/core", "POST", { body: `${LONG} nouvelle règle`, notes: "v2" }),
    );
    expect(res.status).toBe(201);

    const all = await testDb.select().from(promptCores).orderBy(promptCores.version);
    expect(all).toHaveLength(2);
    // L'ancienne version est INTACTE : les traces la référencent.
    expect(all[0].body).toBe(before.body);
    expect(all[1].version).toBe(before.version + 1);
    expect(all[1].notes).toBe("v2");
  });

  it("publier périme TOUS les assistants non archivés", async () => {
    await seedGuardrailDefaults();
    const [a] = await testDb
      .insert(assistants)
      .values({
        name: "Acheteur", identity: {}, goal: { primary: { type: "qualify_only" }, fallbacks: [] },
        approach: {}, model: {}, needsRecompile: false, suitePassed: true,
      })
      .returning();

    await core.POST(req("/api/admin/guardrails/core", "POST", { body: `${LONG} v2`, notes: null }));

    const after = await testDb.query.assistants.findFirst({ where: eq(assistants.id, a.id) });
    // La porte d'activation exige déjà le noyau le plus récent ; on le DIT au
    // lieu de laisser la découverte à l'activation suivante.
    expect(after!.needsRecompile).toBe(true);
    expect(after!.suitePassed).toBe(false);
  });

  it("republier un texte IDENTIQUE est refusé", async () => {
    await seedGuardrailDefaults();
    const [current] = await testDb
      .select()
      .from(promptCores)
      .orderBy(desc(promptCores.version))
      .limit(1);

    const res = await core.POST(
      req("/api/admin/guardrails/core", "POST", { body: current.body, notes: null }),
    );
    // Cela périmerait tous les assistants sans rien changer à ce qu'ils disent.
    expect(res.status).toBe(409);
    expect(await testDb.select().from(promptCores)).toHaveLength(1);
  });

  it("un corps trop court est refusé", async () => {
    const res = await core.POST(req("/api/admin/guardrails/core", "POST", { body: "court" }));
    expect(res.status).toBe(422);
  });

  it("la publication est tracée", async () => {
    await seedGuardrailDefaults();
    await core.POST(req("/api/admin/guardrails/core", "POST", { body: `${LONG} v2` }));
    const rows = await testDb.select().from(guardrailAudit);
    expect(rows.some((r) => r.action === "core_published")).toBe(true);
  });
});

describe("fixtures", () => {
  const VALID = {
    label: "Refuse le dimanche",
    inbound: "on peut se voir dimanche?",
    setup: { priorTurns: [["out", "Bonjour, ici Groupe Nexus."]], qualification: {}, rung: "primary", turnsUsed: 1 },
    expectations: {
      mustCallTool: [], mustNotCallTool: ["book_meeting"],
      mustMatch: [], mustNotMatch: ["dimanche"], judge: null, maxChars: null,
    },
    severity: "block",
  };

  it("un admin peut écrire sa propre fixture", async () => {
    const res = await fixtureCollection.POST(
      req("/api/admin/guardrails/fixtures", "POST", VALID),
    );
    expect(res.status).toBe(201);

    const [row] = await testDb.select().from(guardrailFixtures);
    expect(row.label).toBe("Refuse le dimanche");
    expect(row.scope).toBe("core");
    // « custom » : « Tout réinitialiser » ne doit pas emporter le travail écrit
    // à la main.
    expect(row.origin).toBe("custom");
  });

  it("une attente invalide est refusée", async () => {
    const res = await fixtureCollection.POST(
      req("/api/admin/guardrails/fixtures", "POST", {
        ...VALID,
        // Une regex qui ne compile pas rendrait la fixture inévaluable.
        expectations: { ...VALID.expectations, mustMatch: ["(non fermé"] },
      }),
    );
    expect(res.status).toBe(422);
    expect(await testDb.select().from(guardrailFixtures)).toHaveLength(0);
  });

  it("une fixture se modifie et se supprime", async () => {
    const created = await fixtureCollection.POST(
      req("/api/admin/guardrails/fixtures", "POST", VALID),
    );
    const { fixture } = (await created.json()) as { fixture: { id: string } };

    const patched = await fixtureSingle.PATCH(
      req(`/api/admin/guardrails/fixtures/${fixture.id}`, "PATCH", { severity: "warn" }),
      { params: Promise.resolve({ id: fixture.id }) },
    );
    expect(patched.status).toBe(200);
    expect((await testDb.select().from(guardrailFixtures))[0].severity).toBe("warn");

    const deleted = await fixtureSingle.DELETE(
      req(`/api/admin/guardrails/fixtures/${fixture.id}`, "DELETE"),
      { params: Promise.resolve({ id: fixture.id }) },
    );
    expect(deleted.status).toBe(200);
    expect(await testDb.select().from(guardrailFixtures)).toHaveLength(0);
  });

  it("la suppression est tracée", async () => {
    const created = await fixtureCollection.POST(
      req("/api/admin/guardrails/fixtures", "POST", VALID),
    );
    const { fixture } = (await created.json()) as { fixture: { id: string } };
    await fixtureSingle.DELETE(req(`/api/admin/guardrails/fixtures/${fixture.id}`, "DELETE"), {
      params: Promise.resolve({ id: fixture.id }),
    });
    const rows = await testDb.select().from(guardrailAudit);
    expect(rows.some((r) => r.action === "fixture_deleted")).toBe(true);
  });

  it("créer, modifier et supprimer une fixture PÉRIMENT les assistants, et la réponse le dit", async () => {
    // Le vert de chaque assistant a été jugé sans ce scénario (ou avec son
    // ancienne version) : il ne vaut plus. Comme pour le noyau et les règles,
    // on pose les drapeaux au lieu de laisser la porte le découvrir.
    const [a] = await testDb
      .insert(assistants)
      .values({
        name: "Acheteur", identity: {}, goal: { primary: { type: "qualify_only" }, fallbacks: [] },
        approach: {}, model: {}, needsRecompile: false, suitePassed: true,
      })
      .returning();
    const flags = async () => {
      const row = await testDb.query.assistants.findFirst({ where: eq(assistants.id, a.id) });
      return { needsRecompile: row!.needsRecompile, suitePassed: row!.suitePassed };
    };
    const reset = () =>
      testDb.update(assistants).set({ needsRecompile: false, suitePassed: true }).where(eq(assistants.id, a.id));

    const created = await fixtureCollection.POST(req("/api/admin/guardrails/fixtures", "POST", VALID));
    const { fixture, staleAssistants } = (await created.json()) as { fixture: { id: string }; staleAssistants: number };
    expect(staleAssistants).toBe(1);
    expect(await flags()).toEqual({ needsRecompile: true, suitePassed: false });

    await reset();
    const patched = await fixtureSingle.PATCH(
      req(`/api/admin/guardrails/fixtures/${fixture.id}`, "PATCH", { severity: "warn" }),
      { params: Promise.resolve({ id: fixture.id }) },
    );
    expect(((await patched.json()) as { staleAssistants: number }).staleAssistants).toBe(1);
    expect(await flags()).toEqual({ needsRecompile: true, suitePassed: false });

    await reset();
    const deleted = await fixtureSingle.DELETE(req(`/api/admin/guardrails/fixtures/${fixture.id}`, "DELETE"), {
      params: Promise.resolve({ id: fixture.id }),
    });
    expect(((await deleted.json()) as { staleAssistants: number }).staleAssistants).toBe(1);
    expect(await flags()).toEqual({ needsRecompile: true, suitePassed: false });
  });
});
