/**
 * Intégration — interrupteur d'arrêt du moteur SMS : POST /api/kill-switch
 *
 * Route de sécurité : elle doit être hors de portée des téléphonistes et
 * laisser une trace d'audit à chaque bascule. On exerce le vrai handler
 * exporté avec de vraies `Request` et de vrais JWT `jose` signés avec
 * AUTH_SECRET, sur la base de test locale. Aucun accès réseau.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs, settings } from "@/db/schema";
import { scheduledJobs } from "@/db/schema-sms";

// ── Stubs d'environnement Next ───────────────────────────────────────────────
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "24.48.1.1" }),
}));

const { POST } = await import("@/app/api/kill-switch/route");
const { getSetting, setSetting } = await import("@/lib/settings");

// ── Session ──────────────────────────────────────────────────────────────────

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);

async function signSession(uid: string, role: "admin" | "caller", tv: number) {
  return new SignJWT({ uid, role, tv, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

/** Dépose un cookie de session valide pour cet utilisateur. */
async function loginAs(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  jar.set("nexus_session", await signSession(user.id, user.role, user.tokenVersion));
}

function logout() {
  jar.delete("nexus_session");
}

const URL_KILL_SWITCH = "http://localhost/api/kill-switch";

function killSwitchRequest(body: unknown): Request {
  return new Request(URL_KILL_SWITCH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Ligne `settings` brute pour la clé `sms` (telle qu'écrite en base). */
async function smsSettingsRow() {
  const [row] = await testDb.select().from(settings).where(eq(settings.key, "sms"));
  return row;
}

describe("POST /api/kill-switch", () => {
  beforeEach(async () => {
    await resetDb();
    logout();
  });
  afterAll(closeDb);

  it("refuse (401) une requête anonyme", async () => {
    const res = await POST(killSwitchRequest({ enabled: true }));
    expect(res.status).toBe(401);

    // Rien n'a été écrit : ni réglage, ni trace d'audit.
    expect(await smsSettingsRow()).toBeUndefined();
    expect(await testDb.select().from(auditLogs)).toHaveLength(0);
  });

  it("refuse (403) un téléphoniste — la protection est côté serveur", async () => {
    const caller = await makeUser({ role: "caller" });
    await loginAs(caller);

    const res = await POST(killSwitchRequest({ enabled: true, reason: "tentative" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });

    expect(await smsSettingsRow()).toBeUndefined();
    expect((await getSetting("sms")).killSwitch).toBe(false);
  });

  it("active l'interrupteur : killSwitch, motif et horodatage persistés", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);

    const before = Date.now();
    const res = await POST(
      killSwitchRequest({ enabled: true, reason: "Plainte d'un destinataire" }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: true, cancelledJobs: 0 });

    const row = await smsSettingsRow();
    expect(row).toBeDefined();
    const value = row.value as {
      killSwitch: boolean;
      killSwitchReason: string | null;
      killSwitchAt: string | null;
    };
    expect(value.killSwitch).toBe(true);
    expect(value.killSwitchReason).toBe("Plainte d'un destinataire");
    // Horodatage ISO récent — c'est lui que l'écran d'admin affichera.
    expect(value.killSwitchAt).toEqual(expect.any(String));
    const at = new Date(value.killSwitchAt!).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("annule les jobs send_sms en attente à l'activation (et eux seuls)", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    const past = new Date(Date.now() - 60_000);
    const seed = async (v: Partial<typeof scheduledJobs.$inferInsert>) => {
      const [row] = await testDb
        .insert(scheduledJobs)
        .values({ type: "send_sms", runAt: past, payload: {}, ...v })
        .returning();
      return row;
    };
    const pendingA = await seed({});
    const pendingB = await seed({});
    const running = await seed({ status: "running", lockedAt: past });
    const otherType = await seed({ type: "agent_turn" });

    const res = await POST(killSwitchRequest({ enabled: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: true, cancelledJobs: 2 });

    const byId = async (id: string) =>
      (await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)))[0];
    expect((await byId(pendingA.id)).status).toBe("cancelled");
    expect((await byId(pendingB.id)).status).toBe("cancelled");
    // Le job déjà réclamé reste au dispatcher : son handler relit le réglage
    // et refusera l'envoi lui-même ; les autres types ne sont pas concernés.
    expect((await byId(running.id)).status).toBe("running");
    expect((await byId(otherType.id)).status).toBe("pending");
  });

  it("désactiver n'annule rien et ne ressuscite aucun job annulé", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    const [cancelled] = await testDb
      .insert(scheduledJobs)
      .values({ type: "send_sms", runAt: new Date(), payload: {}, status: "cancelled" })
      .returning();
    const [pending] = await testDb
      .insert(scheduledJobs)
      .values({ type: "send_sms", runAt: new Date(), payload: {} })
      .returning();

    const res = await POST(killSwitchRequest({ enabled: false }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: false, cancelledJobs: 0 });

    const byId = async (id: string) =>
      (await testDb.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)))[0];
    expect((await byId(cancelled.id)).status).toBe("cancelled");
    expect((await byId(pending.id)).status).toBe("pending");
  });

  it("préserve les autres réglages sms au basculement", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    await setSetting("sms", { lastDispatchAt: "2026-08-22T10:00:00.000Z" });

    const on = await POST(killSwitchRequest({ enabled: true }));
    expect(on.status).toBe(200);
    expect(await getSetting("sms")).toMatchObject({
      killSwitch: true,
      lastDispatchAt: "2026-08-22T10:00:00.000Z",
    });

    const off = await POST(killSwitchRequest({ enabled: false }));
    expect(off.status).toBe(200);
    expect(await getSetting("sms")).toMatchObject({
      killSwitch: false,
      lastDispatchAt: "2026-08-22T10:00:00.000Z",
    });
  });

  it("désactive l'interrupteur : motif et horodatage effacés", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    await setSetting("sms", {
      killSwitch: true,
      killSwitchReason: "Incident en cours",
      killSwitchAt: new Date().toISOString(),
    });

    const res = await POST(killSwitchRequest({ enabled: false }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: false, cancelledJobs: 0 });

    const value = (await smsSettingsRow()).value as {
      killSwitch: boolean;
      killSwitchReason: string | null;
      killSwitchAt: string | null;
    };
    expect(value.killSwitch).toBe(false);
    expect(value.killSwitchReason).toBeNull();
    expect(value.killSwitchAt).toBeNull();
  });

  it("refuse (400 invalid_body) un corps invalide sans rien écrire", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);

    const invalids: unknown[] = [
      {}, // enabled manquant
      { enabled: "oui" }, // mauvais type
      { enabled: true, reason: "x".repeat(501) }, // motif trop long
      "{ ceci n'est pas du json", // JSON malformé
    ];
    for (const body of invalids) {
      const res = await POST(killSwitchRequest(body));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid_body" });
    }

    expect(await smsSettingsRow()).toBeUndefined();
    expect(await testDb.select().from(auditLogs)).toHaveLength(0);
  });

  it("journalise chaque bascule dans l'audit (action sms.kill_switch)", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);

    await POST(killSwitchRequest({ enabled: true, reason: "Test de conformité" }));

    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "sms.kill_switch"));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(admin.id);
    expect(logs[0].entity).toBe("settings");
    expect(logs[0].detail).toMatchObject({ enabled: true, reason: "Test de conformité" });
  });
});
