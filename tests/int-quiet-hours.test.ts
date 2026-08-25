/**
 * Intégration — fenêtre d'envoi RÉGLABLE (heures de politesse).
 *
 *  · Le réglage `quietHours` est lu par le dernier verrou d'envoi
 *    (`handleSendSms`) : un message automatisé hors de la fenêtre CONFIGURÉE
 *    est reporté, jamais envoyé — même à une heure que la fenêtre par défaut
 *    aurait permise. C'est la garantie « pas de texto à 3 h ».
 *  · La route POST /api/admin/settings/quiet-hours : réservée à l'admin, refuse
 *    une fenêtre invalide (fin ≤ début).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import { SignJWT } from "jose";
import { closeDb, makeClient, makeConversation, makeSmsNumber, makeUser, resetDb, testDb } from "./helpers/db";
import { scheduledJobs } from "@/db/schema-sms";

const CTX = vi.hoisted(() => ({ jar: new Map<string, string>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (CTX.jar.has(n) ? { name: n, value: CTX.jar.get(n)! } : undefined),
    set: (n: string, v: string) => void CTX.jar.set(n, v),
    delete: (n: string) => void CTX.jar.delete(n),
  }),
  headers: async () => new Headers(),
}));

const { handleSendSms } = await import("@/lib/jobs/handlers/send-sms");
const { getSetting, setSetting } = await import("@/lib/settings");
const { POST } = await import("@/app/api/admin/settings/quiet-hours/route");
const { NextRequest } = await import("next/server");

const TZ = "America/Toronto";
const toronto = (local: string) => fromZonedTime(local, TZ);

async function login(role: "admin" | "caller") {
  const user = await makeUser({ role });
  const token = await new SignJWT({ uid: user.id, role, tv: user.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
}

const postReq = (body: unknown) =>
  new NextRequest("http://x/api/admin/settings/quiet-hours", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/** Un job d'envoi automatisé prêt à passer le verrou de fenêtre. */
async function automatedSendJob() {
  const client = await makeClient();
  const number = await makeSmsNumber({ active: true });
  const conv = await makeConversation({
    clientId: client.id,
    smsNumberId: number.id,
    clientPhone: client.phone,
    aiEnabled: true,
  });
  const [job] = await testDb
    .insert(scheduledJobs)
    .values({
      type: "send_sms",
      runAt: new Date(),
      status: "running",
      payload: {
        conversationId: conv.id,
        to: client.phone,
        body: "Bonjour, ici Groupe Nexus.",
        source: "agent",
        automated: true,
        aiGenerated: true,
        sentById: null,
      },
    })
    .returning();
  return job;
}

afterAll(closeDb);

describe("handleSendSms respecte la fenêtre CONFIGURÉE", () => {
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
    delete process.env.SMS_MODE; // dry_run — aucun vrai SMS
  });

  it("mercredi 14 h : permis par DÉFAUT, mais REPORTÉ si la fenêtre configurée est 6 h–8 h", async () => {
    // Fenêtre serrée au petit matin — 14 h tombe donc dehors.
    await setSetting("quietHours", {
      tz: TZ,
      weekday: [6, 8],
      saturday: [6, 8],
      sunday: [6, 8],
    });
    const job = await automatedSendJob();
    const result = await handleSendSms(job, () => toronto("2026-08-19T14:00:00")); // mercredi 14 h
    expect(result.outcome).toBe("reschedule");
  });

  it("dans la fenêtre configurée (7 h) : l'envoi n'est PAS reporté par la fenêtre", async () => {
    await setSetting("quietHours", {
      tz: TZ,
      weekday: [6, 8],
      saturday: [6, 8],
      sunday: [6, 8],
    });
    const job = await automatedSendJob();
    const result = await handleSendSms(job, () => toronto("2026-08-19T07:00:00")); // mercredi 7 h
    expect(result.outcome).not.toBe("reschedule");
  });

  it("sans réglage enregistré : comportement d'origine (14 h permis, 3 h reporté)", async () => {
    const jobDay = await automatedSendJob();
    expect((await handleSendSms(jobDay, () => toronto("2026-08-19T14:00:00"))).outcome).not.toBe(
      "reschedule",
    );
    const jobNight = await automatedSendJob();
    expect((await handleSendSms(jobNight, () => toronto("2026-08-19T03:00:00"))).outcome).toBe(
      "reschedule",
    );
  });
});

describe("POST /api/admin/settings/quiet-hours", () => {
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
  });

  it("admin : enregistre une fenêtre valide", async () => {
    await login("admin");
    const res = await POST(postReq({ weekday: [8, 21] }));
    expect(res.status).toBe(200);
    expect((await getSetting("quietHours")).weekday).toEqual([8, 21]);
  });

  it("fenêtre invalide (fin ≤ début) → 422", async () => {
    await login("admin");
    const res = await POST(postReq({ weekday: [21, 8] }));
    expect(res.status).toBe(422);
  });

  it("RBAC : téléphoniste 403, anonyme 401", async () => {
    const anon = await POST(postReq({ weekday: [8, 21] }));
    expect(anon.status).toBe(401);
    await login("caller");
    const denied = await POST(postReq({ weekday: [8, 21] }));
    expect(denied.status).toBe(403);
  });
});
