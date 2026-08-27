/**
 * Intégration — les déclencheurs de campagne branchés sur les VRAIS chemins.
 *
 *  · Le déclencheur « changement de catégorie » doit partir de la disposition
 *    d'après-appel (PATCH /api/calls/:id) : dans ce CRM, les boutons
 *    d'après-appel SONT le pipeline. Il n'était branché que sur la liste
 *    déroulante de l'en-tête.
 *  · Activer une campagne (PATCH /api/campaigns/:id) refuse ce qui ne ferait
 *    rien : échelle vide, barreau « l'assistant rédige » sans assistant actif,
 *    aucun numéro expéditeur. Archiver clôt les inscriptions en vol.
 *
 * Vrais handlers de route + vrai garde RBAC (JWT signé dans le cookie).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  closeDb,
  makeCategory,
  makeClient,
  makeSmsNumber,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";
import { calls, clients } from "@/db/schema";
import {
  assistants,
  campaignEnrollments,
  campaigns,
  consents,
  promptCores,
  scheduledJobs,
  smsNumbers,
} from "@/db/schema-sms";
import { assistantConfigSchema } from "@/lib/assistants/schema";
import { campaignConfigSchema } from "@/lib/campaigns/schema";

const CTX = vi.hoisted(() => ({ jar: new Map<string, string>(), hdrs: new Headers() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (CTX.jar.has(n) ? { name: n, value: CTX.jar.get(n)! } : undefined),
    set: (n: string, v: string) => void CTX.jar.set(n, v),
    delete: (n: string) => void CTX.jar.delete(n),
  }),
  headers: async () => CTX.hdrs,
}));

const { PATCH: patchCall } = await import("@/app/api/calls/[id]/route");
const { PATCH: patchCampaign } = await import("@/app/api/campaigns/[id]/route");
const { flushAfterResponse } = await import("@/lib/after-response");
const { NextRequest } = await import("next/server");

async function login(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
}

function jsonReq(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function makeCampaign(overrides: Record<string, unknown> = {}, numberId: string | null = null) {
  const config = campaignConfigSchema.parse({
    name: "Chauds → SMS",
    trigger: { kind: "manual" },
    ladder: [{ delayHours: 0, body: "Bonjour, ici Groupe Nexus.", label: "ouverture" }],
    ...overrides,
  });
  const [row] = await testDb
    .insert(campaigns)
    .values({
      name: config.name,
      status: (overrides.status as "draft" | "active" | "paused" | "archived") ?? "active",
      assistantId: config.assistantId,
      smsNumberId: numberId,
      trigger: config.trigger,
      audience: config.audience,
      ladder: config.ladder,
      variants: config.variants,
      dailyEnrollmentCap: config.dailyEnrollmentCap,
    })
    .returning();
  return row;
}

async function makeReachableClient(overrides: Record<string, unknown> = {}) {
  const client = await makeClient(overrides);
  await testDb.insert(consents).values({
    clientId: client.id,
    channel: "sms",
    kind: "express",
    source: "test",
    grantedAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
  });
  return client;
}

/**
 * Un assistant « actif » doit passer la porte d'activation (trigger en base) :
 * compilé contre le noyau courant, suite verte. On pose le minimum qui la
 * satisfait — ce test porte sur la campagne, pas sur la compilation.
 */
