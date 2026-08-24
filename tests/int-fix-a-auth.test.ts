/**
 * Intégration — correctifs d'audit, grappe « auth » :
 *  - la connexion compare TOUJOURS un bcrypt (empreinte factice si le compte
 *    n'existe pas) : le temps de réponse ne trahit pas l'existence d'une adresse ;
 *  - POST /api/admin/password révoque les AUTRES sessions (tokenVersion) et
 *    réémet le cookie du navigateur courant.
 *
 * Vraie base, vrais gardes, vrais JWT ; seuls next/headers et le réseau sont simulés.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs, users } from "@/db/schema";

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, { name: string; value: string; options?: Record<string, unknown> }>(),
  headers: new Headers(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const c = ctx.cookies.get(name);
      return c ? { name, value: c.value } : undefined;
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

// verifyPassword reste le vrai bcrypt, simplement espionné.
vi.mock("@/lib/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/password")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const fetchSpy = vi.fn(async () => {
  throw new Error("réseau interdit dans les tests");
});
vi.stubGlobal("fetch", fetchSpy);

import { loginAction } from "@/app/(auth)/login/actions";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/lib/auth/password";
import { getCurrentUser } from "@/lib/auth/guards";
import { readSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";

const passwordRoute = await import("@/app/api/admin/password/route");

const SECRET = () => new TextEncoder().encode(process.env.AUTH_SECRET!);

function loginForm(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

async function loginAs(
  user: { id: string; role: "admin" | "caller"; tokenVersion: number },
  remember = true,
): Promise<string> {
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(SECRET());
  ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: token });
  return token;
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/admin/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  ctx.cookies.clear();
  ctx.headers = new Headers();
  vi.mocked(verifyPassword).mockClear();
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("connexion — pas d'oracle temporel sur l'existence du compte", () => {
  it("compare un bcrypt même pour un courriel INCONNU (empreinte factice)", async () => {
    const res = await loginAction(null, loginForm("personne@nexus.test", "MotDePasse!"));

    expect(res).toEqual({ error: "invalid" });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith("MotDePasse!", DUMMY_PASSWORD_HASH);
    expect(ctx.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("compare contre le VRAI hash pour un compte connu (mauvais mot de passe)", async () => {
    const user = await makeUser({ email: "connu@nexus.test" });

    const res = await loginAction(null, loginForm(user.email, "MotDePasse!"));

    expect(res).toEqual({ error: "invalid" });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith("MotDePasse!", user.passwordHash);
  });

  it("l'empreinte factice est un bcrypt de coût 12, comme hashPassword", async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
    // Et elle ne valide évidemment aucun mot de passe plausible.
    expect(await verifyPassword("", DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword("nexus-dummy", DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it("ne compare rien quand la tentative est refusée par le limiteur", async () => {
    const user = await makeUser({ email: "limite@nexus.test" });
    for (let i = 0; i < 10; i++) await loginAction(null, loginForm(user.email, "x"));
    vi.mocked(verifyPassword).mockClear();

    expect(await loginAction(null, loginForm(user.email, "x"))).toEqual({ error: "throttled" });
    expect(verifyPassword).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /api/admin/password — révocation des autres sessions", () => {
  it("incrémente tokenVersion, réémet le cookie courant et tue les autres jetons", async () => {
    const admin = await makeUser({ role: "admin", email: "admin@nexus.test" });
    const stolen = await loginAs(admin, true);

    const res = await passwordRoute.POST(
      jsonRequest({ current: admin.plainPassword!, next: "NouveauMotDePasse!42" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [row] = await testDb.select().from(users).where(eq(users.id, admin.id));
    expect(row.tokenVersion).toBe(admin.tokenVersion + 1);
    expect(await verifyPassword("NouveauMotDePasse!42", row.passwordHash)).toBe(true);

    // Le navigateur courant a un nouveau cookie (remember conservé) qui résout.
    const fresh = ctx.cookies.get(SESSION_COOKIE_NAME)!;
    expect(fresh.value).not.toBe(stolen);
    expect(fresh.options).toMatchObject({ httpOnly: true, maxAge: 60 * 60 * 24 * 60 });
    expect(await readSession()).toMatchObject({ uid: admin.id, tv: admin.tokenVersion + 1, remember: true });
    expect((await getCurrentUser())?.id).toBe(admin.id);

    // L'ancien jeton (cookie volé, autre appareil) est refusé par les gardes.
    ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: stolen });
    expect(await getCurrentUser()).toBeNull();

    const audits = await testDb.select().from(auditLogs);
    expect(audits.map((a) => a.action)).toContain("user.password_change");
  });

  it("un mauvais mot de passe actuel ne change rien (ni hash, ni tokenVersion, ni cookie)", async () => {
    const admin = await makeUser({ role: "admin" });
    const before = await loginAs(admin);

    const res = await passwordRoute.POST(jsonRequest({ current: "mauvais", next: "NouveauMotDePasse!42" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "wrong_password" });

    const [row] = await testDb.select().from(users).where(eq(users.id, admin.id));
    expect(row.tokenVersion).toBe(admin.tokenVersion);
    expect(row.passwordHash).toBe(admin.passwordHash);
    expect(ctx.cookies.get(SESSION_COOKIE_NAME)!.value).toBe(before);
  });

  it("une session « non mémorisée » est réémise comme cookie de session", async () => {
    const admin = await makeUser({ role: "admin" });
    await loginAs(admin, false);

    const res = await passwordRoute.POST(
      jsonRequest({ current: admin.plainPassword!, next: "NouveauMotDePasse!42" }),
    );
    expect(res.status).toBe(200);

    const fresh = ctx.cookies.get(SESSION_COOKIE_NAME)!;
    expect(fresh.options?.maxAge).toBeUndefined();
    expect(await readSession()).toMatchObject({ remember: false, tv: admin.tokenVersion + 1 });
  });

  it("un téléphoniste est refusé (403) sans rien toucher", async () => {
    const caller = await makeUser({ role: "caller" });
    await loginAs(caller);

    const res = await passwordRoute.POST(
      jsonRequest({ current: caller.plainPassword!, next: "NouveauMotDePasse!42" }),
    );
    expect(res.status).toBe(403);
    const [row] = await testDb.select().from(users).where(eq(users.id, caller.id));
    expect(row.tokenVersion).toBe(caller.tokenVersion);
  });
});
