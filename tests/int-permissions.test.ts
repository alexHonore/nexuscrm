/**
 * Tests d'intégration — les droits configurables, du réglage jusqu'au refus.
 *
 * `unit-permissions.test.ts` vérifie la matrice ; ici on vérifie qu'elle est
 * VRAIMENT interrogée : une session réelle, une configuration réelle en base,
 * les vraies actions serveur. Une matrice juste que personne n'interroge est le
 * pire des deux mondes — l'écran promet un cloisonnement qui n'existe pas.
 *
 * Seuls next/headers, next/cache et le réseau externe sont simulés.
 */
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";
import { clients, settings, users } from "@/db/schema";

vi.mock("server-only", () => ({}));

const ctx = vi.hoisted(() => ({
  cookies: new Map<string, { name: string; value: string }>(),
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get(name: string) {
      const c = ctx.cookies.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    getAll() {
      return [...ctx.cookies.values()];
    },
    has(name: string) {
      return ctx.cookies.has(name);
    },
    set(name: string, value: string) {
      ctx.cookies.set(name, { name, value });
    },
    delete(name: string) {
      ctx.cookies.delete(name);
    },
  }),
  headers: async () => ctx.headers,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

vi.stubGlobal("fetch", vi.fn(async () => {
  throw new Error("réseau interdit dans les tests");
}));

import {
  addCommentAction,
  assignClientAction,
  updateClientAction,
} from "@/app/(app)/clients/actions";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import {
  CALLER_ROLE_ID,
  OBSERVER_ROLE_ID,
  SUPERVISOR_ROLE_ID,
  defaultPermissionsConfig,
} from "@/lib/permissions/defaults";
import { getSetting, setSetting } from "@/lib/settings";
import { setUserRole } from "@/lib/permissions/server";
import type { PermissionsConfig } from "@/lib/permissions/types";

type Account = { id: string; role: "admin" | "caller"; tokenVersion: number };

async function loginAs(user: Account | null): Promise<void> {
  ctx.cookies.clear();
  if (!user) return;
  const token = await new SignJWT({ uid: user.id, role: user.role, tv: user.tokenVersion, remember: false })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));
  ctx.cookies.set(SESSION_COOKIE_NAME, { name: SESSION_COOKIE_NAME, value: token });
}

/**
 * Écrit la configuration. Pas de vidage de cache à faire : `cache()` de React
 * ne mémorise rien hors d'une requête, donc chaque appel relit la base — c'est
 * ce qui rend ces tests possibles avec plusieurs sessions dans un même fichier.
 */
async function writeConfig(patch: (cfg: PermissionsConfig) => PermissionsConfig): Promise<void> {
  await setSetting("permissions", patch(defaultPermissionsConfig()));
}

let patron: Awaited<ReturnType<typeof makeUser>>;
let luc: Awaited<ReturnType<typeof makeUser>>;
let marie: Awaited<ReturnType<typeof makeUser>>;
let chef: Awaited<ReturnType<typeof makeUser>>;
let stagiaire: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await resetDb();
  patron = await makeUser({ name: "Alex-Honoré", role: "admin" });
  luc = await makeUser({ name: "Luc", role: "caller" });
  marie = await makeUser({ name: "Marie", role: "caller" });
  chef = await makeUser({ name: "Chef", role: "caller" });
  stagiaire = await makeUser({ name: "Stagiaire", role: "caller" });
  await writeConfig((cfg) => ({
    ...cfg,
    userRoles: {
      [luc.id]: CALLER_ROLE_ID,
      [marie.id]: CALLER_ROLE_ID,
      [chef.id]: SUPERVISOR_ROLE_ID,
      [stagiaire.id]: OBSERVER_ROLE_ID,
    },
  }));
});