async function makeAssistant(status: "draft" | "active" = "active") {
  const cfg = assistantConfigSchema.parse({
    name: "Vendeur FB",
    identity: {},
    approach: {},
    model: {},
    goal: { primary: { type: "qualify_only", requiredFields: [] } },
  });
  await testDb.insert(promptCores).values({ version: 1, body: "# RÔLE" }).onConflictDoNothing();
  const [row] = await testDb
    .insert(assistants)
    .values({
      name: cfg.name,
      status,
      identity: cfg.identity,
      goal: cfg.goal,
      approach: cfg.approach,
      knowledge: cfg.knowledge,
      model: cfg.model,
      tools: cfg.tools,
      ...(status === "active"
        ? {
            compiledPrompt: "# RÔLE\ncompilé",
            compiledCoreVersion: 1,
            compiledAt: new Date(),
            needsRecompile: false,
            suitePassed: true,
          }
        : {}),
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await resetDb();
  CTX.jar.clear();
});

afterAll(async () => {
  await closeDb();
});

describe("déclencheur « changement de catégorie » depuis la disposition d'après-appel", () => {
  it("classer un appel « à rappeler » inscrit la fiche dans la campagne qui vise cette catégorie", async () => {
    const cats = await seedSystemCategories();
    const number = await makeSmsNumber();
    const campaign = await makeCampaign(
      { trigger: { kind: "category_changed", toCategoryIds: [cats.callback.id] } },
      number.id,
    );
    const caller = await makeUser({ role: "caller" });
    await login(caller);
    const client = await makeReachableClient({ categoryId: cats.new.id });
    const [call] = await testDb
      .insert(calls)
      .values({
        userId: caller.id,
        clientId: client.id,
        direction: "outbound",
        toNumber: client.phone,
        startedAt: new Date(),
      })
      .returning();

    const res = await patchCall(
      jsonReq(`http://localhost/api/calls/${call.id}`, { disposition: "callback" }),
      ctx(call.id),
    );
    expect(res.status).toBe(200);
    // Le travail part APRÈS la réponse : le téléphoniste n'attend pas le moteur.
    await flushAfterResponse();

    const rows = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.campaignId, campaign.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].clientId).toBe(client.id);
    const jobs = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "campaign_touch"));
    expect(jobs).toHaveLength(1);

    // Rejouer la MÊME disposition (réponse perdue, nouvel essai) n'inscrit pas deux fois.
    const replay = await patchCall(
      jsonReq(`http://localhost/api/calls/${call.id}`, { disposition: "callback" }),
      ctx(call.id),
    );
    expect(replay.status).toBe(200);
    await flushAfterResponse();
    expect(await testDb.select().from(campaignEnrollments)).toHaveLength(1);
  });

  it("une disposition vers une AUTRE catégorie ne déclenche rien", async () => {
    const cats = await seedSystemCategories();
    const number = await makeSmsNumber();
    await makeCampaign(
      { trigger: { kind: "category_changed", toCategoryIds: [cats.callback.id] } },
      number.id,
    );
    const caller = await makeUser({ role: "caller" });
    await login(caller);
    const client = await makeReachableClient({ categoryId: cats.new.id });
    const [call] = await testDb
      .insert(calls)
      .values({ userId: caller.id, clientId: client.id, direction: "outbound", startedAt: new Date() })
      .returning();

    const res = await patchCall(
      jsonReq(`http://localhost/api/calls/${call.id}`, { disposition: "not_interested" }),
      ctx(call.id),
    );
    expect(res.status).toBe(200);
    await flushAfterResponse();
    expect(await testDb.select().from(campaignEnrollments)).toHaveLength(0);
    const after = await testDb.query.clients.findFirst({ where: eq(clients.id, client.id) });
    expect(after!.categoryId).toBe(cats.not_interested.id);
  });
});

