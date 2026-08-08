/**
 * Intégration — « Mon profil » : mise à jour nom/courriel et changement de mot
 * de passe par leur détenteur (tous rôles). Vrais handlers + vrai garde RBAC.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs, users } from "@/db/schema";

const CTX = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  hdrs: new Headers(),
}));

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
const { verifyPassword } = await import("@/lib/auth/password");

async function login(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  const token = await new SignJWT({
    uid: user.id,
    role: user.role,
    tv: user.tokenVersion,
    remember: true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  CTX.jar.set("nexus_session", token);
}

describe("mon profil", () => {
  afterAll(closeDb);
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
  });

  it("refuse un visiteur non connecté", async () => {
    expect(await actions.updateProfileAction({ name: "X", email: "x@test.local" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await actions.changePasswordAction({ current: "a", next: "12345678" })).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("un téléphoniste met à jour SON nom et courriel, avec audit", async () => {
    const caller = await makeUser({ role: "caller", name: "Avant", email: "avant@test.local" });
    await login(caller);

    const res = await actions.updateProfileAction({
      name: "Après",
      email: "APRES@test.local",
    });
    expect(res).toEqual({ ok: true });

    const [row] = await testDb.select().from(users).where(eq(users.id, caller.id));
    expect(row.name).toBe("Après");
    // Le courriel est normalisé en minuscules (identifiant de connexion).
    expect(row.email).toBe("apres@test.local");

    const audits = await testDb
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "user.update"), eq(auditLogs.entityId, caller.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(caller.id);
    expect(audits[0].detail).toMatchObject({ self: true });
  });

  it("refuse un courriel déjà pris par un autre compte", async () => {
    const other = await makeUser({ email: "pris@test.local" });
    const me = await makeUser({ email: "moi@test.local" });
    void other;
    await login(me);

    expect(await actions.updateProfileAction({ name: "Moi", email: "pris@test.local" })).toEqual({
      ok: false,
      error: "emailTaken",
    });
    // Reprendre son PROPRE courriel n'est pas un conflit.
    expect(await actions.updateProfileAction({ name: "Moi", email: "moi@test.local" })).toEqual({
      ok: true,
    });
  });

  it("change le mot de passe seulement si l'actuel est correct", async () => {
    const me = await makeUser({});
    await login(me);

    expect(
      await actions.changePasswordAction({ current: "mauvais", next: "NouveauPass1" }),
    ).toEqual({ ok: false, error: "wrongPassword" });
    expect(await actions.changePasswordAction({ current: me.plainPassword!, next: "court" })).toEqual(
      { ok: false, error: "invalid" },
    );

    const res = await actions.changePasswordAction({
      current: me.plainPassword!,
      next: "NouveauPass1",
    });
    expect(res).toEqual({ ok: true });

    const [row] = await testDb.select().from(users).where(eq(users.id, me.id));
    expect(await verifyPassword("NouveauPass1", row.passwordHash)).toBe(true);

    const audits = await testDb
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "user.password_change"), eq(auditLogs.entityId, me.id)));
    expect(audits).toHaveLength(1);
  });
});
