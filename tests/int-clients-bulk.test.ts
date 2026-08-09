/**
 * Intégration — actions en masse de la vue tableau (assigner / catégoriser /
 * supprimer) et tri de GET /api/clients/list.
 *
 * Vrais handlers + vrai garde RBAC (JWT nexus_session) : un téléphoniste doit
 * être refusé PAR LE SERVEUR, pas seulement privé du bouton. Seul Google
 * (réseau externe) est simulé.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { SignJWT } from "jose";
import { closeDb, makeCategory, makeClient, makeUser, resetDb, testDb } from "./helpers/db";
import { auditLogs, clients } from "@/db/schema";
import { BULK_MAX } from "@/lib/bulk";

// ── Stubs de contexte Next + réseau externe ─────────────────────────────────

const CTX = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  hdrs: new Headers(),
  cancelEvent: vi.fn(async (_id: string) => {}),
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
vi.mock("@/lib/google", () => ({
  cancelEvent: (id: string) => CTX.cancelEvent(id),
  GoogleNotConnectedError: class GoogleNotConnectedError extends Error {},
}));

const actions = await import("@/app/(app)/clients/actions");
const { GET: listGET } = await import("@/app/api/clients/list/route");
const { NextRequest } = await import("next/server");

// ── Helpers ─────────────────────────────────────────────────────────────────

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

async function listItems(query: string) {
  const res = await listGET(
    new NextRequest(new URL(`http://localhost/api/clients/list?${query}`)),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    items: Array<{
      id: string;
      fullName: string;
      email: string | null;
      sourceId: number | null;
      assignedToId: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    total: number;
  };
}

async function bulkAuditRows(action: string) {
  return testDb
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entity, "client")));
}

describe("actions en masse", () => {
  afterAll(closeDb);
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
    CTX.cancelEvent.mockClear();
  });

  describe("bulkAssignClientsAction", () => {
    it("refuse un téléphoniste (protection serveur, pas seulement l'UI)", async () => {
      const caller = await makeUser({ role: "caller" });
      const c = await makeClient();
      await login(caller);
      const res = await actions.bulkAssignClientsAction([c.id], caller.id);
      expect(res).toEqual({ ok: false, error: "forbidden" });
    });

    it("assigne plusieurs fiches et journalise UNE ligne d'audit PAR fiche", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ role: "caller", name: "Téléphoniste" });
      const a = await makeClient();
      const b = await makeClient();
      const untouched = await makeClient({ assignedToId: target.id });
      await login(admin);

      const res = await actions.bulkAssignClientsAction([a.id, b.id, untouched.id], target.id);
      // `untouched` avait déjà cet assigné : non compté, pas de ligne d'audit.
      expect(res).toEqual({ ok: true, count: 2 });

      const rows = await testDb.select().from(clients).where(inArray(clients.id, [a.id, b.id]));
      expect(rows.every((r) => r.assignedToId === target.id)).toBe(true);

      const audits = await bulkAuditRows("client.assign");
      expect(audits).toHaveLength(2);
      expect(new Set(audits.map((x) => x.entityId))).toEqual(new Set([a.id, b.id]));
      for (const entry of audits) {
        expect(entry.userId).toBe(admin.id);
        expect(entry.detail).toMatchObject({ bulk: true, to: target.id });
      }
    });

    it("désassigne avec null et revient à count 0 quand rien ne change", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ role: "caller" });
      const c = await makeClient({ assignedToId: target.id });
      await login(admin);

      expect(await actions.bulkAssignClientsAction([c.id], null)).toEqual({ ok: true, count: 1 });
      const [row] = await testDb.select().from(clients).where(eq(clients.id, c.id));
      expect(row.assignedToId).toBeNull();

      // Répéter la même action : plus rien à changer, pas de nouvel audit.
      expect(await actions.bulkAssignClientsAction([c.id], null)).toEqual({ ok: true, count: 0 });
      expect(await bulkAuditRows("client.assign")).toHaveLength(1);
    });

    it("valide les entrées : liste vide, id non-UUID, cible inconnue", async () => {
      const admin = await makeUser({ role: "admin" });
      const c = await makeClient();
      await login(admin);

      expect(await actions.bulkAssignClientsAction([], null)).toEqual({
        ok: false,
        error: "invalid",
      });
      expect(await actions.bulkAssignClientsAction(["pas-un-uuid"], null)).toEqual({
        ok: false,
        error: "invalid",
      });
      expect(
        await actions.bulkAssignClientsAction([c.id], "00000000-0000-4000-8000-000000000000"),
      ).toEqual({ ok: false, error: "notFound" });
    });
  });

  describe("bulkSetClientsCategoryAction", () => {
    it("refuse un téléphoniste", async () => {
      const caller = await makeUser({ role: "caller" });
      const c = await makeClient();
      await login(caller);
      const res = await actions.bulkSetClientsCategoryAction([c.id], null);
      expect(res).toEqual({ ok: false, error: "forbidden" });
    });

    it("reclasse plusieurs fiches, audit par fiche, catégorie inconnue refusée", async () => {
      const admin = await makeUser({ role: "admin" });
      const cat = await makeCategory({ nameFr: "Chaud", nameEn: "Hot" });
      const a = await makeClient();
      const b = await makeClient();
      await login(admin);

      expect(await actions.bulkSetClientsCategoryAction([a.id, b.id], cat.id)).toEqual({
        ok: true,
        count: 2,
      });
      const rows = await testDb.select().from(clients).where(inArray(clients.id, [a.id, b.id]));
      expect(rows.every((r) => r.categoryId === cat.id)).toBe(true);

      const audits = await bulkAuditRows("client.category");
      expect(audits).toHaveLength(2);
      expect(audits.every((x) => (x.detail as { bulk?: boolean }).bulk === true)).toBe(true);

      expect(await actions.bulkSetClientsCategoryAction([a.id], 99_999)).toEqual({
        ok: false,
        error: "notFound",
      });
    });
  });

  describe("bulkDeleteClientsAction", () => {
    it("refuse un téléphoniste", async () => {
      const caller = await makeUser({ role: "caller" });
      const c = await makeClient();
      await login(caller);
      expect(await actions.bulkDeleteClientsAction([c.id])).toEqual({
        ok: false,
        error: "forbidden",
      });
      // La fiche est toujours là.
      expect(await testDb.select().from(clients).where(eq(clients.id, c.id))).toHaveLength(1);
    });

    it("supprime en masse, annule les événements Google et audite chaque fiche", async () => {
      const admin = await makeUser({ role: "admin" });
      const a = await makeClient({ fullName: "À supprimer A" });
      const b = await makeClient({ fullName: "À supprimer B" });
      const keep = await makeClient({ fullName: "À garder" });
      // Un RDV planifié avec événement Google : la suppression doit prévenir l'agenda.
      const { appointments } = await import("@/db/schema");
      await testDb.insert(appointments).values({
        clientId: a.id,
        userId: admin.id,
        title: "RDV",
        type: "inperson",
        status: "scheduled",
        startsAt: new Date(Date.now() + 3600_000),
        endsAt: new Date(Date.now() + 7200_000),
        googleEventId: "gcal-évent-1",
      });
      await login(admin);

      const res = await actions.bulkDeleteClientsAction([a.id, b.id]);
      expect(res).toEqual({ ok: true, count: 2 });
      expect(CTX.cancelEvent).toHaveBeenCalledWith("gcal-évent-1");

      const remaining = await testDb.select().from(clients);
      expect(remaining.map((r) => r.id)).toEqual([keep.id]);

      const audits = await bulkAuditRows("client.delete");
      expect(audits).toHaveLength(2);
      expect(audits.every((x) => (x.detail as { bulk?: boolean }).bulk === true)).toBe(true);
    });

    it("supprime un lot plein (BULK_MAX) en une passe, avec un audit par fiche", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);
      // Lot plein : c'est la taille qu'envoie l'UI quand la sélection dépasse
      // la limite (elle découpe). Autrefois chaque fiche coûtait plusieurs
      // allers-retours ; la suppression est désormais ensembliste.
      const made = [];
      for (let i = 0; i < BULK_MAX; i++) {
        made.push(await makeClient({ phone: `+1418555${String(1000 + i).padStart(4, "0")}` }));
      }
      const keep = await makeClient({ phone: "+15145559999" });

      const res = await actions.bulkDeleteClientsAction(made.map((c) => c.id));
      expect(res).toEqual({ ok: true, count: BULK_MAX });

      const remaining = await testDb.select().from(clients);
      expect(remaining.map((r) => r.id)).toEqual([keep.id]);
      // Traçabilité : une entrée d'audit par fiche, pas une seule pour le lot.
      expect(await bulkAuditRows("client.delete")).toHaveLength(BULK_MAX);
    });

    it("au-delà de BULK_MAX, refuse explicitement plutôt que de supprimer à moitié", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);
      const a = await makeClient();
      const tooMany = [
        ...Array.from({ length: BULK_MAX }, () => crypto.randomUUID()),
        a.id,
      ];

      expect(await actions.bulkDeleteClientsAction(tooMany)).toEqual({
        ok: false,
        error: "invalid",
      });
      // Rien n'a été supprimé : l'UI doit découper, pas envoyer un lot trop gros.
      expect(await testDb.select().from(clients).where(eq(clients.id, a.id))).toHaveLength(1);
    });
  });

  describe("GET /api/clients/list — tri et champs de la vue tableau", () => {
    it("expose email / source / assigné / créée / modifiée et trie par colonne", async () => {
      const admin = await makeUser({ role: "admin" });
      const t0 = new Date("2026-01-01T12:00:00Z");
      const t1 = new Date("2026-02-01T12:00:00Z");
      const t2 = new Date("2026-03-01T12:00:00Z");
      await makeClient({ fullName: "Bruno", email: "b@test.local", createdAt: t1, updatedAt: t1 });
      await makeClient({ fullName: "Alice", createdAt: t2, updatedAt: t0 });
      await makeClient({ fullName: "Chantal", createdAt: t0, updatedAt: t2 });
      await login(admin);

      const byName = await listItems("sort=name&dir=asc");
      expect(byName.items.map((i) => i.fullName)).toEqual(["Alice", "Bruno", "Chantal"]);
      expect(byName.items[1].email).toBe("b@test.local");
      expect(byName.items[1].createdAt).toBe(t1.toISOString());
      expect(byName.items[1].updatedAt).toBe(t1.toISOString());

      const byCreated = await listItems("sort=createdAt&dir=asc");
      expect(byCreated.items.map((i) => i.fullName)).toEqual(["Chantal", "Bruno", "Alice"]);

      const byUpdatedDesc = await listItems("sort=updatedAt&dir=desc");
      expect(byUpdatedDesc.items.map((i) => i.fullName)).toEqual(["Chantal", "Bruno", "Alice"]);

      // Paramètre inconnu : retombe sur l'ordre « activité » sans erreur.
      const fallback = await listItems("sort=drop%20table&dir=asc");
      expect(fallback.total).toBe(3);
    });
  });
});
