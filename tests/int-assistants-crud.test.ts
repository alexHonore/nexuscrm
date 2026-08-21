/**
 * Intégration — création, sauvegarde et retrait d'un assistant.
 *
 * Deux garanties, toutes deux invisibles depuis l'écran :
 *  · Sauvegarder repose `needs_recompile` ET invalide la suite — sans quoi on
 *    active un prompt périmé sur la foi d'un test qui ne correspond plus.
 *  · Un assistant qui a parlé n'est jamais supprimé. Ses clés étrangères sont
 *    en « set null » : la suppression n'échouerait pas, elle effacerait
 *    silencieusement l'auteur de chaque message.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  makeUser,
  resetDb,
  testDb,
} from "./helpers/db";
import { assistants, messages } from "@/db/schema-sms";
import { assistantConfigSchema } from "@/lib/assistants/schema";

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

const collection = await import("@/app/api/assistants/route");
const single = await import("@/app/api/assistants/[id]/route");

async function loginAsAdmin(user: { id: string; tokenVersion: number }) {
  const token = await new SignJWT({
    uid: user.id,
    role: "admin",
    tv: user.tokenVersion,
    remember: false,
  })
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

function baseConfig(overrides: Record<string, unknown> = {}) {
  return assistantConfigSchema.parse({
    name: "Acheteur FB",
    identity: {},
    goal: { primary: { type: "video_meeting", durationMin: 30 }, fallbacks: [] },
    approach: {},
    model: {},
    ...overrides,
  });
}

async function createAssistant(overrides: Record<string, unknown> = {}) {
  const res = await collection.POST(req("/api/assistants", "POST", baseConfig(overrides)));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

beforeEach(async () => {
  await resetDb();
  ctx.cookies.clear();
  await loginAsAdmin(await makeUser({ role: "admin" }));
});

afterAll(async () => {
  await closeDb();
});

describe("création", () => {
  it("un assistant naît TOUJOURS brouillon et à recompiler", async () => {
    const { id } = await createAssistant();
    const row = await testDb.query.assistants.findFirst({ where: eq(assistants.id, id) });
    expect(row!.status).toBe("draft");
    expect(row!.needsRecompile).toBe(true);
    expect(row!.suitePassed).toBe(false);
    expect(row!.compiledPrompt).toBeNull();
  });

  it("une configuration invalide est refusée avec le détail", async () => {
    const res = await collection.POST(
      req("/api/assistants", "POST", { name: "", identity: {}, goal: {}, approach: {}, model: {} }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("invalid_body");
    expect(body.issues.length).toBeGreaterThan(0);
  });
});

describe("sauvegarde", () => {
  it("un réglage de ton repose le drapeau de recompilation et invalide la suite", async () => {
    const { id } = await createAssistant();
    await testDb
      .update(assistants)
      .set({ needsRecompile: false, suitePassed: true, compiledPrompt: "…" })
      .where(eq(assistants.id, id));

    const config = baseConfig();
    config.approach.warmth = 5;
    const res = await single.PATCH(req(`/api/assistants/${id}`, "PATCH", config), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: boolean; changes: { pending: string[] } };
    expect(body.saved).toBe(true);
    expect(body.changes.pending).toContain("approach.warmth");

    const row = await testDb.query.assistants.findFirst({ where: eq(assistants.id, id) });
    expect(row!.needsRecompile).toBe(true);
    // Le vert d'hier a été obtenu contre l'ancienne configuration.
    expect(row!.suitePassed).toBe(false);
  });

  it("un réglage relu à l'exécution ne force PAS de recompilation", async () => {
    const { id } = await createAssistant();
    await testDb
      .update(assistants)
      .set({ needsRecompile: false, suitePassed: true, compiledPrompt: "…" })
      .where(eq(assistants.id, id));

    const config = baseConfig();
    config.model.temperature = 0.2;
    const res = await single.PATCH(req(`/api/assistants/${id}`, "PATCH", config), {
      params: Promise.resolve({ id }),
    });
    const body = (await res.json()) as { changes: { immediate: string[] } };
    expect(body.changes.immediate).toContain("model.temperature");

    const row = await testDb.query.assistants.findFirst({ where: eq(assistants.id, id) });
    expect(row!.needsRecompile).toBe(false);
    expect(row!.suitePassed).toBe(true);
  });

  it("une sauvegarde sans changement n'écrit rien", async () => {
    const { id } = await createAssistant();
    await testDb.update(assistants).set({ suitePassed: true }).where(eq(assistants.id, id));

    const res = await single.PATCH(req(`/api/assistants/${id}`, "PATCH", baseConfig()), {
      params: Promise.resolve({ id }),
    });
    const body = (await res.json()) as { saved: boolean };
    expect(body.saved).toBe(false);

    const row = await testDb.query.assistants.findFirst({ where: eq(assistants.id, id) });
    expect(row!.suitePassed).toBe(true);
  });

  it("la réponse classe la modification comme immédiate ou en attente", async () => {
    // Volontairement PAS d'assistant activé ici : activer exige un prompt
    // compilé et une suite verte, et désactiver la gâchette de la base pour
    // contourner ça la laisserait désactivée pour toutes les autres suites.
    // `liveNow` sur un assistant actif est couvert par le test de la porte.
    const { id } = await createAssistant();

    const config = baseConfig();
    config.approach.maxTurns = 30;
    const res = await single.PATCH(req(`/api/assistants/${id}`, "PATCH", config), {
      params: Promise.resolve({ id }),
    });
    const body = (await res.json()) as { changes: { immediate: string[] }; liveNow: boolean };
    // Brouillon : rien n'est « en direct », mais la modification est bien
    // classée comme immédiate.
    expect(body.changes.immediate).toContain("approach.maxTurns");
    expect(body.liveNow).toBe(false);
  });

  it("un identifiant qui n'existe pas donne 404, pas 500", async () => {
    const res = await single.PATCH(
      req("/api/assistants/00000000-0000-4000-8000-000000000000", "PATCH", baseConfig()),
      { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("retrait", () => {
  it("un brouillon jamais utilisé est supprimé", async () => {
    const { id } = await createAssistant();
    const res = await single.DELETE(req(`/api/assistants/${id}`, "DELETE"), {
      params: Promise.resolve({ id }),
    });
    const body = (await res.json()) as { deleted: boolean; archived: boolean };
    expect(body).toEqual({ deleted: true, archived: false });
    expect(await testDb.select().from(assistants)).toHaveLength(0);
  });

  it("un assistant qui a ÉCRIT est archivé, jamais supprimé", async () => {
    const { id } = await createAssistant();
    const number = await makeSmsNumber();
    const client = await makeClient();
    const conversation = await makeConversation({
      clientId: client.id,
      smsNumberId: number.id,
      // Transféré depuis : `active_assistant_id` pointe ailleurs, seul le
      // message garde le souvenir de qui a parlé.
      activeAssistantId: null,
    });
    await testDb.insert(messages).values({
      conversationId: conversation.id,
      direction: "out",
      body: "Bonjour",
      source: "agent",
      assistantId: id,
    });

    const res = await single.DELETE(req(`/api/assistants/${id}`, "DELETE"), {
      params: Promise.resolve({ id }),
    });
    expect(await res.json()).toEqual({ deleted: false, archived: true });

    const row = await testDb.query.assistants.findFirst({ where: eq(assistants.id, id) });
    expect(row!.status).toBe("archived");
    // Et l'auteur du message est intact.
    const [msg] = await testDb.select().from(messages);
    expect(msg.assistantId).toBe(id);
  });

  it("un assistant rattaché à une conversation en cours est archivé", async () => {
    const { id } = await createAssistant();
    const number = await makeSmsNumber();
    const client = await makeClient();
    await makeConversation({
      clientId: client.id,
      smsNumberId: number.id,
      activeAssistantId: id,
    });

    const res = await single.DELETE(req(`/api/assistants/${id}`, "DELETE"), {
      params: Promise.resolve({ id }),
    });
    expect(await res.json()).toEqual({ deleted: false, archived: true });
  });
});

describe("liste", () => {
  it("renvoie l'état de compilation de chaque assistant", async () => {
    await createAssistant();
    await createAssistant({ name: "Vendeur" });

    const res = await collection.GET();
    const body = (await res.json()) as {
      assistants: { name: string; status: string; needsRecompile: boolean }[];
    };
    expect(body.assistants).toHaveLength(2);
    expect(body.assistants.every((a) => a.status === "draft")).toBe(true);
    expect(body.assistants.every((a) => a.needsRecompile)).toBe(true);
  });
});
