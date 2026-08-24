/**
 * Intégration — correctifs d'audit (grappe C) : routes utilisateur et TwiML.
 *
 *  · POST/PATCH /api/campaigns : un assistant ou un numéro expéditeur inconnu
 *    passe zod (c'est un UUID) et faisait sauter la clé étrangère → 500. On
 *    répond 409 avec un code, comme la porte d'activation.
 *  · POST /api/telephony/twiml (sortant) : le DID présenté vient de
 *    l'identité du jeton, jamais du paramètre `CallerId` du navigateur ; un
 *    utilisateur désactivé ou inconnu est refusé même si son jeton court
 *    encore ; la signature Twilio reste exigée.
 *
 * Vrais handlers + vrai garde RBAC (JWT nexus_session) pour les campagnes ;
 * vraie signature HMAC pour le webhook TwiML.
 */
import { createHmac } from "crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeSmsNumber, makeUser, resetDb, testDb } from "./helpers/db";
import { assistants, campaigns } from "@/db/schema-sms";
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

const { POST: postCampaign } = await import("@/app/api/campaigns/route");
const { PATCH: patchCampaign } = await import("@/app/api/campaigns/[id]/route");
const { POST: postTwiml } = await import("@/app/api/telephony/twiml/route");
const { NextRequest } = await import("next/server");

const UNKNOWN_UUID = "11111111-1111-4111-8111-111111111111";

async function login(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
}

function jsonReq(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function campaignBody(overrides: Record<string, unknown> = {}) {
  return campaignConfigSchema.parse({
    name: "Réactivation",
    trigger: { kind: "manual" },
    ladder: [{ delayHours: 0, body: "Bonjour", label: "" }],
    ...overrides,
  });
}

async function makeAssistant() {
  const config = assistantConfigSchema.parse({
    name: "Acheteur",
    identity: {},
    goal: { primary: { type: "video_meeting", durationMin: 30 }, fallbacks: [] },
    approach: {},
    model: {},
  });
  const [row] = await testDb
    .insert(assistants)
    .values({
      name: config.name,
      description: config.description,
      language: config.language,
      secondaryLanguage: config.secondaryLanguage,
      identity: config.identity,
      goal: config.goal,
      approach: config.approach,
      knowledge: config.knowledge,
      objectionPacks: config.objectionPacks,
      tools: config.tools,
      model: config.model,
      promptMode: config.promptMode,
      systemPromptOverride: config.systemPromptOverride,
      layerOverrides: config.layerOverrides,
      turnInstructions: config.turnInstructions,
      includeRuntimeLayer: config.includeRuntimeLayer,
      requireSuitePass: config.requireSuitePass,
      status: "draft",
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await resetDb();
  CTX.jar.clear();
});
afterAll(closeDb);

// ── Campagnes : références pendantes ────────────────────────────────────────

describe("POST/PATCH /api/campaigns — références inconnues", () => {
  it("créer avec un assistant inconnu : 409 assistant_not_found, pas 500", async () => {
    await login(await makeUser({ role: "admin" }));
    const res = await postCampaign(
      jsonReq("http://localhost/api/campaigns", "POST", campaignBody({ assistantId: UNKNOWN_UUID })),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "assistant_not_found" });
    expect(await testDb.select().from(campaigns)).toHaveLength(0);
  });

  it("créer avec un numéro expéditeur inconnu : 409 sms_number_not_found", async () => {
    await login(await makeUser({ role: "admin" }));
    const res = await postCampaign(
      jsonReq("http://localhost/api/campaigns", "POST", campaignBody({ smsNumberId: UNKNOWN_UUID })),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "sms_number_not_found" });
  });

  it("créer avec des références qui existent : 201, le brouillon est lié", async () => {
    await login(await makeUser({ role: "admin" }));
    const assistant = await makeAssistant();
    const number = await makeSmsNumber();
    const res = await postCampaign(
      jsonReq(
        "http://localhost/api/campaigns",
        "POST",
        campaignBody({ assistantId: assistant.id, smsNumberId: number.id }),
      ),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await testDb.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
    expect(row!.assistantId).toBe(assistant.id);
    expect(row!.smsNumberId).toBe(number.id);
    expect(row!.status).toBe("draft");
  });

  it("enregistrer un brouillon avec un numéro supprimé entre-temps : 409, pas 500", async () => {
    await login(await makeUser({ role: "admin" }));
    const created = await postCampaign(jsonReq("http://localhost/api/campaigns", "POST", campaignBody()));
    const { id } = (await created.json()) as { id: string };

    // L'éditeur resté ouvert pendant que le numéro disparaissait dans un autre onglet.
    const res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${id}`, "PATCH", {
        config: campaignBody({ smsNumberId: UNKNOWN_UUID }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "sms_number_not_found" });

    const row = await testDb.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
    expect(row!.smsNumberId).toBeNull();
  });

  it("enregistrer avec un assistant inconnu garde son code historique : 409 assistant_not_found", async () => {
    await login(await makeUser({ role: "admin" }));
    const created = await postCampaign(jsonReq("http://localhost/api/campaigns", "POST", campaignBody()));
    const { id } = (await created.json()) as { id: string };

    const res = await patchCampaign(
      jsonReq(`http://localhost/api/campaigns/${id}`, "PATCH", {
        config: campaignBody({ assistantId: UNKNOWN_UUID }),
      }),
      ctx(id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "assistant_not_found" });
  });
});