afterAll(async () => {
  await closeDb();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("une fiche prise par le patron", () => {
  it("est INTROUVABLE pour un téléphoniste, pas « interdite »", async () => {
    // Un 403 dirait « elle existe » — c'est exactement ce que le réglage cache.
    const fiche = await makeClient({ fullName: "Prospect Chaud", assignedToId: patron.id });
    await loginAs(luc);

    const edit = await updateClientAction(fiche.id, {
      fullName: "Volé",
      phone: "+14185551234",
      language: "fr",
    });
    expect(edit).toEqual({ ok: false, error: "notFound" });

    const comment = await addCommentAction({ clientId: fiche.id, body: "coucou" });
    expect(comment.ok).toBe(false);
    if (!comment.ok) expect(comment.error).toBe("notFound");

    const [row] = await testDb.select().from(clients).where(eq(clients.id, fiche.id));
    expect(row.fullName).toBe("Prospect Chaud");
  });

  it("reste ouverte au superviseur", async () => {
    const fiche = await makeClient({ fullName: "Prospect Chaud", assignedToId: patron.id });
    await loginAs(chef);
    const edit = await updateClientAction(fiche.id, {
      fullName: "Prospect Tiède",
      phone: "+14185551234",
      language: "fr",
    });
    expect(edit.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("la fiche d'un collègue", () => {
  it("se voit sans se toucher", async () => {
    const fiche = await makeClient({ fullName: "Lead de Marie", assignedToId: marie.id });
    await loginAs(luc);
    const edit = await updateClientAction(fiche.id, {
      fullName: "Lead de Luc",
      phone: "+14185551234",
      language: "fr",
    });
    // Visible mais fermée : le refus est le même que pour une fiche absente,
    // et c'est voulu — l'action ne dit jamais pourquoi elle refuse.
    expect(edit.ok).toBe(false);
    const [row] = await testDb.select().from(clients).where(eq(clients.id, fiche.id));
    expect(row.fullName).toBe("Lead de Marie");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("anti-vol de leads", () => {
  it("un téléphoniste prend une fiche du bassin", async () => {
    const fiche = await makeClient({ assignedToId: null });
    await loginAs(luc);
    expect(await assignClientAction(fiche.id, luc.id)).toMatchObject({ ok: true });
    const [row] = await testDb.select().from(clients).where(eq(clients.id, fiche.id));
    expect(row.assignedToId).toBe(luc.id);
  });

  it("il ne prend PAS celle d'un collègue, et rien ne bouge", async () => {
    const fiche = await makeClient({ assignedToId: marie.id, lastContactedAt: new Date() });
    await loginAs(luc);
    const res = await assignClientAction(fiche.id, luc.id);
    expect(res.ok).toBe(false);
    const [row] = await testDb.select().from(clients).where(eq(clients.id, fiche.id));
    expect(row.assignedToId).toBe(marie.id);
  });

  it("il ne distribue pas le travail d'autrui", async () => {
    const fiche = await makeClient({ assignedToId: null });
    await loginAs(luc);
    const res = await assignClientAction(fiche.id, marie.id);
    expect(res.ok).toBe(false);
    const [row] = await testDb.select().from(clients).where(eq(clients.id, fiche.id));
    expect(row.assignedToId).toBeNull();
  });

  it("il rend sa fiche au bassin", async () => {
    const fiche = await makeClient({ assignedToId: luc.id });
    await loginAs(luc);
    expect((await assignClientAction(fiche.id, null)).ok).toBe(true);
    const [row] = await testDb.select().from(clients).where(eq(clients.id, fiche.id));
    expect(row.assignedToId).toBeNull();
  });

  it("le superviseur reprend une fiche déjà prise", async () => {
    const fiche = await makeClient({ assignedToId: marie.id, lastContactedAt: new Date() });
    await loginAs(chef);
    expect((await assignClientAction(fiche.id, chef.id)).ok).toBe(true);
  });

  it("le plafond du rôle arrête la prise dans le bassin", async () => {
    await writeConfig((cfg) => ({
      ...cfg,
      userRoles: { [luc.id]: CALLER_ROLE_ID },
      roles: cfg.roles.map((r) =>
        r.id === CALLER_ROLE_ID ? { ...r, assignment: { ...r.assignment, maxOwned: 1 } } : r,
      ),
    }));
    await makeClient({ assignedToId: luc.id });
    const seconde = await makeClient({ assignedToId: null });
    await loginAs(luc);
    const res = await assignClientAction(seconde.id, luc.id);
    expect(res.ok).toBe(false);
    const [row] = await testDb.select().from(clients).where(eq(clients.id, seconde.id));
    expect(row.assignedToId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("l'observateur", () => {
  it("ne commente pas, ne modifie pas, ne prend rien", async () => {
    const fiche = await makeClient({ assignedToId: stagiaire.id });
    await loginAs(stagiaire);
    expect((await addCommentAction({ clientId: fiche.id, body: "note" })).ok).toBe(false);
    expect(
      (await updateClientAction(fiche.id, { fullName: "X", phone: "+14185551234", language: "fr" })).ok,
    ).toBe(false);
    expect((await assignClientAction(fiche.id, null)).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("le réglage est la source, la base n'est que le plancher", () => {
  it("le rôle administrateur met users.role à « admin », les autres à « caller »", async () => {
    await setUserRole(luc.id, "admin");
    let [row] = await testDb.select().from(users).where(eq(users.id, luc.id));
    expect(row.role).toBe("admin");

    await setUserRole(luc.id, SUPERVISOR_ROLE_ID);
    [row] = await testDb.select().from(users).where(eq(users.id, luc.id));
    expect(row.role).toBe("caller");
  });

  it("une configuration corrompue en base ne rend pas l'application permissive", async () => {
    await testDb
      .insert(settings)
      .values({ key: "permissions", value: { roles: "n'importe quoi" }, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: { roles: "n'importe quoi" }, updatedAt: new Date() },
      });
    const cfg = await getSetting("permissions");
    // Les rôles livrés reviennent : personne ne se retrouve avec tous les droits.
    expect(cfg.roles.find((r) => r.superAdmin)?.id).toBe("admin");
    expect(cfg.defaultRoleId).toBe(CALLER_ROLE_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("sortir des données de l'application", () => {
  /** Le CSV, lu comme un vrai fichier : entêtes + lignes. */
  async function exportCsv(): Promise<string> {
    const mod = await import("@/app/api/admin/export/route");
    const res = await mod.GET(new Request("http://localhost:3000/api/admin/export"));
    if (res.status !== 200) return `HTTP_${res.status}`;
    return await res.text();
  }

  it("un téléphoniste ne télécharge rien du tout", async () => {
    await makeClient({ fullName: "Prospect Chaud", assignedToId: patron.id });
    await loginAs(luc);
    expect(await exportCsv()).toBe("HTTP_403");
  });

  it("le CSV ne contient QUE ce que l'exportateur a le droit de voir", async () => {
    // Un rôle sur mesure : il exporte, mais les fiches du patron lui sont
    // fermées. C'est le cas qui fait peur — le droit d'export ne doit pas
    // servir d'échappatoire à la matrice.
    await writeConfig((cfg) => ({
      ...cfg,
      userRoles: { [luc.id]: CALLER_ROLE_ID },
      roles: cfg.roles.map((r) =>
        r.id === CALLER_ROLE_ID ? { ...r, perms: { ...r.perms, "clients.export": true } } : r,
      ),
    }));
    await makeClient({ fullName: "Fiche du patron", assignedToId: patron.id });
    await makeClient({ fullName: "Fiche de Luc", assignedToId: luc.id });
    await makeClient({ fullName: "Fiche au bassin", assignedToId: null });

    await loginAs(luc);
    const csv = await exportCsv();
    expect(csv).toContain("Fiche de Luc");
    expect(csv).toContain("Fiche au bassin");
    expect(csv).not.toContain("Fiche du patron");
  });

  it("les coordonnées d'une fiche fermée sortent VIDES, pas masquées", async () => {
    // Un masque « •••-4512 » dans un tableur ressemble à un vrai numéro une
    // fois la colonne élargie : on n'écrit rien plutôt qu'un faux.
    await writeConfig((cfg) => ({
      ...cfg,
      userRoles: { [luc.id]: CALLER_ROLE_ID },
      roles: cfg.roles.map((r) =>
        r.id === CALLER_ROLE_ID ? { ...r, perms: { ...r.perms, "clients.export": true } } : r,
      ),
    }));
    await makeClient({ fullName: "Lead de Marie", phone: "+15145550199", assignedToId: marie.id });

    await loginAs(luc);
    const csv = await exportCsv();
    // La fiche du collègue est VISIBLE (on ne la rappelle pas), son numéro non.
    expect(csv).toContain("Lead de Marie");
    expect(csv).not.toContain("5145550199");
    expect(csv).not.toContain("•");
  });

  it("un assistant ne s'emporte pas avec le seul droit de le lire", async () => {
    // Le superviseur livré LIT les assistants et n'a pas « Modifier » : le
    // fichier, qui se réimporte ailleurs, lui est fermé.
    const mod = await import("@/app/api/assistants/[id]/export/route");
    const id = "11111111-2222-4333-8444-555555555555";
    await loginAs(chef);
    const res = await mod.GET(
      new Request(`http://localhost:3000/api/assistants/${id}/export`),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(403);
  });
});
