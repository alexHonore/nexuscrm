/**
 * Tests d'intégration — authentification, sessions, limitation de débit,
 * réinitialisation de mot de passe.
 *
 * Tout tape sur la vraie base de test + le vrai code produit :
 * seuls next/headers, next/cache et l'envoi de courriel (réseau) sont simulés.
 */
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, makeUser, resetDb, sqlRaw, testDb } from "./helpers/db";
import { auditLogs, loginThrottle, passwordResets, users } from "@/db/schema";

vi.mock("server-only", () => ({}));

// ── Contexte de requête simulé (cookies + en-têtes) ──────────────────────────

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, { name: string; value: string; options?: Record<string, unknown> }>(),
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const c = ctx.cookies.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    getAll() {
      return [...ctx.cookies.values()].map((c) => ({ name: c.name, value: c.value }));
    },
    has(name: string) {
      return ctx.cookies.has(name);
    },
    set(name: string, value: string, options?: Record<string, unknown>) {
      ctx.cookies.set(name, { name, value, options });
    },
    delete(name: string) {
      ctx.cookies.delete(name);
    },
  }),
  headers: async () => ctx.headers,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

// ── Courriel : seul l'appel réseau est simulé, les gabarits restent réels ────

const sentEmails = vi.hoisted(() => [] as { to: string; subject: string; html: string; text: string }[]);

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    isEmailConfigured: () => true,
    sendEmail: vi.fn(async (opts: { to: string; subject: string; html: string; text: string }) => {
      sentEmails.push(opts);
    }),
  };
});

// Aucun appel réseau réel ne doit sortir des tests.
const fetchSpy = vi.fn(async () => {
  throw new Error("réseau interdit dans les tests");
});
vi.stubGlobal("fetch", fetchSpy);

import { loginAction } from "@/app/(auth)/login/actions";
import { applyResetAction, requestResetAction } from "@/app/(auth)/forgot-password/actions";
import { getCurrentUser, requireAdmin, requireUser } from "@/lib/auth/guards";
import { createSession, destroySession, readSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { sha256Hex } from "@/lib/crypto";
import { sendEmail } from "@/lib/email";
import { verifyPassword } from "@/lib/auth/password";

// ── Utilitaires ──────────────────────────────────────────────────────────────

const SECRET = () => new TextEncoder().encode(process.env.AUTH_SECRET!);

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function loginForm(email: string, password: string, remember = false) {
  return remember ? form({ email, password, remember: "on" }) : form({ email, password });
}

/** loginAction lance NEXT_REDIRECT quand la connexion réussit. */
async function expectLoginRedirect(fd: FormData): Promise<void> {
  let digest: string | undefined;
  try {
    await loginAction(null, fd);
  } catch (err) {
    digest = (err as { digest?: string }).digest;
  }
  expect(digest, "loginAction aurait dû rediriger").toBeDefined();
  expect(digest).toContain("NEXT_REDIRECT");
  expect(digest).toContain("/dashboard");
}

function sessionCookie() {
  return ctx.cookies.get(SESSION_COOKIE_NAME);
}

async function decodeSessionCookie() {
  const raw = sessionCookie();
  expect(raw, "cookie nexus_session absent").toBeDefined();
  const { jwtVerify } = await import("jose");
  const { payload } = await jwtVerify(raw!.value, SECRET());
  return payload as unknown as {
    uid: string;
    role: string;
    tv: number;
    remember: boolean;
    exp: number;
    iat: number;
  };
}

async function signToken(
  payload: Record<string, unknown>,
  { expiresIn = 3600 }: { expiresIn?: number } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(SECRET());
}

function putCookie(value: string) {
  ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value });
}

async function auditActions(): Promise<string[]> {
  const rows = await testDb.select().from(auditLogs);
  return rows.map((r) => r.action);
}

