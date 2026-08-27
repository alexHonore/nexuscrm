/**
 * Intégration — GET /api/clients/list : le filtre `excludeCampaignId` écarte
 * les fiches DÉJÀ inscrites à la campagne (n'importe quel statut — l'index
 * unique (campagne, client) rend toute ré-inscription impossible). C'est le
 * filtre du dialogue « Ajouter des clients » : sans lui, « Tout
 * sélectionner » cochait des fiches vouées à « ignoré ».
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";
import { campaignEnrollments, campaigns } from "@/db/schema-sms";

const CTX = vi.hoisted(() => ({ jar: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (CTX.jar.has(n) ? { name: n, value: CTX.jar.get(n)! } : undefined),
    set: (n: string, v: string) => void CTX.jar.set(n, v),
    delete: (n: string) => void CTX.jar.delete(n),
  }),
  headers: async () => new Headers(),
}));

const { GET: listGET } = await import("@/app/api/clients/list/route");
const { NextRequest } = await import("next/server");

async function login() {
  const user = await makeUser({ role: "caller" });
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
}

async function list(params: Record<string, string>) {
  const url = new URL("http://localhost/api/clients/list");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await listGET(new NextRequest(url));
  expect(res.status).toBe(200);
  return (await res.json()) as { items: { id: string }[]; total: number };
}

async function makeCampaign() {
  const [row] = await testDb
    .insert(campaigns)
    .values({
      name: "Relance test",
      status: "active",
      trigger: { kind: "manual" },
      audience: {},
      ladder: [{ delayHours: 0, body: "Bonjour", stopOnReply: true }],
      variants: [],
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await resetDb();
  CTX.jar.clear();
  await login();
});

afterAll(async () => {
  await closeDb();
});

describe("GET /api/clients/list — excludeCampaignId", () => {
  it("écarte les fiches inscrites (tout statut), garde les autres, et le total suit", async () => {
    const campaign = await makeCampaign();
    const enrolled = await makeClient({ fullName: "Alice Inscrite" });
    const stopped = await makeClient({ fullName: "Benoit Arrêté" });
    const free = await makeClient({ fullName: "Chantal Libre" });
    await testDb.insert(campaignEnrollments).values([
      { campaignId: campaign.id, clientId: enrolled.id, status: "active" },
      { campaignId: campaign.id, clientId: stopped.id, status: "stopped" },
    ]);

    const all = await list({ filter: "never" });
    expect(all.total).toBe(3);

    const filtered = await list({ filter: "never", excludeCampaignId: campaign.id });
    expect(filtered.total).toBe(1);
    expect(filtered.items.map((i) => i.id)).toEqual([free.id]);
  });

  it("l'inscription à une AUTRE campagne n'écarte rien ; paramètre invalide ignoré", async () => {
    const campaign = await makeCampaign();
    const other = await makeCampaign();
    const client = await makeClient();
    await testDb
      .insert(campaignEnrollments)
      .values({ campaignId: other.id, clientId: client.id, status: "active" });

    const filtered = await list({ filter: "never", excludeCampaignId: campaign.id });
    expect(filtered.total).toBe(1);

    const junk = await list({ filter: "never", excludeCampaignId: "pas-un-uuid" });
    expect(junk.total).toBe(1);
  });
});

describe("GET /api/clients/list — campaignId", () => {
  it("§ montre les fiches d'une campagne, tout statut d'inscription confondu", async () => {
    // La question posée est l'APPARTENANCE, pas l'activité : une inscription
    // terminée ou arrêtée a bel et bien fait partie de la campagne.
    const campaign = await makeCampaign();
    const other = await makeCampaign();
    const active = await makeClient({ fullName: "Alice Active" });
    const done = await makeClient({ fullName: "Bruno Terminé" });
    const elsewhere = await makeClient({ fullName: "Carole Ailleurs" });
    await makeClient({ fullName: "David Sans Campagne" });

    await testDb.insert(campaignEnrollments).values([
      { campaignId: campaign.id, clientId: active.id, status: "active" },
      { campaignId: campaign.id, clientId: done.id, status: "completed" },
      { campaignId: other.id, clientId: elsewhere.id, status: "active" },
    ]);

    const res = await list({ campaignId: campaign.id });
    expect(res.total).toBe(2);
    expect(res.items.map((i) => i.id).sort()).toEqual([active.id, done.id].sort());
  });

  it("§ « aucune campagne » ne rend QUE les fiches jamais inscrites", async () => {
    const campaign = await makeCampaign();
    const enrolled = await makeClient({ fullName: "Alice Inscrite" });
    const never = await makeClient({ fullName: "David Sans Campagne" });
    await testDb
      .insert(campaignEnrollments)
      .values({ campaignId: campaign.id, clientId: enrolled.id, status: "excluded" });

    const res = await list({ campaignId: "none" });
    expect(res.items.map((i) => i.id)).toEqual([never.id]);
  });

  it("plusieurs campagnes se cumulent, et « aucune » se cumule avec elles", async () => {
    const a = await makeCampaign();
    const b = await makeCampaign();
    const inA = await makeClient({ fullName: "Alice A" });
    const inB = await makeClient({ fullName: "Bruno B" });
    const none = await makeClient({ fullName: "Carole Sans" });
    await testDb.insert(campaignEnrollments).values([
      { campaignId: a.id, clientId: inA.id, status: "active" },
      { campaignId: b.id, clientId: inB.id, status: "active" },
    ]);

    expect((await list({ campaignId: `${a.id},${b.id}` })).total).toBe(2);
    // Une fiche dans A ET « sans campagne » : l'union, pas l'intersection.
    const union = await list({ campaignId: `${a.id},none` });
    expect(union.items.map((i) => i.id).sort()).toEqual([inA.id, none.id].sort());
  });

  it("un identifiant qui n'est pas un uuid ne filtre rien plutôt que de tout vider", async () => {
    await makeClient({ fullName: "Alice" });
    expect((await list({ campaignId: "pas-un-uuid" })).total).toBe(1);
  });
});
