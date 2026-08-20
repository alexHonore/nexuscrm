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
import { addMonths, addYears, subMonths } from "date-fns";
import { SignJWT } from "jose";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs, settings } from "@/db/schema";
import { consents } from "@/db/schema-sms";

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

  // ── Recalcul des consentements existants (applyToExisting / dryRun) ────────

  /**
   * Registre type : A actif (octroyé maintenant, échéance +6 mois), B échu
   * (octroyé il y a 8 mois, échéance passée), C révoqué (intouchable),
   * D canal courriel (hors périmètre — le réglage est SMS seulement).
   */
  async function seedLedger() {
    const client = await makeClient();
    const now = new Date();
    const eightMonthsAgo = subMonths(now, 8);
    const insert = async (v: Partial<typeof consents.$inferInsert>) => {
      const [row] = await testDb
        .insert(consents)
        .values({
          clientId: client.id,
          channel: "sms",
          kind: "implied_inquiry",
          source: "test",
          ...v,
        })
        .returning();
      return row;
    };
    const active = await insert({ grantedAt: now, expiresAt: addMonths(now, 6) });
    const expired = await insert({
      grantedAt: eightMonthsAgo,
      expiresAt: addMonths(eightMonthsAgo, 6),
    });
    const revoked = await insert({
      grantedAt: eightMonthsAgo,
      expiresAt: addMonths(eightMonthsAgo, 6),
      revokedAt: subMonths(now, 7),
    });
    const email = await insert({ channel: "email", grantedAt: now, expiresAt: addMonths(now, 6) });
    return { active, expired, revoked, email };
  }

  async function consentById(id: string) {
    const [row] = await testDb.select().from(consents).where(eq(consents.id, id));
    return row;
  }

  it("dryRun : renvoie les décomptes sans RIEN écrire (ni réglage, ni audit, ni registre)", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    const { expired } = await seedLedger();

    const res = await POST(
      smsSettingsRequest({ consentValidity: "2y", applyToExisting: true, dryRun: true }),
    );
    expect(res.status).toBe(200);
    // A et B changent d'échéance ; B (échu) redeviendrait valide ; rien ne périme.
    await expect(res.json()).resolves.toEqual({ preview: { updated: 2, revived: 1, lapsed: 0 } });

    expect(await smsSettingsRow()).toBeUndefined();
    expect(await testDb.select().from(auditLogs)).toHaveLength(0);
    const untouched = await consentById(expired.id);
    expect(untouched.expiresAt!.getTime()).toBe(expired.expiresAt!.getTime());
  });

  it("applyToExisting (allongement 2y) : recalcule depuis grantedAt, ravive l'échu, épargne révoqué et courriel", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    const { active, expired, revoked, email } = await seedLedger();

    const res = await POST(smsSettingsRequest({ consentValidity: "2y", applyToExisting: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sms: { consentValidity: "2y" },
      backfill: { updated: 2, revived: 1, lapsed: 0 },
    });

    // Échéances recalculées depuis la date d'octroi de CHAQUE rangée.
    const a = await consentById(active.id);
    expect(Math.abs(a.expiresAt!.getTime() - addYears(a.grantedAt, 2).getTime())).toBeLessThan(60_000);
    const b = await consentById(expired.id);
    expect(Math.abs(b.expiresAt!.getTime() - addYears(b.grantedAt, 2).getTime())).toBeLessThan(60_000);
    expect(b.expiresAt!.getTime()).toBeGreaterThan(Date.now()); // ravivé

    // Révocation sacrée, autre canal hors périmètre : intouchés.
    const c = await consentById(revoked.id);
    expect(c.expiresAt!.getTime()).toBe(revoked.expiresAt!.getTime());
    expect(c.revokedAt).not.toBeNull();
    const d = await consentById(email.id);
    expect(d.expiresAt!.getTime()).toBe(email.expiresAt!.getTime());

    // Audit dédié avec les décomptes.
    const logs = await testDb
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "consents.expiry_backfill"));
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(admin.id);
    expect(logs[0].detail).toMatchObject({
      consentValidity: "2y",
      updated: 2,
      revived: 1,
      lapsed: 0,
    });
  });

  it("applyToExisting (illimité) : expiresAt devient NULL sur les rangées SMS non révoquées", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    const { active, expired, revoked } = await seedLedger();

    const res = await POST(
      smsSettingsRequest({ consentValidity: "unlimited", applyToExisting: true }),
    );
    expect(res.status).toBe(200);

    expect((await consentById(active.id)).expiresAt).toBeNull();
    expect((await consentById(expired.id)).expiresAt).toBeNull();
    expect((await consentById(revoked.id)).expiresAt).not.toBeNull();
  });

  it("applyToExisting (raccourcissement illimité→6m) : les vieux consentements périment (lapsed)", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    const client = await makeClient();
    const eightMonthsAgo = subMonths(new Date(), 8);
    const [old] = await testDb
      .insert(consents)
      .values({
        clientId: client.id,
        channel: "sms",
        kind: "implied_inquiry",
        source: "test",
        grantedAt: eightMonthsAgo,
        expiresAt: null, // régime « illimité »
      })
      .returning();

    const res = await POST(smsSettingsRequest({ consentValidity: "6m", applyToExisting: true }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      backfill: { updated: 1, revived: 0, lapsed: 1 },
    });

    const row = await consentById(old.id);
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect(row.expiresAt!.getTime()).toBeLessThan(Date.now()); // désormais échu
  });

  it("sans applyToExisting : le registre existant n'est PAS touché", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin);
    const { expired } = await seedLedger();

    const res = await POST(smsSettingsRequest({ consentValidity: "3y" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.backfill).toBeUndefined();

    const row = await consentById(expired.id);
    expect(row.expiresAt!.getTime()).toBe(expired.expiresAt!.getTime());
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