beforeEach(async () => {
  await resetDb();
  ctx.cookies.clear();
  ctx.headers = new Headers();
  sentEmails.length = 0;
  fetchSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("loginAction", () => {
  it("crée une session, pose le cookie, redirige et estampille lastLoginAt", async () => {
    const user = await makeUser({ email: "alex@nexus.test", role: "admin" });

    await expectLoginRedirect(loginForm(user.email, user.plainPassword!));

    const cookie = sessionCookie();
    expect(cookie).toBeDefined();
    expect(cookie!.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });

    const payload = await decodeSessionCookie();
    expect(payload.uid).toBe(user.id);
    expect(payload.role).toBe("admin");
    expect(payload.tv).toBe(user.tokenVersion);

    const [row] = await testDb.select().from(users).where(eq(users.id, user.id));
    expect(row.lastLoginAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - row.lastLoginAt!.getTime())).toBeLessThan(60_000);
  });

  it("le cookie posé résout bien vers l'utilisateur via les gardes", async () => {
    const user = await makeUser({ email: "resolve@nexus.test" });
    await expectLoginRedirect(loginForm(user.email, user.plainPassword!));

    const current = await getCurrentUser();
    expect(current?.id).toBe(user.id);
  });

  it("refuse un mauvais mot de passe sans poser de cookie", async () => {
    const user = await makeUser({ email: "bad@nexus.test" });

    const res = await loginAction(null, loginForm(user.email, "MauvaisMotDePasse!"));

    expect(res).toEqual({ error: "invalid" });
    expect(sessionCookie()).toBeUndefined();
  });

  it("renvoie EXACTEMENT la même réponse pour un courriel inconnu (pas d'énumération)", async () => {
    const user = await makeUser({ email: "known@nexus.test" });

    const wrongPassword = await loginAction(null, loginForm(user.email, "MauvaisMotDePasse!"));
    const unknownEmail = await loginAction(null, loginForm("inconnu@nexus.test", "MauvaisMotDePasse!"));

    expect(unknownEmail).toEqual(wrongPassword);
    expect(unknownEmail).toEqual({ error: "invalid" });
    expect(sessionCookie()).toBeUndefined();
  });

  it("renvoie 'disabled' pour un compte désactivé, sans session", async () => {
    const user = await makeUser({ email: "off@nexus.test", isActive: false });

    const res = await loginAction(null, loginForm(user.email, user.plainPassword!));

    expect(res).toEqual({ error: "disabled" });
    expect(sessionCookie()).toBeUndefined();
    expect(await auditActions()).toContain("login.disabled");
  });

  it("normalise la casse et les espaces du courriel", async () => {
    const user = await makeUser({ email: "casse@nexus.test" });

    await expectLoginRedirect(loginForm("  CASSE@Nexus.TEST  ", user.plainPassword!));

    expect((await decodeSessionCookie()).uid).toBe(user.id);
  });

  it("refuse un courriel malformé", async () => {
    const res = await loginAction(null, loginForm("pas-un-courriel", "x"));
    expect(res).toEqual({ error: "invalid" });
  });

  it("écrit un audit login.success (avec userId) et login.failed (avec le courriel)", async () => {
    const user = await makeUser({ email: "audit@nexus.test" });

    await loginAction(null, loginForm(user.email, "mauvais"));
    await expectLoginRedirect(loginForm(user.email, user.plainPassword!));

    const rows = await testDb.select().from(auditLogs);
    const failed = rows.find((r) => r.action === "login.failed");
    const success = rows.find((r) => r.action === "login.success");

    expect(failed).toBeDefined();
    expect(failed!.detail).toMatchObject({ email: "audit@nexus.test" });
    expect(success).toBeDefined();
    expect(success!.userId).toBe(user.id);
  });

  it("respecte remember : maxAge long + exp long, sinon cookie de session", async () => {
    const user = await makeUser({ email: "remember@nexus.test" });

    await expectLoginRedirect(loginForm(user.email, user.plainPassword!, false));
    const short = await decodeSessionCookie();
    expect(sessionCookie()!.options?.maxAge).toBeUndefined();
    expect(short.remember).toBe(false);
    expect(short.exp - short.iat).toBe(60 * 60 * 15);

    ctx.cookies.clear();

    await expectLoginRedirect(loginForm(user.email, user.plainPassword!, true));
    const long = await decodeSessionCookie();
    expect(sessionCookie()!.options?.maxAge).toBe(60 * 60 * 24 * 60);
    expect(long.remember).toBe(true);
    expect(long.exp - long.iat).toBe(60 * 60 * 24 * 60);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("limitation des tentatives de connexion", () => {
  async function failLogin(email: string) {
    return loginAction(null, loginForm(email, "MauvaisMotDePasse!"));
  }

  it("bloque après 10 échecs sur le MÊME courriel, même avec le bon mot de passe", async () => {
    const user = await makeUser({ email: "cible@nexus.test" });

    for (let i = 0; i < 10; i++) {
      expect(await failLogin(user.email)).toEqual({ error: "invalid" });
    }

    expect(await failLogin(user.email)).toEqual({ error: "throttled" });
    // Le bon mot de passe ne contourne pas la limitation.
    expect(await loginAction(null, loginForm(user.email, user.plainPassword!))).toEqual({
      error: "throttled",
    });
    expect(sessionCookie()).toBeUndefined();

    const [row] = await testDb
      .select()
      .from(loginThrottle)
      .where(eq(loginThrottle.key, `email:${user.email}`));
    expect(row.count).toBeGreaterThanOrEqual(10);
  });

  it("sans en-tête d'IP publique, un AUTRE courriel n'est pas bloqué (régression ::1)", async () => {
    const victime = await makeUser({ email: "victime@nexus.test" });
    const autre = await makeUser({ email: "autre@nexus.test" });

    for (let i = 0; i < 12; i++) await failLogin(victime.email);
    expect(await failLogin(victime.email)).toEqual({ error: "throttled" });

    // Aucune clé par IP ne doit exister : le limiteur par IP est sauté, pas partagé.
    const keys = (await testDb.select().from(loginThrottle)).map((r) => r.key);
    expect(keys).toContain(`email:${victime.email}`);
    expect(keys.filter((k) => k.startsWith("ip:"))).toEqual([]);

    // L'autre utilisateur se connecte normalement.
    await expectLoginRedirect(loginForm(autre.email, autre.plainPassword!));
  });

  it("une IP publique réelle déclenche bien la limitation par IP", async () => {
    ctx.headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    const cible = await makeUser({ email: "ipcible@nexus.test" });

    // 10 courriels DIFFÉRENTS : seul le limiteur par IP peut se déclencher.
    for (let i = 0; i < 10; i++) await failLogin(`inconnu${i}@nexus.test`);

    const [ipRow] = await testDb
      .select()
      .from(loginThrottle)
      .where(eq(loginThrottle.key, "ip:203.0.113.7"));
    expect(ipRow?.count).toBeGreaterThanOrEqual(10);

    // Même avec le bon mot de passe et un courriel jamais utilisé : bloqué.
    expect(await loginAction(null, loginForm(cible.email, cible.plainPassword!))).toEqual({
      error: "throttled",
    });
    expect(sessionCookie()).toBeUndefined();
  });

  it("ignore les IP privées / loopback (aucune clé ip: créée)", async () => {
    ctx.headers = new Headers({ "x-forwarded-for": "::1, 10.0.0.4, 192.168.1.9" });

    for (let i = 0; i < 3; i++) await failLogin(`prive${i}@nexus.test`);

    const keys = (await testDb.select().from(loginThrottle)).map((r) => r.key);
    expect(keys.filter((k) => k.startsWith("ip:"))).toEqual([]);
  });

  it("laisse repasser les tentatives une fois la fenêtre expirée", async () => {
    const user = await makeUser({ email: "fenetre@nexus.test" });
    for (let i = 0; i < 10; i++) await failLogin(user.email);
    expect(await failLogin(user.email)).toEqual({ error: "throttled" });

    // Fenêtre = 15 min : on avance l'horloge de 16 min.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));

    await expectLoginRedirect(loginForm(user.email, user.plainPassword!));
    expect(sessionCookie()).toBeDefined();
  });

  it("une rafale SIMULTANÉE ne dépasse pas la limite (compteur atomique)", async () => {
    const user = await makeUser({ email: "rafale@nexus.test" });

    const results = await Promise.all(
      Array.from({ length: 30 }, () => failLogin(user.email)),
    );

    // Exactement 10 tentatives ont été vérifiées, les 20 autres refusées d'emblée.
    expect(results.filter((r) => r?.error === "invalid")).toHaveLength(10);
    expect(results.filter((r) => r?.error === "throttled")).toHaveLength(20);

    const [row] = await testDb
      .select()
      .from(loginThrottle)
      .where(eq(loginThrottle.key, `email:${user.email}`));
    expect(row.count).toBe(30);
    expect(sessionCookie()).toBeUndefined();
  });

  it("les connexions RÉUSSIES ne consomment pas de tentatives (bureau derrière une même IP)", async () => {
    ctx.headers = new Headers({ "x-forwarded-for": "203.0.113.42" });
    const equipe = await Promise.all(
      Array.from({ length: 3 }, (_, i) => makeUser({ email: `equipe${i}@nexus.test` })),
    );

    // 12 connexions réussies depuis la même IP publique : toutes passent.
    for (let i = 0; i < 12; i++) {
      const u = equipe[i % equipe.length];
      ctx.cookies.clear();
      await expectLoginRedirect(loginForm(u.email, u.plainPassword!));
    }

    const rows = await testDb.select().from(loginThrottle);
    for (const row of rows) expect(row.count).toBe(0);

    // Et un échec isolé se compte toujours, sans être gonflé par les succès.
    expect(await failLogin(equipe[0].email)).toEqual({ error: "invalid" });
    const [ipRow] = await testDb
      .select()
      .from(loginThrottle)
      .where(eq(loginThrottle.key, "ip:203.0.113.42"));
    expect(ipRow.count).toBe(1);
  });

  it("une connexion réussie purge les lignes du limiteur expirées depuis plus d'un jour", async () => {
    const user = await makeUser({ email: "purge@nexus.test" });
    const now = Date.now();
    await testDb.insert(loginThrottle).values([
      { key: "email:vieux@nexus.test", count: 10, resetAt: new Date(now - 2 * 24 * 60 * 60_000) },
      { key: "ip:198.51.100.9", count: 3, resetAt: new Date(now - 25 * 60 * 60_000) },
      { key: "email:recent@nexus.test", count: 10, resetAt: new Date(now - 60 * 60_000) },
      { key: "reset-mail:actif@nexus.test", count: 2, resetAt: new Date(now + 10 * 60_000) },
    ]);

    await expectLoginRedirect(loginForm(user.email, user.plainPassword!));

    const keys = (await testDb.select().from(loginThrottle)).map((r) => r.key).sort();
    expect(keys).toEqual(
      ["email:recent@nexus.test", `email:${user.email}`, "reset-mail:actif@nexus.test"].sort(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("sessions (JWT + gardes)", () => {
  it("un JWT valide résout vers l'utilisateur", async () => {
    const user = await makeUser({ email: "session@nexus.test", role: "admin" });
    await createSession({ uid: user.id, role: "admin", tv: user.tokenVersion, remember: false });

    expect(await readSession()).toMatchObject({ uid: user.id, role: "admin" });
    const current = await getCurrentUser();
    expect(current?.id).toBe(user.id);
    expect(await requireUser()).toMatchObject({ id: user.id });
    expect(await requireAdmin()).toMatchObject({ id: user.id });
  });

  it("rejette une signature falsifiée", async () => {
    const user = await makeUser({ email: "tamper@nexus.test" });
    await createSession({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false });

    const token = sessionCookie()!.value;
    const [h, p, s] = token.split(".");
    const flipped = s.slice(0, -3) + (s.endsWith("AAA") ? "BBB" : "AAA");
    putCookie(`${h}.${p}.${flipped}`);

    expect(await readSession()).toBeNull();
    expect(await getCurrentUser()).toBeNull();
  });

  it("rejette une charge utile modifiée (élévation de privilège)", async () => {
    const user = await makeUser({ email: "escalate@nexus.test", role: "caller" });
    await createSession({ uid: user.id, role: "caller", tv: user.tokenVersion, remember: false });
    const token = sessionCookie()!.value;
    const [h, , s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ uid: user.id, role: "admin", tv: user.tokenVersion, remember: false }),
    ).toString("base64url");

    putCookie(`${h}.${forged}.${s}`);

    expect(await readSession()).toBeNull();
    expect(await getCurrentUser()).toBeNull();
  });

  it("rejette un jeton expiré", async () => {
    const user = await makeUser({ email: "expired@nexus.test" });
    const token = await new SignJWT({
      uid: user.id,
      role: user.role,
      tv: user.tokenVersion,
      remember: false,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(SECRET());
    putCookie(token);

    expect(await readSession()).toBeNull();
    expect(await getCurrentUser()).toBeNull();
  });

  it("rejette un jeton signé avec un autre secret", async () => {
    const user = await makeUser({ email: "othersecret@nexus.test" });
    const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode("un-tout-autre-secret-de-32-octets!!"));
    putCookie(token);

    expect(await getCurrentUser()).toBeNull();
  });

  it("rejette un tokenVersion périmé (révocation de session)", async () => {
    const user = await makeUser({ email: "tv@nexus.test" });
    putCookie(await signToken({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false }));
    expect(await getCurrentUser()).not.toBeNull();

    // Ce que fait la désactivation / réinitialisation de mot de passe.
    await testDb
      .update(users)
      .set({ tokenVersion: user.tokenVersion + 1 })
      .where(eq(users.id, user.id));

    expect(await readSession()).not.toBeNull(); // le JWT reste valide…
    expect(await getCurrentUser()).toBeNull(); // …mais la session est révoquée.
  });

  it("rejette la session d'un utilisateur devenu inactif", async () => {
    const user = await makeUser({ email: "deactivated@nexus.test" });
    putCookie(await signToken({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false }));

    await testDb.update(users).set({ isActive: false }).where(eq(users.id, user.id));

    expect(await getCurrentUser()).toBeNull();
  });

  it("rejette une session pointant vers un utilisateur supprimé", async () => {
    const user = await makeUser({ email: "ghost@nexus.test" });
    putCookie(await signToken({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false }));
    await testDb.delete(users).where(eq(users.id, user.id));

    expect(await getCurrentUser()).toBeNull();
  });

  it("destroySession supprime le cookie", async () => {
    const user = await makeUser({ email: "logout@nexus.test" });
    await createSession({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: true });
    expect(sessionCookie()).toBeDefined();

    await destroySession();

    expect(sessionCookie()).toBeUndefined();
    expect(await getCurrentUser()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("mot de passe oublié — demande", () => {
  function resetForm(email: string) {
    return form({ email });
  }

  function tokenFromLastEmail(): string {
    expect(sentEmails).toHaveLength(1);
    const match = sentEmails[0].text.match(/reset-password\?token=([A-Za-z0-9_-]+)/);
    expect(match, "aucun lien de réinitialisation dans le courriel").not.toBeNull();
    return match![1];
  }

  it("crée un jeton haché et envoie exactement un courriel", async () => {
    const user = await makeUser({ email: "forgot@nexus.test", name: "Alex" });

    const res = await requestResetAction(null, resetForm(user.email));

    expect(res).toEqual({ done: true });
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe(user.email);

    const rows = await testDb.select().from(passwordResets);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(user.id);
    expect(rows[0].usedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

    const token = tokenFromLastEmail();
    expect(rows[0].tokenHash).toBe(sha256Hex(token));
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await auditActions()).toContain("password.reset_requested");
  });

  it("ne stocke JAMAIS le jeton en clair en base", async () => {
    const user = await makeUser({ email: "plain@nexus.test" });
    await requestResetAction(null, resetForm(user.email));
    const token = tokenFromLastEmail();

    const rows = await sqlRaw<{ blob: string }[]>`
      select row_to_json(t)::text as blob from password_resets t
      union all select row_to_json(t)::text from audit_logs t
      union all select row_to_json(t)::text from users t
      union all select row_to_json(t)::text from notifications t
      union all select row_to_json(t)::text from settings t
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.blob.includes(token))).toBe(false);
  });

  it("répond la même chose pour un courriel inconnu et ne crée rien", async () => {
    const known = await makeUser({ email: "existe@nexus.test" });
    const okKnown = await requestResetAction(null, resetForm(known.email));
    sentEmails.length = 0;

    const okUnknown = await requestResetAction(null, resetForm("jamais-vu@nexus.test"));

    expect(okUnknown).toEqual(okKnown);
    expect(okUnknown).toEqual({ done: true });
    expect(sentEmails).toHaveLength(0);
    expect(await testDb.select().from(passwordResets)).toHaveLength(1); // seulement celui du connu
  });

  it("ne crée rien pour un compte désactivé mais répond succès", async () => {
    const user = await makeUser({ email: "inactif@nexus.test", isActive: false });

    expect(await requestResetAction(null, resetForm(user.email))).toEqual({ done: true });

    expect(sentEmails).toHaveLength(0);
    expect(await testDb.select().from(passwordResets)).toHaveLength(0);
  });

  it("répond AUSSI succès quand l'envoi du courriel échoue (pas d'oracle), et le consigne", async () => {
    const user = await makeUser({ email: "rebond@nexus.test" });
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("Resend 403: sandbox sender"));

    const res = await requestResetAction(null, resetForm(user.email));

    // Même réponse que pour un compte inconnu : l'échec d'envoi ne révèle rien.
    expect(res).toEqual({ done: true });
    expect(sentEmails).toHaveLength(0);

    const actions = await auditActions();
    expect(actions).toContain("password.reset_email_failed");
    expect(actions).not.toContain("password.reset_requested");
    const rows = await testDb.select().from(auditLogs);
    const failed = rows.find((r) => r.action === "password.reset_email_failed");
    expect(failed!.userId).toBe(user.id);
    expect(failed!.detail).toMatchObject({ message: expect.stringContaining("Resend 403") });
  });

  it("limite les demandes répétées (5 par fenêtre)", async () => {
    const user = await makeUser({ email: "spam@nexus.test" });

    for (let i = 0; i < 5; i++) {
      expect(await requestResetAction(null, resetForm(user.email))).toEqual({ done: true });
    }

    expect(await requestResetAction(null, resetForm(user.email))).toEqual({ error: "throttled" });
    expect(sentEmails).toHaveLength(5);
    expect(await testDb.select().from(passwordResets)).toHaveLength(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("mot de passe oublié — application", () => {
  const NEW_PASSWORD = "UnNouveauMotDePasse!42";

  async function requestToken(email: string): Promise<string> {
    const before = sentEmails.length;
    await requestResetAction(null, form({ email }));
    expect(sentEmails.length).toBe(before + 1);
    const match = sentEmails[sentEmails.length - 1].text.match(
      /reset-password\?token=([A-Za-z0-9_-]+)/,
    );
    return match![1];
  }

  function applyForm(token: string, password: string, confirm = password) {
    return form({ token, password, confirm });
  }

  it("change le mot de passe, incrémente tokenVersion et marque le jeton utilisé", async () => {
    const user = await makeUser({ email: "apply@nexus.test" });
    const token = await requestToken(user.email);

    // Session ouverte avant la réinitialisation.
    putCookie(await signToken({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false }));
    expect(await getCurrentUser()).not.toBeNull();

    const res = await applyResetAction(null, applyForm(token, NEW_PASSWORD));

    expect(res).toEqual({ done: true });
    const [row] = await testDb.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash)).toBe(true);
    expect(await verifyPassword(user.plainPassword!, row.passwordHash)).toBe(false);
    expect(row.tokenVersion).toBe(user.tokenVersion + 1);

    const [reset] = await testDb.select().from(passwordResets);
    expect(reset.usedAt).toBeInstanceOf(Date);

    // La session ouverte est morte.
    expect(await getCurrentUser()).toBeNull();
    expect(await auditActions()).toContain("password.reset_completed");

    // Et le nouveau mot de passe permet de se connecter.
    ctx.cookies.clear();
    await expectLoginRedirect(loginForm(user.email, NEW_PASSWORD));
  });

  it("invalide les AUTRES jetons en cours du même utilisateur", async () => {
    const user = await makeUser({ email: "multi@nexus.test" });
    const first = await requestToken(user.email);
    const second = await requestToken(user.email);
    expect(first).not.toBe(second);

    expect(await applyResetAction(null, applyForm(second, NEW_PASSWORD))).toEqual({ done: true });

    const rows = await testDb.select().from(passwordResets);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.usedAt !== null)).toBe(true);

    // Le premier jeton ne sert plus.
    expect(await applyResetAction(null, applyForm(first, "EncoreUnAutre!99"))).toEqual({
      error: "invalid_token",
    });
  });

  it("refuse un jeton déjà utilisé", async () => {
    const user = await makeUser({ email: "reuse@nexus.test" });
    const token = await requestToken(user.email);
    expect(await applyResetAction(null, applyForm(token, NEW_PASSWORD))).toEqual({ done: true });

    const res = await applyResetAction(null, applyForm(token, "SecondEssai!4242"));

    expect(res).toEqual({ error: "invalid_token" });
    const [row] = await testDb.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash)).toBe(true);
  });

  it("refuse un jeton expiré", async () => {
    const user = await makeUser({ email: "vieux@nexus.test" });
    const token = "un-jeton-expire-quelconque";
    await testDb.insert(passwordResets).values({
      userId: user.id,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() - 60_000),
    });

    expect(await applyResetAction(null, applyForm(token, NEW_PASSWORD))).toEqual({
      error: "invalid_token",
    });
    const [row] = await testDb.select().from(users).where(eq(users.id, user.id));
    expect(row.tokenVersion).toBe(user.tokenVersion);
  });

  it("refuse un jeton inconnu ou vide", async () => {
    await makeUser({ email: "garbage@nexus.test" });

    expect(await applyResetAction(null, applyForm("n-importe-quoi", NEW_PASSWORD))).toEqual({
      error: "invalid_token",
    });
    expect(await applyResetAction(null, applyForm("", NEW_PASSWORD))).toEqual({
      error: "invalid_token",
    });
  });

  it("refuse un mot de passe de moins de 10 caractères", async () => {
    const user = await makeUser({ email: "court@nexus.test" });
    const token = await requestToken(user.email);

    expect(await applyResetAction(null, applyForm(token, "court1234"))).toEqual({ error: "weak" });

    const [reset] = await testDb.select().from(passwordResets);
    expect(reset.usedAt).toBeNull(); // le jeton reste utilisable
  });

  it("refuse une confirmation différente", async () => {
    const user = await makeUser({ email: "mismatch@nexus.test" });
    const token = await requestToken(user.email);

    expect(
      await applyResetAction(null, applyForm(token, NEW_PASSWORD, "PasLeMemeMotDePasse!1")),
    ).toEqual({ error: "mismatch" });

    const [row] = await testDb.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword(user.plainPassword!, row.passwordHash)).toBe(true);
  });

  it("refuse la réinitialisation pour un compte désactivé entre-temps", async () => {
    const user = await makeUser({ email: "desactive-apres@nexus.test" });
    const token = await requestToken(user.email);
    await testDb.update(users).set({ isActive: false }).where(eq(users.id, user.id));

    expect(await applyResetAction(null, applyForm(token, NEW_PASSWORD))).toEqual({
      error: "invalid_token",
    });
    const [row] = await testDb.select().from(users).where(eq(users.id, user.id));
    expect(await bcrypt.compare(NEW_PASSWORD, row.passwordHash)).toBe(false);
  });
});