// ── TwiML sortant : le DID vient de l'identité, pas du navigateur ───────────

const URL_TWIML = `${process.env.NEXT_PUBLIC_APP_URL}/api/telephony/twiml`;
const TOKEN = "test_twilio_token";

/** Signature Twilio : base64(HMAC-SHA1(url + params POST triés, authToken)). */
function twilioSig(url: string, params: URLSearchParams, token: string): string {
  const data =
    url +
    [...params.keys()]
      .sort()
      .map((k) => k + (params.get(k) ?? ""))
      .join("");
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

function twimlRequest(form: Record<string, string>, { signature }: { signature?: string } = {}) {
  const params = new URLSearchParams(form);
  return new NextRequest(URL_TWIML, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature ?? twilioSig(URL_TWIML, params, TOKEN),
    },
    body: params.toString(),
  });
}

describe("POST /api/telephony/twiml — appel sortant du navigateur", () => {
  beforeAll(() => {
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
  });

  it("présente le DID de l'utilisateur du jeton, jamais le CallerId envoyé par le navigateur", async () => {
    const caller = await makeUser({ role: "caller", didNumber: "+14185550101" });
    await makeUser({ role: "admin", didNumber: "+15145550199" });

    const res = await postTwiml(
      twimlRequest({
        From: `client:user-${caller.id}`,
        To: "+14185550123",
        // Le numéro du patron, glissé depuis la console du navigateur.
        CallerId: "+15145550199",
      }),
    );
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('callerId="+14185550101"');
    expect(xml).not.toContain("+15145550199");
    expect(xml).toContain("<Number>+14185550123</Number>");
  });

  it("refuse un utilisateur désactivé dont le jeton d'une heure court encore", async () => {
    const gone = await makeUser({ role: "caller", didNumber: "+14185550101", isActive: false });
    const res = await postTwiml(
      twimlRequest({ From: `client:user-${gone.id}`, To: "+14185550123", CallerId: "+14185550101" }),
    );
    expect(await res.text()).toContain("<Reject/>");
  });

  it("refuse une identité inconnue ou mal formée, sans faire planter le cast uuid", async () => {
    for (const from of [`client:user-${UNKNOWN_UUID}`, "client:user-pas-un-uuid", "client:quelqu-un"]) {
      const res = await postTwiml(twimlRequest({ From: from, To: "+14185550123" }));
      expect(res.status, from).toBe(200);
      expect(await res.text(), from).toContain("<Reject/>");
    }
  });

  it("refuse un utilisateur sans DID attitré plutôt que de composer sans numéro présenté", async () => {
    const noLine = await makeUser({ role: "caller", didNumber: null });
    const res = await postTwiml(
      twimlRequest({ From: `client:user-${noLine.id}`, To: "+14185550123", CallerId: "+15145550199" }),
    );
    expect(await res.text()).toContain("<Reject/>");
  });

  it("exige toujours la signature Twilio", async () => {
    const caller = await makeUser({ role: "caller", didNumber: "+14185550101" });
    const res = await postTwiml(
      twimlRequest(
        { From: `client:user-${caller.id}`, To: "+14185550123" },
        { signature: "pas-la-bonne-signature" },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("l'entrant continue de sonner le propriétaire actif du DID", async () => {
    const owner = await makeUser({ role: "caller", didNumber: "+14185550101" });
    const res = await postTwiml(twimlRequest({ From: "+15145550000", To: "+14185550101" }));
    expect(await res.text()).toContain(`<Client>user-${owner.id}</Client>`);
  });
});