describe("changer de catégorie RAFRAÎCHIT la campagne de la fiche", () => {
  /** Déplace la fiche par le chemin réel de l'en-tête (server action admin). */
  async function moveCategory(clientId: string, categoryId: number | null) {
    const { setClientCategoryAction } = await import("@/app/(app)/clients/actions");
    const res = await setClientCategoryAction(clientId, categoryId);
    expect(res).toEqual({ ok: true, id: clientId });
    await flushAfterResponse();
  }

  it("la fiche qui quitte la catégorie visée est retirée de la campagne", async () => {
    const cats = await seedSystemCategories();
    const number = await makeSmsNumber();
    const campaign = await makeCampaign(
      { audience: { categoryIds: [cats.callback.id] }, trigger: { kind: "manual" } },
      number.id,
    );
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const client = await makeReachableClient({ categoryId: cats.callback.id });

    // Inscrite à la main, comme le ferait « Inscrire l'audience ».
    const { enrollClients } = await import("@/lib/campaigns-server/enroll");
    const [enrolled] = await enrollClients(campaign.id, [client.id]);
    expect(enrolled.enrolled).toBe(true);

    await moveCategory(client.id, cats.not_interested.id);

    const [row] = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.campaignId, campaign.id));
    expect(row.status).toBe("excluded");
    expect(row.endReason).toBe("left_audience");
    expect(row.nextTouchAt).toBeNull();
    expect(row.endedAt).not.toBeNull();

    // Le barreau déjà en file ne doit pas partir après le retrait.
    const jobs = await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.type, "campaign_touch"));
    expect(jobs.every((j) => j.status === "cancelled")).toBe(true);
  });

  it("LE BOGUE : l'ancienne campagne libère la place pour celle de la nouvelle catégorie", async () => {
    // Symptôme signalé par l'exploitant : la fiche restait accrochée à
    // l'ancienne campagne ET n'entrait jamais dans la nouvelle. La deuxième
    // moitié est causée par la première — `excludeActiveInOtherCampaign` vaut
    // `true` par défaut, donc l'inscription périmée refusait la suivante.
    const cats = await seedSystemCategories();
    const number = await makeSmsNumber();
    const ancienne = await makeCampaign(
      { name: "À rappeler", audience: { categoryIds: [cats.callback.id] }, trigger: { kind: "manual" } },
      number.id,
    );
    const nouvelle = await makeCampaign(
      {
        name: "Rendez-vous",
        trigger: { kind: "category_changed", toCategoryIds: [cats.booked.id] },
      },
      number.id,
    );
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const client = await makeReachableClient({ categoryId: cats.callback.id });

    const { enrollClients } = await import("@/lib/campaigns-server/enroll");
    await enrollClients(ancienne.id, [client.id]);

    await moveCategory(client.id, cats.booked.id);

    const rows = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.clientId, client.id));
    const byCampaign = new Map(rows.map((r) => [r.campaignId, r]));
    expect(byCampaign.get(ancienne.id)!.status).toBe("excluded");
    expect(byCampaign.get(ancienne.id)!.endReason).toBe("left_audience");
    // Et la fiche est bien entrée dans la campagne de sa NOUVELLE catégorie.
    expect(byCampaign.get(nouvelle.id)).toBeDefined();
    expect(["pending", "active"]).toContain(byCampaign.get(nouvelle.id)!.status);
  });

  it("une campagne sans restriction de catégorie garde sa fiche", async () => {
    // Le faux positif à ne pas commettre : « toutes les catégories » veut dire
    // que la campagne suit la personne, quoi qu'il arrive à son classement.
    const cats = await seedSystemCategories();
    const number = await makeSmsNumber();
    const campaign = await makeCampaign({ trigger: { kind: "manual" } }, number.id);
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const client = await makeReachableClient({ categoryId: cats.callback.id });

    const { enrollClients } = await import("@/lib/campaigns-server/enroll");
    await enrollClients(campaign.id, [client.id]);

    await moveCategory(client.id, cats.not_interested.id);

    const [row] = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.campaignId, campaign.id));
    expect(row.status).toBe("pending");
    expect(row.endReason).toBeNull();
  });

  it("retirer complètement la catégorie retire aussi de la campagne", async () => {
    // `to === null` était jeté avant d'atteindre le moteur : le seul geste qui
    // sort une fiche de TOUTES les catégories ne libérait rien.
    const cats = await seedSystemCategories();
    const number = await makeSmsNumber();
    const campaign = await makeCampaign(
      { audience: { categoryIds: [cats.callback.id] }, trigger: { kind: "manual" } },
      number.id,
    );
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const client = await makeReachableClient({ categoryId: cats.callback.id });

    const { enrollClients } = await import("@/lib/campaigns-server/enroll");
    await enrollClients(campaign.id, [client.id]);

    await moveCategory(client.id, null);

    const [row] = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.campaignId, campaign.id));
    expect(row.status).toBe("excluded");
    expect(row.endReason).toBe("left_audience");
  });

  it("le transfert en masse d'une catégorie rafraîchit aussi les campagnes", async () => {
    // Réorganiser le pipeline déplace des fiches sans passer par l'en-tête :
    // ce chemin n'avertissait personne.
    const cats = await seedSystemCategories();
    const number = await makeSmsNumber();
    const campaign = await makeCampaign(
      { audience: { categoryIds: [cats.callback.id] }, trigger: { kind: "manual" } },
      number.id,
    );
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const client = await makeReachableClient({ categoryId: cats.callback.id });

    const { enrollClients } = await import("@/lib/campaigns-server/enroll");
    await enrollClients(campaign.id, [client.id]);

    const { POST: transferCategory } = await import(
      "@/app/api/admin/categories/[id]/transfer/route"
    );
    const res = await transferCategory(
      new NextRequest(`http://localhost/api/admin/categories/${cats.callback.id}/transfer`, {
        method: "POST",
        body: JSON.stringify({ targetId: cats.not_interested.id }),
        headers: { "content-type": "application/json" },
      }),
      ctx(String(cats.callback.id)),
    );
    expect(res.status).toBe(200);
    await flushAfterResponse();

    const [row] = await testDb
      .select()
      .from(campaignEnrollments)
      .where(eq(campaignEnrollments.campaignId, campaign.id));
    expect(row.status).toBe("excluded");
    expect(row.endReason).toBe("left_audience");
  });
});

