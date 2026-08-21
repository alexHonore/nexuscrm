/**
 * Intégration — création et suppression de règles de garde-fou.
 *
 * Le point : l'administrateur doit pouvoir ÉCRIRE ses propres règles, pas
 * seulement basculer celles qu'on a semées. Et une règle écrite à la main ne
 * doit jamais disparaître parce que quelqu'un a cliqué « Tout réinitialiser ».
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { assistants, guardrailAudit, guardrailRules } from "@/db/schema-sms";

const ctx = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = ctx.cookies.get(name);
      return v ? { name, value: v } : undefined;
    },
    set: (name: string, value: string) => ctx.cookies.set(name, value),
    delete: (name: string) => ctx.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));

const collection = await import("@/app/api/admin/guardrails/rules/route");
const single = await import("@/app/api/admin/guardrails/rules/[id]/route");
const { seedGuardrailDefaults, resetGuardrailDefaults } = await import("@/lib/guardrails/store");

async function loginAsAdmin(user: { id: string; tokenVersion: number }) {
  const token = await new SignJWT({ uid: user.id, role: "admin", tv: user.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set("nexus_session", token);
}

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

const VALID = {
  key: "pas_de_dimanche",
  label: "Pas de rendez-vous le dimanche",
  kind: "forbidden_terms",
  config: { terms: ["dimanche"] },
  promptText: "Ne propose jamais le dimanche.",
  severity: "block",
};

beforeEach(async () => {
  await resetDb();
  ctx.cookies.clear();
  await loginAsAdmin(await makeUser({ role: "admin" }));
});

afterAll(async () => {
  await closeDb();
});

describe("création d'une règle", () => {
  it("un admin peut écrire sa propre règle", async () => {
    const res = await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    expect(res.status).toBe(201);

    const [row] = await testDb.select().from(guardrailRules);
    expect(row.key).toBe("pas_de_dimanche");
    expect(row.scope).toBe("core");
    // « custom » et non « default » : « Tout réinitialiser » ne doit pas
    // effacer le travail de quelqu'un.
    expect(row.origin).toBe("custom");
    expect(row.config).toEqual({ terms: ["dimanche"] });
  });

  it("une configuration invalide pour le type est REFUSÉE", async () => {
    const res = await collection.POST(
      req("/api/admin/guardrails/rules", "POST", { ...VALID, config: { max: 5 } }),
    );
    // Une règle cassée ne garde pas la sortie, elle la laisse passer : on
    // refuse plutôt que d'enregistrer.
    expect(res.status).toBe(422);
    expect(await testDb.select().from(guardrailRules)).toHaveLength(0);
  });

  it("une regex qui ne compile pas est refusée", async () => {
    const res = await collection.POST(
      req("/api/admin/guardrails/rules", "POST", {
        ...VALID,
        key: "regex_cassee",
        kind: "forbidden_regex",
        config: { patterns: ["(non fermé"], flags: "iu" },
      }),
    );
    expect(res.status).toBe(422);
  });

  it("deux règles ne peuvent pas partager une clé", async () => {
    await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    const res = await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    expect(res.status).toBe(409);
    expect(await testDb.select().from(guardrailRules)).toHaveLength(1);
  });

  it("une clé mal formée est refusée", async () => {
    const res = await collection.POST(
      req("/api/admin/guardrails/rules", "POST", { ...VALID, key: "Pas De Dimanche!" }),
    );
    // 422 : la convention du dépôt pour un corps qui ne passe pas le schéma.
    expect(res.status).toBe(422);
    expect(await testDb.select().from(guardrailRules)).toHaveLength(0);
  });

  it("la création est tracée dans l'audit des garde-fous", async () => {
    await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    const [audit] = await testDb.select().from(guardrailAudit);
    expect(audit.action).toBe("rule_created");
    expect(audit.target).toBe("rule:pas_de_dimanche");
  });
});

describe("modification et suppression", () => {
  it("la configuration d'une règle est modifiable", async () => {
    const created = await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    const { rule } = (await created.json()) as { rule: { id: string } };

    const res = await single.PATCH(
      req(`/api/admin/guardrails/rules/${rule.id}`, "PATCH", {
        config: { terms: ["dimanche", "samedi soir"] },
        severity: "warn",
      }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(guardrailRules);
    expect(row.config).toEqual({ terms: ["dimanche", "samedi soir"] });
    expect(row.severity).toBe("warn");
  });

  it("une configuration invalide ne remplace pas une valide", async () => {
    const created = await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    const { rule } = (await created.json()) as { rule: { id: string } };

    const res = await single.PATCH(
      req(`/api/admin/guardrails/rules/${rule.id}`, "PATCH", { config: { terms: [] } }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(res.status).toBe(422);

    const [row] = await testDb.select().from(guardrailRules);
    expect(row.config).toEqual({ terms: ["dimanche"] });
  });

  it("une règle se supprime", async () => {
    const created = await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    const { rule } = (await created.json()) as { rule: { id: string } };

    const res = await single.DELETE(req(`/api/admin/guardrails/rules/${rule.id}`, "DELETE"), {
      params: Promise.resolve({ id: rule.id }),
    });
    expect(res.status).toBe(200);
    expect(await testDb.select().from(guardrailRules)).toHaveLength(0);
  });

  it("« Tout réinitialiser » NE supprime PAS une règle écrite à la main", async () => {
    await seedGuardrailDefaults();
    await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));

    await resetGuardrailDefaults();

    const mine = await testDb
      .select()
      .from(guardrailRules)
      .where(eq(guardrailRules.key, "pas_de_dimanche"));
    // Perdre le travail de quelqu'un en cliquant « réinitialiser » serait la
    // pire surprise possible.
    expect(mine).toHaveLength(1);
    expect(mine[0].config).toEqual({ terms: ["dimanche"] });
  });
});

describe("une règle qui change PÉRIME les assistants", () => {
  // L6 du prompt compilé recopie le texte des règles et la suite les rejoue :
  // créer, modifier ou supprimer une règle du noyau laissait pourtant chaque
  // assistant « à jour » et « vert ». Un brouillon passait la porte avec le L6
  // d'hier ; un actif gardait l'ancien texte jusqu'à une recompilation fortuite.
  async function freshAssistant(name = "Acheteur") {
    const [a] = await testDb
      .insert(assistants)
      .values({
        name, identity: {}, goal: { primary: { type: "qualify_only" }, fallbacks: [] },
        approach: {}, model: {}, needsRecompile: false, suitePassed: true,
      })
      .returning();
    return a;
  }
  async function flags(id: string) {
    const row = await testDb.query.assistants.findFirst({ where: eq(assistants.id, id) });
    return { needsRecompile: row!.needsRecompile, suitePassed: row!.suitePassed };
  }

  it("créer une règle du noyau périme TOUS les assistants non archivés, et le dit", async () => {
    const a = await freshAssistant();
    const [archived] = await testDb
      .insert(assistants)
      .values({
        name: "Vieux", identity: {}, goal: { primary: { type: "qualify_only" }, fallbacks: [] },
        approach: {}, model: {}, status: "archived", needsRecompile: false, suitePassed: true,
      })
      .returning();

    const res = await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { staleAssistants: number };
    expect(body.staleAssistants).toBe(1);

    expect(await flags(a.id)).toEqual({ needsRecompile: true, suitePassed: false });
    // Un assistant archivé n'est plus concerné : il ne reparlera pas.
    expect(await flags(archived.id)).toEqual({ needsRecompile: false, suitePassed: true });
  });

  it("modifier, puis supprimer une règle périment de nouveau", async () => {
    const created = await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    const { rule } = (await created.json()) as { rule: { id: string } };
    const a = await freshAssistant();

    const patched = await single.PATCH(
      req(`/api/admin/guardrails/rules/${rule.id}`, "PATCH", { promptText: "Jamais le dimanche." }),
      { params: Promise.resolve({ id: rule.id }) },
    );
    expect(((await patched.json()) as { staleAssistants: number }).staleAssistants).toBe(1);
    expect(await flags(a.id)).toEqual({ needsRecompile: true, suitePassed: false });

    await testDb.update(assistants).set({ needsRecompile: false, suitePassed: true }).where(eq(assistants.id, a.id));
    const deleted = await single.DELETE(req(`/api/admin/guardrails/rules/${rule.id}`, "DELETE"), {
      params: Promise.resolve({ id: rule.id }),
    });
    expect(((await deleted.json()) as { staleAssistants: number }).staleAssistants).toBe(1);
    expect(await flags(a.id)).toEqual({ needsRecompile: true, suitePassed: false });
  });

  it("une règle propre à UN assistant ne périme que lui", async () => {
    const mine = await freshAssistant("Mien");
    const other = await freshAssistant("Autre");

    const res = await collection.POST(
      req("/api/admin/guardrails/rules", "POST", { ...VALID, assistantId: mine.id }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { staleAssistants: number }).staleAssistants).toBe(1);
    expect(await flags(mine.id)).toEqual({ needsRecompile: true, suitePassed: false });
    expect(await flags(other.id)).toEqual({ needsRecompile: false, suitePassed: true });
  });

  it("la péremption est consignée dans l'audit des garde-fous", async () => {
    await freshAssistant();
    await collection.POST(req("/api/admin/guardrails/rules", "POST", VALID));
    const rows = await testDb.select().from(guardrailAudit);
    const created = rows.find((r) => r.action === "rule_created");
    expect((created?.after as { staleAssistants?: number })?.staleAssistants).toBe(1);
  });
});
