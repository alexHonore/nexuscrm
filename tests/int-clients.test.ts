/**
 * Intégration — intégrité des données clients : server actions CRUD, relances
 * (nextFollowupAt = plus proche relance OUVERTE), commentaires + mentions,
 * GET /api/clients/list et GET /api/clients/lookup.
 *
 * Vrais handlers + vrai garde RBAC (JWT nexus_session). Seul Google (réseau
 * externe) est simulé.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  closeDb,
  makeCategory,
  makeClient,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";
import {
  appointments,
  auditLogs,
  calls,
  clients,
  comments,
  followups,
  notifications,
  sources,
} from "@/db/schema";

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
// Réseau externe (Google Calendar) — jamais appelé pour de vrai.
vi.mock("@/lib/google", () => ({
  cancelEvent: (id: string) => CTX.cancelEvent(id),
  GoogleNotConnectedError: class GoogleNotConnectedError extends Error {},
}));

const actions = await import("@/app/(app)/clients/actions");
const { GET: listGET } = await import("@/app/api/clients/list/route");
const { GET: lookupGET } = await import("@/app/api/clients/lookup/route");
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

type ListBody = {
  items: { id: string; fullName: string; phone: string; categoryColor: string | null }[];
  total: number;
  page: number;
  pageSize: number;
};

async function list(params: Record<string, string> = {}): Promise<ListBody> {
  const url = new URL("http://localhost/api/clients/list");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await listGET(new NextRequest(url));
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

async function lookup(phone: string) {
  const url = new URL("http://localhost/api/clients/lookup");
  url.searchParams.set("phone", phone);
  const res = await lookupGET(new NextRequest(url));
  expect(res.status).toBe(200);
  return (await res.json()) as { client: null | { id: string; fullName: string; category: unknown } };
}

async function getClient(id: string) {
  const row = await testDb.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!row) throw new Error(`client ${id} introuvable`);
  return row;
}

function form(over: Partial<Parameters<typeof actions.createClientAction>[0]> = {}) {
  return { fullName: "Jean Tremblay", phone: "418-476-1542", language: "fr" as const, ...over };
}

describe("intégrité des données clients", () => {
  afterAll(closeDb);
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
    CTX.hdrs = new Headers();
    CTX.cancelEvent.mockClear();
    CTX.cancelEvent.mockImplementation(async () => {});
  });

  // ── createClientAction ────────────────────────────────────────────────────

  describe("createClientAction", () => {
    it("normalise le téléphone en E.164 et journalise l'audit", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);

      const res = await actions.createClientAction(
        form({ phone: "(418) 476-1542", phoneAlt: "1 514 555 0188", email: "j@t.qc" }),
      );
      expect(res.ok).toBe(true);
      const created = await getClient((res as { ok: true; id: string }).id);
      expect(created.phone).toBe("+14184761542");
      expect(created.phoneAlt).toBe("+15145550188");
      expect(created.createdById).toBe(admin.id);

      const logs = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "client.create"));
      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBe(admin.id);
      expect(logs[0].entityId).toBe(created.id);
      expect(logs[0].detail).toMatchObject({ phone: "+14184761542" });
    });

    it("refuse aux téléphonistes et aux non-authentifiés", async () => {
      expect(await actions.createClientAction(form())).toEqual({ ok: false, error: "forbidden" });

      const caller = await makeUser({ role: "caller" });
      await login(caller);
      expect(await actions.createClientAction(form())).toEqual({ ok: false, error: "forbidden" });
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("rejette un téléphone inutilisable (invalidPhone) sans rien insérer", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);

      expect(await actions.createClientAction(form({ phone: "n/a" }))).toEqual({
        ok: false,
        error: "invalidPhone",
      });
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("rejette un formulaire invalide (nom vide)", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);
      expect(await actions.createClientAction(form({ fullName: "   " }))).toEqual({
        ok: false,
        error: "invalid",
      });
    });
  });

  // ── updateClientAction ────────────────────────────────────────────────────

  describe("updateClientAction", () => {
    it("re-normalise le téléphone à chaque mise à jour", async () => {
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      const client = await makeClient({ phone: "+15145550188" });

      const res = await actions.updateClientAction(
        client.id,
        form({ phone: "418.476.1542", phoneAlt: "(438) 999-0000" }),
      );
      expect(res.ok).toBe(true);

      const updated = await getClient(client.id);
      expect(updated.phone).toBe("+14184761542");
      expect(updated.phoneAlt).toBe("+14389990000");

      const logs = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "client.update"));
      expect(logs).toHaveLength(1);
      expect(logs[0].entityId).toBe(client.id);
      // Le journal doit dire CE QUI a changé : ancienne valeur → nouvelle.
      expect(logs[0].detail).toMatchObject({
        changes: {
          phone: { from: "+15145550188", to: "+14184761542" },
          phoneAlt: { from: null, to: "+14389990000" },
        },
      });
    });

    it("rejette un téléphone invalide et laisse la fiche intacte", async () => {
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      const client = await makeClient({ phone: "+15145550188", fullName: "Avant" });

      const res = await actions.updateClientAction(
        client.id,
        form({ fullName: "Après", phone: "---" }),
      );
      expect(res).toEqual({ ok: false, error: "invalidPhone" });

      const untouched = await getClient(client.id);
      expect(untouched.phone).toBe("+15145550188");
      expect(untouched.fullName).toBe("Avant");
    });

    it("n'applique assignedToId que pour un admin", async () => {
      const admin = await makeUser({ role: "admin" });
      const caller = await makeUser({ role: "caller" });
      const client = await makeClient({ assignedToId: null });

      await login(caller);
      await actions.updateClientAction(client.id, form({ assignedToId: caller.id }));
      expect((await getClient(client.id)).assignedToId).toBeNull();

      await login(admin);
      await actions.updateClientAction(client.id, form({ assignedToId: caller.id }));
      expect((await getClient(client.id)).assignedToId).toBe(caller.id);
    });

    it("répond notFound pour une fiche inexistante et forbidden sans session", async () => {
      const client = await makeClient();
      expect(await actions.updateClientAction(client.id, form())).toEqual({
        ok: false,
        error: "forbidden",
      });

      const caller = await makeUser({ role: "caller" });
      await login(caller);
      expect(
        await actions.updateClientAction("11111111-1111-4111-8111-111111111111", form()),
      ).toEqual({ ok: false, error: "notFound" });
    });
  });

  // ── deleteClientAction ────────────────────────────────────────────────────

  describe("deleteClientAction", () => {
    async function seedFullClient() {
      const admin = await makeUser({ role: "admin" });
      const client = await makeClient({ fullName: "À supprimer" });
      await testDb.insert(calls).values({
        userId: admin.id,
        clientId: client.id,
        direction: "outbound",
        startedAt: new Date("2026-03-04T15:00:00.000Z"),
      });
      await testDb.insert(appointments).values({
        clientId: client.id,
        userId: admin.id,
        type: "meet",
        title: "Rencontre",
        startsAt: new Date("2026-03-10T14:00:00.000Z"),
        endsAt: new Date("2026-03-10T14:30:00.000Z"),
        googleEventId: "evt-123",
        status: "scheduled",
      });
      await testDb.insert(comments).values({ clientId: client.id, userId: admin.id, body: "note" });
      await testDb.insert(followups).values({
        clientId: client.id,
        assignedToId: admin.id,
        dueAt: new Date("2026-03-12T13:00:00.000Z"),
        createdById: admin.id,
      });
      return { admin, client };
    }

    it("refuse aux téléphonistes", async () => {
      const { client } = await seedFullClient();
      const caller = await makeUser({ role: "caller" });
      await login(caller);

      expect(await actions.deleteClientAction(client.id)).toEqual({ ok: false, error: "forbidden" });
      expect(await testDb.select().from(clients)).toHaveLength(1);
    });

    it("supprime la fiche, ses RDV/commentaires/relances, et annule l'événement Google", async () => {
      const { admin, client } = await seedFullClient();
      await login(admin);

      expect(await actions.deleteClientAction(client.id)).toEqual({ ok: true });

      expect(await testDb.select().from(clients)).toHaveLength(0);
      expect(await testDb.select().from(appointments)).toHaveLength(0);
      expect(await testDb.select().from(comments)).toHaveLength(0);
      expect(await testDb.select().from(followups)).toHaveLength(0);
      expect(CTX.cancelEvent).toHaveBeenCalledWith("evt-123");

      const logs = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "client.delete"));
      expect(logs).toHaveLength(1);
      expect(logs[0].detail).toMatchObject({ fullName: "À supprimer" });
    });

    it("conserve l'historique d'appels en détachant la fiche (clientId → NULL)", async () => {
      const { admin, client } = await seedFullClient();
      await login(admin);

      await actions.deleteClientAction(client.id);

      // calls.client_id est ON DELETE SET NULL : les stats d'appels survivent.
      const remaining = await testDb.select().from(calls);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].clientId).toBeNull();
    });

    it("supprime quand même si l'annulation Google échoue", async () => {
      const { admin, client } = await seedFullClient();
      await login(admin);
      CTX.cancelEvent.mockRejectedValueOnce(new Error("google down"));

      expect(await actions.deleteClientAction(client.id)).toEqual({ ok: true });
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });
  });

  // ── Relances : nextFollowupAt = plus proche relance OUVERTE ────────────────

  describe("relances et nextFollowupAt", () => {
    it("convertit date+heure de Toronto en UTC (été et hiver)", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      const client = await makeClient();

      expect(
        await actions.createFollowupAction({ clientId: client.id, date: "2026-09-15", time: "14:30" }),
      ).toEqual({ ok: true });
      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-09-15T18:30:00.000Z", // EDT = UTC-4
      );

      expect(
        await actions.createFollowupAction({ clientId: client.id, date: "2026-01-15", time: "14:30" }),
      ).toEqual({ ok: true });
      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-01-15T19:30:00.000Z", // EST = UTC-5
      );
    });

    it("assigne la relance au responsable de la fiche, sinon à l'auteur", async () => {
      const owner = await makeUser({ role: "caller", name: "Titulaire" });
      const author = await makeUser({ role: "caller", name: "Auteur" });
      await login(author);

      const assigned = await makeClient({ assignedToId: owner.id });
      await actions.createFollowupAction({ clientId: assigned.id, date: "2026-09-15", time: "09:00" });
      const orphan = await makeClient({ assignedToId: null });
      await actions.createFollowupAction({ clientId: orphan.id, date: "2026-09-15", time: "09:00" });

      const rows = await testDb.select().from(followups);
      expect(rows.find((r) => r.clientId === assigned.id)!.assignedToId).toBe(owner.id);
      expect(rows.find((r) => r.clientId === orphan.id)!.assignedToId).toBe(author.id);
      expect(rows.every((r) => r.createdById === author.id)).toBe(true);
    });

    it("garde toujours la relance ouverte la plus proche (création dans le désordre)", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      const client = await makeClient();

      await actions.createFollowupAction({ clientId: client.id, date: "2026-09-20", time: "10:00" });
      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-09-20T14:00:00.000Z",
      );

      // Plus lointaine → ne doit PAS remplacer.
      await actions.createFollowupAction({ clientId: client.id, date: "2026-10-05", time: "10:00" });
      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-09-20T14:00:00.000Z",
      );

      // Plus proche → devient la prochaine.
      await actions.createFollowupAction({ clientId: client.id, date: "2026-09-01", time: "08:00" });
      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-09-01T12:00:00.000Z",
      );
    });

    it("régression : compléter les relances décale puis met nextFollowupAt à NULL", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      const client = await makeClient();

      await actions.createFollowupAction({ clientId: client.id, date: "2026-09-01", time: "08:00" });
      await actions.createFollowupAction({ clientId: client.id, date: "2026-09-20", time: "10:00" });
      const open = await testDb
        .select()
        .from(followups)
        .where(eq(followups.clientId, client.id))
        .orderBy(asc(followups.dueAt));
      expect(open).toHaveLength(2);

      expect(await actions.completeFollowupAction(open[0].id)).toEqual({ ok: true });
      const afterFirst = await getClient(client.id);
      expect(afterFirst.nextFollowupAt?.toISOString()).toBe("2026-09-20T14:00:00.000Z");
      const done = await testDb.query.followups.findFirst({ where: eq(followups.id, open[0].id) });
      expect(done!.doneAt).not.toBeNull();

      expect(await actions.completeFollowupAction(open[1].id)).toEqual({ ok: true });
      expect((await getClient(client.id)).nextFollowupAt).toBeNull();
    });

    it("compléter deux fois ne change pas le doneAt d'origine", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      const client = await makeClient();
      await actions.createFollowupAction({ clientId: client.id, date: "2026-09-01", time: "08:00" });
      const [row] = await testDb.select().from(followups);

      await actions.completeFollowupAction(row.id);
      const first = await testDb.query.followups.findFirst({ where: eq(followups.id, row.id) });
      await actions.completeFollowupAction(row.id);
      const second = await testDb.query.followups.findFirst({ where: eq(followups.id, row.id) });

      expect(second!.doneAt!.toISOString()).toBe(first!.doneAt!.toISOString());
      expect((await getClient(client.id)).nextFollowupAt).toBeNull();
    });

    it("le report d'une relance recalcule nextFollowupAt dans les deux sens", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      const client = await makeClient();
      await actions.createFollowupAction({ clientId: client.id, date: "2026-09-01", time: "08:00" });
      await actions.createFollowupAction({ clientId: client.id, date: "2026-09-20", time: "10:00" });
      const rows = await testDb
        .select()
        .from(followups)
        .where(eq(followups.clientId, client.id))
        .orderBy(asc(followups.dueAt));

      // On repousse la plus proche après l'autre → l'autre devient la prochaine.
      expect(
        await actions.updateFollowupDueAction({
          followupId: rows[0].id,
          date: "2026-10-10",
          time: "09:00",
        }),
      ).toEqual({ ok: true });
      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-09-20T14:00:00.000Z",
      );

      // On avance la seconde → elle redevient la prochaine.
      expect(
        await actions.updateFollowupDueAction({
          followupId: rows[1].id,
          date: "2026-08-25",
          time: "07:30",
        }),
      ).toEqual({ ok: true });
      expect((await getClient(client.id)).nextFollowupAt?.toISOString()).toBe(
        "2026-08-25T11:30:00.000Z",
      );
    });

    it("une relance déjà complétée n'est jamais reprise comme prochaine", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      const client = await makeClient();
      await actions.createFollowupAction({ clientId: client.id, date: "2026-09-20", time: "10:00" });
      const [row] = await testDb.select().from(followups);
      await actions.completeFollowupAction(row.id);
      expect((await getClient(client.id)).nextFollowupAt).toBeNull();

      // Report d'une relance close : elle reste close, nextFollowupAt reste NULL.
      await actions.updateFollowupDueAction({
        followupId: row.id,
        date: "2026-09-05",
        time: "10:00",
      });
      expect((await getClient(client.id)).nextFollowupAt).toBeNull();
    });

    it("refuse les entrées invalides ou sans session", async () => {
      const client = await makeClient();
      expect(
        await actions.createFollowupAction({ clientId: client.id, date: "2026-09-01", time: "08:00" }),
      ).toEqual({ ok: false, error: "forbidden" });

      const user = await makeUser({ role: "caller" });
      await login(user);
      expect(
        await actions.createFollowupAction({ clientId: client.id, date: "01-09-2026", time: "08:00" }),
      ).toEqual({ ok: false, error: "invalid" });
      expect(
        await actions.createFollowupAction({
          clientId: "11111111-1111-4111-8111-111111111111",
          date: "2026-09-01",
          time: "08:00",
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await testDb.select().from(followups)).toHaveLength(0);
    });
  });

  // ── Commentaires et mentions ──────────────────────────────────────────────

  describe("addCommentAction — mentions", () => {
    it("crée une notification par utilisateur mentionné DISTINCT, jamais pour l'auteur", async () => {
      const author = await makeUser({ role: "caller", name: "Alex Honoré", locale: "fr" });
      const alice = await makeUser({ name: "Alice", locale: "en" });
      const bob = await makeUser({ name: "Bob", locale: "fr" });
      await login(author);
      const client = await makeClient();

      const body =
        `Suivi urgent @[Alice](${alice.id}) et encore @[Alice](${alice.id}), ` +
        `@[Bob](${bob.id}) — @[Alex Honoré](${author.id}) je m'en occupe.`;
      expect(await actions.addCommentAction({ clientId: client.id, body })).toEqual({ ok: true });

      const rows = await testDb.select().from(comments);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(author.id);
      expect(rows[0].body).toBe(body);

      const notifs = await testDb.select().from(notifications);
      expect(notifs).toHaveLength(2);
      expect(new Set(notifs.map((n) => n.userId))).toEqual(new Set([alice.id, bob.id]));
      expect(notifs.every((n) => n.userId !== author.id)).toBe(true);
      expect(notifs.every((n) => n.type === "mention")).toBe(true);
      expect(notifs.every((n) => n.link === `/clients/${client.id}`)).toBe(true);

      // Titre dans la langue du DESTINATAIRE, pas celle de l'auteur.
      expect(notifs.find((n) => n.userId === alice.id)!.title).toBe("Alex Honoré mentioned you");
      expect(notifs.find((n) => n.userId === bob.id)!.title).toBe("Alex Honoré vous a mentionné");
      // Corps = extrait sans la syntaxe de mention.
      expect(notifs[0].body).toContain("@Alice");
      expect(notifs[0].body).not.toContain("](");
    });

    it("ignore les utilisateurs inactifs et les uuid inconnus", async () => {
      const author = await makeUser({ role: "caller", name: "Auteur" });
      const inactive = await makeUser({ name: "Parti", isActive: false });
      await login(author);
      const client = await makeClient();

      const body = `@[Parti](${inactive.id}) @[Fantôme](11111111-1111-4111-8111-111111111111) allo`;
      expect(await actions.addCommentAction({ clientId: client.id, body })).toEqual({ ok: true });

      expect(await testDb.select().from(comments)).toHaveLength(1);
      expect(await testDb.select().from(notifications)).toHaveLength(0);
    });

    it("RÉGRESSION (corrigé) : une mention avec un id de 36 caractères non-uuid fait planter l'action", async () => {
      const author = await makeUser({ role: "caller", name: "Auteur" });
      const bob = await makeUser({ name: "Bob" });
      await login(author);
      const client = await makeClient();

      // 36 caractères hexadécimaux sans tirets : accepté par la regex
      // extractMentionIds (/[0-9a-fA-F-]{36}/) mais refusé par le type uuid de
      // Postgres → la requête inArray(users.id, …) lève une erreur.
      const garbage = "a".repeat(36);
      const body = `@[Bob](${bob.id}) @[Bidon](${garbage}) merci`;

      await expect(
        actions.addCommentAction({ clientId: client.id, body }),
      ).resolves.toEqual({ ok: true });
      // Le commentaire ne doit pas rester orphelin d'une notification légitime.
      expect(await testDb.select().from(comments)).toHaveLength(1);
      const notifs = await testDb.select().from(notifications);
      expect(notifs.map((n) => n.userId)).toEqual([bob.id]);
    });

    it("valide le corps et l'existence de la fiche", async () => {
      const client = await makeClient();
      expect(await actions.addCommentAction({ clientId: client.id, body: "salut" })).toEqual({
        ok: false,
        error: "forbidden",
      });

      const user = await makeUser({ role: "caller" });
      await login(user);
      expect(await actions.addCommentAction({ clientId: client.id, body: "   " })).toEqual({
        ok: false,
        error: "invalid",
      });
      expect(
        await actions.addCommentAction({
          clientId: "11111111-1111-4111-8111-111111111111",
          body: "salut",
        }),
      ).toEqual({ ok: false, error: "notFound" });
      expect(await testDb.select().from(comments)).toHaveLength(0);
    });
  });

  // ── GET /api/clients/list ─────────────────────────────────────────────────

  describe("GET /api/clients/list", () => {
    it("refuse (401) sans session", async () => {
      const res = await listGET(new NextRequest(new URL("http://localhost/api/clients/list")));
      expect(res.status).toBe(401);
    });

    it("plafonne pageSize à 50 quelle que soit la valeur demandée", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      await testDb.insert(clients).values(
        Array.from({ length: 55 }, (_, i) => ({
          fullName: `Client ${i}`,
          phone: `+1418555${String(1000 + i).padStart(4, "0")}`,
        })),
      );

      const huge = await list({ pageSize: "500" });
      expect(huge.pageSize).toBe(50);
      expect(huge.items).toHaveLength(50);
      expect(huge.total).toBe(55);

      const nonsense = await list({ pageSize: "abc" });
      expect(nonsense.pageSize).toBe(50);
      expect(nonsense.items).toHaveLength(50);

      const negative = await list({ pageSize: "-5" });
      expect(negative.pageSize).toBeGreaterThanOrEqual(1);
      expect(negative.pageSize).toBeLessThanOrEqual(50);
      expect(negative.items.length).toBeLessThanOrEqual(50);

      const small = await list({ pageSize: "10" });
      expect(small.pageSize).toBe(10);
      expect(small.items).toHaveLength(10);
    });

    it("pagine sans doublon et trie par activité récente", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      const old = await makeClient({
        fullName: "Ancien",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      const middle = await makeClient({
        fullName: "Milieu",
        updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      });
      const recent = await makeClient({
        fullName: "Récent",
        updatedAt: new Date("2026-01-15T00:00:00.000Z"),
        lastContactedAt: new Date("2026-03-01T00:00:00.000Z"),
      });

      const all = await list();
      expect(all.items.map((i) => i.id)).toEqual([recent.id, middle.id, old.id]);

      const page2 = await list({ page: "2", pageSize: "1" });
      expect(page2.page).toBe(2);
      expect(page2.total).toBe(3);
      expect(page2.items.map((i) => i.id)).toEqual([middle.id]);
    });

    it("filtre par nom, courriel et téléphone malgré les différences de format", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      const emilie = await makeClient({
        fullName: "Émilie Gagnon",
        email: "emilie@example.com",
        phone: "+14184761542",
      });
      const marc = await makeClient({
        fullName: "Marc Tremblay",
        email: "marc@test.qc",
        phone: "+15145550123",
        phoneAlt: "+14389990000",
      });

      expect((await list({ q: "tremblay" })).items.map((i) => i.id)).toEqual([marc.id]);
      expect((await list({ q: "MARC" })).items.map((i) => i.id)).toEqual([marc.id]);
      expect((await list({ q: "emilie@example" })).items.map((i) => i.id)).toEqual([emilie.id]);

      for (const q of ["(418) 476-1542", "418.476.1542", "+1 418 476 1542", "4761542"]) {
        expect((await list({ q })).items.map((i) => i.id)).toEqual([emilie.id]);
      }
      // phoneAlt aussi.
      expect((await list({ q: "438-999-0000" })).items.map((i) => i.id)).toEqual([marc.id]);
      // total reflète le filtre, pas la table entière.
      expect((await list({ q: "tremblay" })).total).toBe(1);
      expect((await list({ q: "zzzz" })).items).toHaveLength(0);
    });

    it("filtre par catégorie, source et responsable", async () => {
      const cats = await seedSystemCategories();
      const other = await makeCategory({ key: null, nameFr: "Chaud", nameEn: "Hot", color: "#ff0000" });
      const [src] = await testDb.insert(sources).values({ name: "Facebook" }).returning();
      const [src2] = await testDb.insert(sources).values({ name: "Kijiji" }).returning();
      const admin = await makeUser({ role: "admin" });
      const caller = await makeUser({ role: "caller" });
      await login(admin);

      const target = await makeClient({
        fullName: "Cible",
        categoryId: other.id,
        sourceId: src.id,
        assignedToId: caller.id,
      });
      await makeClient({ fullName: "Autre cat", categoryId: cats.booked.id, sourceId: src.id });
      await makeClient({ fullName: "Autre source", categoryId: other.id, sourceId: src2.id });
      await makeClient({ fullName: "Non assigné", categoryId: other.id, assignedToId: null });

      const byCat = await list({ categoryId: String(other.id) });
      expect(byCat.total).toBe(3);
      expect(byCat.items.every((i) => i.categoryColor === "#ff0000")).toBe(true);

      expect((await list({ sourceId: String(src2.id) })).items.map((i) => i.id)).toEqual([
        (await testDb.query.clients.findFirst({ where: eq(clients.fullName, "Autre source") }))!.id,
      ]);
      expect((await list({ assignedToId: caller.id })).items.map((i) => i.id)).toEqual([target.id]);

      // Combinaison de filtres.
      const combined = await list({ categoryId: String(other.id), sourceId: String(src.id), q: "cib" });
      expect(combined.items.map((i) => i.id)).toEqual([target.id]);

      // Paramètres non numériques / non-uuid : ignorés, pas d'erreur.
      expect((await list({ categoryId: "abc", assignedToId: "pas-un-uuid" })).total).toBe(4);
    });

    describe("filtres overdue / today (horloge figée)", () => {
      // 2026-09-15 12:00 EDT — la journée de Toronto va de 04:00Z à 04:00Z+1j.
      const NOW = new Date("2026-09-15T16:00:00.000Z");
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
      });
      afterEach(() => vi.useRealTimers());

      it("sépare correctement en retard, aujourd'hui et plus tard", async () => {
        const user = await makeUser({ role: "caller" });
        await login(user);

        const late = await makeClient({
          fullName: "En retard",
          nextFollowupAt: new Date("2026-09-14T12:00:00.000Z"),
        });
        const earlyToday = await makeClient({
          fullName: "Tôt aujourd'hui",
          nextFollowupAt: new Date("2026-09-15T05:00:00.000Z"), // 01:00 EDT, déjà passé
        });
        const laterToday = await makeClient({
          fullName: "Plus tard aujourd'hui",
          nextFollowupAt: new Date("2026-09-15T22:00:00.000Z"), // 18:00 EDT
        });
        const tomorrow = await makeClient({
          fullName: "Demain",
          nextFollowupAt: new Date("2026-09-16T04:00:00.000Z"), // 00:00 EDT le 16 → exclu
        });
        await makeClient({ fullName: "Sans relance", nextFollowupAt: null });

        const overdue = await list({ filter: "overdue" });
        expect(new Set(overdue.items.map((i) => i.id))).toEqual(new Set([late.id, earlyToday.id]));
        expect(overdue.total).toBe(2);

        const today = await list({ filter: "today" });
        expect(new Set(today.items.map((i) => i.id))).toEqual(
          new Set([earlyToday.id, laterToday.id]),
        );
        expect(today.items.map((i) => i.id)).not.toContain(tomorrow.id);

        // Un filtre inconnu ne filtre rien.
        expect((await list({ filter: "n_importe_quoi" })).total).toBe(5);
      });
    });
  });

  // ── GET /api/clients/lookup ───────────────────────────────────────────────

  describe("GET /api/clients/lookup", () => {
    it("refuse (401) sans session", async () => {
      const url = new URL("http://localhost/api/clients/lookup?phone=%2B14184761542");
      const res = await lookupGET(new NextRequest(url));
      expect(res.status).toBe(401);
    });

    it("retrouve la fiche sur phone quel que soit le format saisi", async () => {
      const cats = await seedSystemCategories();
      const user = await makeUser({ role: "caller" });
      await login(user);
      const client = await makeClient({
        fullName: "Émilie Gagnon",
        phone: "+14184761542",
        city: "Québec",
        categoryId: cats.callback.id,
      });

      for (const input of [
        "+14184761542",
        "14184761542",
        "4184761542",
        "(418) 476-1542",
        "418.476.1542",
        "1 (418) 476-1542",
      ]) {
        const { client: found } = await lookup(input);
        expect(found, `format « ${input} » non reconnu`).not.toBeNull();
        expect(found!.id).toBe(client.id);
        expect(found!.fullName).toBe("Émilie Gagnon");
      }

      const { client: withCat } = await lookup("418-476-1542");
      expect(withCat!.category).toMatchObject({ key: "callback", id: cats.callback.id });
    });

    it("retrouve aussi la fiche sur phoneAlt", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      await makeClient({ fullName: "Marc", phone: "+15145550123", phoneAlt: "+14389990000" });

      for (const input of ["+14389990000", "438-999-0000", "(438) 999 0000"]) {
        const { client: found } = await lookup(input);
        expect(found, `format « ${input} » non reconnu`).not.toBeNull();
        expect(found!.fullName).toBe("Marc");
      }
    });

    it("retourne null pour un numéro inconnu, vide ou trop court", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      await makeClient({ phone: "+14184761542" });

      expect((await lookup("+15550001111")).client).toBeNull();
      expect((await lookup("1234")).client).toBeNull();
      expect((await lookup("allo")).client).toBeNull();

      const res = await lookupGET(new NextRequest(new URL("http://localhost/api/clients/lookup")));
      expect(res.status).toBe(200);
      expect((await res.json()).client).toBeNull();
    });

    it("retourne category = null quand la fiche n'a pas de catégorie", async () => {
      const user = await makeUser({ role: "caller" });
      await login(user);
      await makeClient({ phone: "+14185550199", categoryId: null });

      const { client: found } = await lookup("418-555-0199");
      expect(found).not.toBeNull();
      expect(found!.category).toBeNull();
    });
  });
});