describe("PATCH /api/campaigns/:id — ce qu'il faut pour qu'une campagne active serve", () => {
  it("un barreau « l'assistant rédige » exige un assistant ACTIF", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    await makeSmsNumber();
    const campaign = await makeCampaign({
      status: "draft",
      ladder: [{ delayHours: 0, body: null, label: "l'assistant rédige" }],
    });

    // Sans assistant : refusé.
    let res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { status: "active" }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "assistant_inactive" });

    // Assistant en brouillon : refusé aussi — le tour se terminerait
    // « pas d'assistant » à chaque barreau, l'échelle avancerait, rien ne partirait.
    const draft = await makeAssistant("draft");
    await testDb.update(campaigns).set({ assistantId: draft.id }).where(eq(campaigns.id, campaign.id));
    res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { status: "active" }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "assistant_inactive" });

    // Assistant actif, envoyé DANS la même requête : accepté.
    const active = await makeAssistant("active");
    const row = await testDb.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    const config = campaignConfigSchema.parse({
      name: row!.name,
      trigger: row!.trigger,
      ladder: row!.ladder,
      assistantId: active.id,
    });
    res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { config, status: "active" }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(200);
    const saved = await testDb.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(saved!.status).toBe("active");
    expect(saved!.assistantId).toBe(active.id);
  });

  it("un assistant inconnu est refusé proprement, pas par une erreur de clé étrangère", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const campaign = await makeCampaign({ status: "draft" });
    const config = campaignConfigSchema.parse({
      name: "X",
      trigger: { kind: "manual" },
      ladder: [{ delayHours: 0, body: "Bonjour", label: "" }],
      assistantId: "11111111-1111-4111-8111-111111111111",
    });
    const res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { config }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "assistant_not_found" });
  });

  it("sans numéro expéditeur actif, activer est refusé", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const campaign = await makeCampaign({ status: "draft" });

    // Aucun numéro du tout.
    let res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { status: "active" }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_sender" });

    // Un numéro épinglé mais désactivé ne vaut pas mieux.
    const number = await makeSmsNumber({ active: false });
    await testDb.update(campaigns).set({ smsNumberId: number.id }).where(eq(campaigns.id, campaign.id));
    res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { status: "active" }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_sender" });

    await testDb.update(smsNumbers).set({ active: true }).where(eq(smsNumbers.id, number.id));
    res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { status: "active" }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(200);
  });

  it("archiver clôt les inscriptions en vol", async () => {
    const admin = await makeUser({ role: "admin" });
    await login(admin);
    const number = await makeSmsNumber();
    const campaign = await makeCampaign({}, number.id);
    const client = await makeReachableClient();
    await testDb.insert(campaignEnrollments).values({
      campaignId: campaign.id,
      clientId: client.id,
      status: "active",
      step: 1,
      nextTouchAt: new Date("2026-08-30T15:00:00Z"),
    });

    const res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { status: "archived" }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(campaignEnrollments);
    expect(row.status).toBe("completed");
    expect(row.endReason).toBe("campaign_archived");
    expect(row.nextTouchAt).toBeNull();
  });

  it("un téléphoniste ne peut ni activer ni archiver une campagne", async () => {
    const caller = await makeUser({ role: "caller" });
    await login(caller);
    const campaign = await makeCampaign({ status: "draft" });
    const res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${campaign.id}`, { status: "active" }),
      ctx(campaign.id),
    );
    expect(res.status).toBe(403);
  });
});

void makeCategory;
