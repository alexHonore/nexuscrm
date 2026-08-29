/**
 * Intégration — « Mon profil », section Notifications : ce par quoi une
 * personne accepte d'être atteinte. Vrais handlers, vraie base, vrai garde.
 *
 * Ces quatre actions écrivent des choses qui ne se voient PAS quand elles sont
 * fausses : une préférence enregistrée à l'envers ne casse rien, elle rend
 * simplement un téléphone muet ; un numéro personnel mal chiffré ne lève aucune
 * erreur, il attend une copie de la base ; un désabonnement mal borné rend
 * quelqu'un d'autre sourd sans qu'il l'apprenne. D'où un test par promesse
 * faite à l'écran, plutôt qu'un test par fonction.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs } from "@/db/schema";
import { pushSubscriptions, userReach } from "@/db/schema-push";

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

const actions = await import("@/app/(app)/profile/actions");
const { decryptSecret } = await import("@/lib/crypto");

async function login(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
}

const reachOf = async (id: string) =>
  (await testDb.select().from(userReach).where(eq(userReach.userId, id)))[0] ?? null;

describe("joignabilité", () => {
  afterAll(closeDb);
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
  });

  it("n'enregistre que les REFUS, et seulement des types poussés", async () => {
    const user = await makeUser({});
    await login(user);
    expect(
      await actions.updatePushPrefsAction({
        prefs: { missed_call: false, mention: true, system: false, inventé: false },
      }),
    ).toEqual({ ok: true });
    expect((await reachOf(user.id))?.pushPrefs).toEqual({ missed_call: false });
  });

  it("refuse une demi-nuit et deux heures identiques", async () => {
    const user = await makeUser({});
    await login(user);
    expect(await actions.updateQuietHoursAction({ from: "22:00", to: "", bypassUrgent: true })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await actions.updateQuietHoursAction({ from: "22:00", to: "22:00", bypassUrgent: true })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(await actions.updateQuietHoursAction({ from: "22:00", to: "07:00", bypassUrgent: false })).toEqual({
      ok: true,
    });
    const row = await reachOf(user.id);
    expect([row?.quietFrom, row?.quietTo, row?.quietBypassUrgent]).toEqual(["22:00", "07:00", false]);
    // Les deux vides = jamais de silence.
    expect(await actions.updateQuietHoursAction({ from: "", to: "", bypassUrgent: true })).toEqual({ ok: true });
    expect((await reachOf(user.id))?.quietFrom).toBeNull();
  });

  it("chiffre le cellulaire, garde les 4 derniers, et consigne sans le numéro", async () => {
    const user = await makeUser({});
    await login(user);
    expect(await actions.updateMobileAction({ phone: "418-476-1542", ringMobile: true })).toEqual({ ok: true });
    let row = await reachOf(user.id);
    expect(row?.mobileLast4).toBe("1542");
    expect(row?.ringMobile).toBe(true);
    expect(decryptSecret(row!.mobilePhoneEnc!)).toBe("+14184761542");
    expect(row!.mobilePhoneEnc).not.toContain("4761542");

    const logs = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "user.mobile_update"));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0].detail)).not.toContain("4761542");
    expect(JSON.stringify(logs[0].detail)).toContain("modifié");

    // `null` = ne touche pas au numéro
    expect(await actions.updateMobileAction({ phone: null, ringMobile: false })).toEqual({ ok: true });
    row = await reachOf(user.id);
    expect(row?.mobileLast4).toBe("1542");
    expect(row?.ringMobile).toBe(false);

    // Un numéro impossible est refusé AVEC son propre code
    expect(await actions.updateMobileAction({ phone: "abc", ringMobile: true })).toEqual({
      ok: false,
      error: "phone",
    });
    expect((await reachOf(user.id))?.mobileLast4).toBe("1542");

    // `""` retire le numéro et éteint la sonnerie
    expect(await actions.updateMobileAction({ phone: "", ringMobile: true })).toEqual({ ok: true });
    row = await reachOf(user.id);
    expect(row?.mobilePhoneEnc).toBeNull();
    expect(row?.mobileLast4).toBeNull();
    expect(row?.ringMobile).toBe(false);
  });

  it("ne désabonne QUE ses propres appareils", async () => {
    const mine = await makeUser({});
    const other = await makeUser({});
    const [a] = await testDb
      .insert(pushSubscriptions)
      .values({ userId: mine.id, endpoint: "https://push.test/aaaaaaaaaaaaaaaa", p256dh: "p", auth: "a" })
      .returning();
    const [b] = await testDb
      .insert(pushSubscriptions)
      .values({ userId: other.id, endpoint: "https://push.test/bbbbbbbbbbbbbbbb", p256dh: "p", auth: "a" })
      .returning();
    await login(mine);

    expect(await actions.forgetDeviceAction({ id: b.id })).toEqual({ ok: true });
    expect(await testDb.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, b.id))).toHaveLength(1);

    expect(await actions.forgetDeviceAction({ id: a.id })).toEqual({ ok: true });
    expect(await testDb.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, a.id))).toHaveLength(0);
    const logs = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "push.unsubscribe"));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0].detail)).toContain("aaaaaaaaaaaa");
  });

  it("refuse un visiteur non connecté", async () => {
    expect(await actions.updatePushPrefsAction({ prefs: {} })).toEqual({ ok: false, error: "forbidden" });
    expect(await actions.updateMobileAction({ phone: null, ringMobile: true })).toEqual({
      ok: false,
      error: "forbidden",
    });
  });
});
