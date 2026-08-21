/**
 * Intégration — administration des numéros SMS.
 *
 * L'écran manquait ; ce qui compte côté serveur : admin seulement, E.164
 * imposé, un numéro utilisé ne se supprime pas, un assistant par défaut doit
 * être actif, et la synchronisation Twilio n'active RIEN toute seule.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { closeDb, makeClient, makeConversation, makeSmsNumber, makeUser, resetDb, testDb } from "./helpers/db";
import { assistants, smsNumbers } from "@/db/schema-sms";

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

const collection = await import("@/app/api/admin/sms-numbers/route");
const single = await import("@/app/api/admin/sms-numbers/[id]/route");
const { fetchTwilioServiceNumbers } = await import("@/lib/sms-server/numbers");

async function loginAs(role: "admin" | "caller") {
  const user = await makeUser({ role, email: `${role}-${Math.random().toString(16).slice(2)}@x.test` });
  const token = await new SignJWT({ uid: user.id, role, tv: user.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set("nexus_session", token);
  return user;
}
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterAll(closeDb);

describe("numéros SMS (admin)", () => {
  beforeEach(async () => {
    await resetDb();
    ctx.cookies.clear();
  });

  it("un téléphoniste est refusé", async () => {
    await loginAs("caller");
    expect((await collection.GET()).status).toBe(403);
    expect((await collection.POST(req("/api/admin/sms-numbers", "POST", { e164: "+15815550000" }))).status).toBe(403);
  });

  it("création : le numéro est normalisé en E.164, le doublon refusé, le format invalide refusé", async () => {
    await loginAs("admin");
    const res = await collection.POST(req("/api/admin/sms-numbers", "POST", { e164: "581-481-0742", label: "Ligne" }));
    expect(res.status).toBe(201);
    const [row] = await testDb.select().from(smsNumbers);
    expect(row.e164).toBe("+15814810742");
    expect(row.label).toBe("Ligne");
    expect(row.active).toBe(true);
    expect((await collection.POST(req("/api/admin/sms-numbers", "POST", { e164: "(581) 481-0742" }))).status).toBe(409);
    expect((await collection.POST(req("/api/admin/sms-numbers", "POST", { e164: "abc" }))).status).toBe(400);
  });

  it("modification : plafond, actif, libellé ; un assistant par défaut doit être ACTIF", async () => {
    await loginAs("admin");
    const number = await makeSmsNumber({ e164: "+15810000011" });
    const [draft] = await testDb.insert(assistants).values({ name: "Brouillon", status: "draft", identity: {}, goal: {}, approach: {}, model: {} }).returning();
    expect((await single.PATCH(req(`/api/admin/sms-numbers/${number.id}`, "PATCH", { defaultAssistantId: draft.id }), params(number.id))).status).toBe(409);
    const ok = await single.PATCH(req(`/api/admin/sms-numbers/${number.id}`, "PATCH", { dailyCap: 50, active: false, label: "Essai" }), params(number.id));
    expect(ok.status).toBe(200);
    const row = await testDb.query.smsNumbers.findFirst({ where: eq(smsNumbers.id, number.id) });
    expect(row).toMatchObject({ dailyCap: 50, active: false, label: "Essai" });
  });

  it("suppression : refusée tant que des fils y sont rattachés", async () => {
    await loginAs("admin");
    const number = await makeSmsNumber({ e164: "+15810000012" });
    const client = await makeClient({ phone: "+15145550180" });
    await makeConversation({ clientId: client.id, clientPhone: client.phone, smsNumberId: number.id });
    expect((await single.DELETE(req(`/api/admin/sms-numbers/${number.id}`, "DELETE"), params(number.id))).status).toBe(409);
    const free = await makeSmsNumber({ e164: "+15810000013" });
    expect((await single.DELETE(req(`/api/admin/sms-numbers/${free.id}`, "DELETE"), params(free.id))).status).toBe(200);
    expect(await testDb.query.smsNumbers.findFirst({ where: eq(smsNumbers.id, free.id) })).toBeUndefined();
  });

  it("la liste expose les fils par numéro et les assistants actifs seulement", async () => {
    await loginAs("admin");
    const number = await makeSmsNumber({ e164: "+15810000014" });
    const client = await makeClient({ phone: "+15145550181" });
    await makeConversation({ clientId: client.id, clientPhone: client.phone, smsNumberId: number.id });
    await testDb.insert(assistants).values({ name: "Brouillon", status: "draft", identity: {}, goal: {}, approach: {}, model: {} });
    const res = await collection.GET();
    const body = (await res.json()) as { numbers: { conversationCount: number }[]; assistants: unknown[] };
    expect(body.numbers[0].conversationCount).toBe(1);
    expect(body.assistants).toHaveLength(0);
  });

  it("la liste Twilio lit le Messaging Service avec la clé d'envoi, sans rien activer", async () => {
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGtest";
    process.env.TWILIO_API_KEY_SID = "SKtest";
    process.env.TWILIO_API_KEY_SECRET = "secret";
    const seen: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("SKtest:secret")}`);
      return new Response(JSON.stringify({ phone_numbers: [{ phone_number: "+15814810742", sid: "PN1" }] }), { status: 200 });
    }) as typeof fetch;
    const list = await fetchTwilioServiceNumbers(fetchFn);
    expect(list).toEqual([{ phoneNumber: "+15814810742", sid: "PN1" }]);
    expect(seen[0]).toContain("/Services/MGtest/PhoneNumbers");
  });
});
