/**
 * Intégration — réglage SMS (durée de validité des consentements) :
 * POST /api/admin/settings/sms
 *
 * Réglage réservé à l'admin, journalisé, et surtout en RUSTINE : changer la
 * durée de validité ne doit jamais réinitialiser l'interrupteur d'arrêt ni les
 * autres clés `sms`. On exerce le vrai handler exporté avec de vraies `Request`
 * et de vrais JWT `jose` signés avec AUTH_SECRET, sur la base de test locale.
 * Aucun accès réseau.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs, settings } from "@/db/schema";

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

const { POST } = await import("@/app/api/admin/settings/sms/route");
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

const URL_SMS_SETTINGS = "http://localhost/api/admin/settings/sms";

function smsSettingsRequest(body: unknown): Request {
  return new Request(URL_SMS_SETTINGS, {
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

describe("POST /api/admin/settings/sms", () => {
  beforeEach(async () => {
    await resetDb();
    logout();
  });
  afterAll(closeDb);

  it("refuse (401) une requête anonyme", async () => {
    const res = await POST(smsSettingsRequest({ consentValidity: "2y" }));
    expect(res.status).toBe(401);

    // Rien n'a été écrit : ni réglage, ni trace d'audit.
    expect(await smsSettingsRow()).toBeUndefined();
    expect(await testDb.select().from(auditLogs)).toHaveLength(0);
  });

  it("refuse (403) un téléphoniste — la protection est côté serveur", async () => {
    const caller = await makeUser({ role: "caller" });
    await loginAs(caller);

    const res = await POST(smsSettingsRequest({ consentValidity: "unlimited" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });

    expect(await smsSettingsRow()).toBeUndefined();
    expect((await getSetting("sms")).consentValidity).toBe("6m");
  });

  it("enregistre la durée choisie par l'admin (2y)", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);

    const res = await POST(smsSettingsRequest({ consentValidity: "2y" }));
    expect(res.status).toBe(200);
    // Même forme de réponse que la route booking : le réglage complet.
    await expect(res.json()).resolves.toMatchObject({ sms: { consentValidity: "2y" } });

    expect((await getSetting("sms")).consentValidity).toBe("2y");
  });

  it("préserve l'interrupteur d'arrêt actif — rustine, jamais un reset", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    const at = new Date().toISOString();
    await setSetting("sms", {
      killSwitch: true,
      killSwitchReason: "Incident en cours",
      killSwitchAt: at,
    });

    const res = await POST(smsSettingsRequest({ consentValidity: "1y" }));
    expect(res.status).toBe(200);

    // Les deux réglages coexistent : la validité a changé, l'interrupteur tient.
    expect(await getSetting("sms")).toMatchObject({
      killSwitch: true,
      killSwitchReason: "Incident en cours",
      killSwitchAt: at,
      consentValidity: "1y",
    });
  });

  it("refuse (422 validation) une durée inconnue sans rien écrire", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);

    const res = await POST(smsSettingsRequest({ consentValidity: "4y" }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ error: "validation" });

    expect(await smsSettingsRow()).toBeUndefined();
    expect(await testDb.select().from(auditLogs)).toHaveLength(0);
  });

  it("journalise le changement dans l'audit (action settings.sms)", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);

    await POST(smsSettingsRequest({ consentValidity: "3y" }));

    const logs = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "settings.sms"));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(admin.id);
    expect(logs[0].entity).toBe("settings");
    // Différentiel avant/après restreint à consentValidity (défaut « 6m »).
    expect(logs[0].detail).toMatchObject({
      consentValidity: "3y",
      changes: { consentValidity: { from: "6m", to: "3y" } },
    });
  });
});
