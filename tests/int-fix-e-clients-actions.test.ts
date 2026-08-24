/**
 * Intégration — correctifs d'audit, actions serveur des fiches clients et des
 * fils SMS (grappe E) :
 *
 *  · Entrer dans « Ne pas appeler (LNNTE) » par la liste déroulante / le
 *    pipeline / l'action en masse pose `clients.doNotCall`, comme la
 *    disposition d'après-appel — et en sortir ne le retire pas.
 *  · Un « autre téléphone » inutilisable est REFUSÉ (invalidPhoneAlt), pas
 *    enregistré NULL en silence.
 *  · Une catégorie / source / responsable disparus (vieil onglet) répondent
 *    notFound au lieu d'une violation de clé étrangère qui plante l'action.
 *  · Un téléphoniste ne désattribue que SON fil SMS (ou un fil sans titulaire).
 *
 * Vrais handlers + vrai garde RBAC (JWT nexus_session). Seul Google est simulé.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  closeDb,
  makeClient,
  makeConversation,
  makeSmsNumber,
  makeSource,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";
import { clients } from "@/db/schema";
import { conversations } from "@/db/schema-sms";

// ── Stubs de contexte Next + réseau externe ─────────────────────────────────

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
vi.mock("@/lib/google", () => ({
  cancelEvent: vi.fn(async () => {}),
  GoogleNotConnectedError: class GoogleNotConnectedError extends Error {},
}));

const actions = await import("@/app/(app)/clients/actions");
const { assignConversationAction } = await import("@/app/(app)/conversations/actions");

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

async function getClient(id: string) {
  const row = await testDb.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!row) throw new Error(`client ${id} introuvable`);
  return row;
}

function form(over: Partial<Parameters<typeof actions.createClientAction>[0]> = {}) {
  return { fullName: "Jean Tremblay", phone: "418-476-1542", language: "fr" as const, ...over };
}

const UNKNOWN_UUID = "11111111-1111-4111-8111-111111111111";

describe("correctifs — actions des fiches clients (grappe E)", () => {
  afterAll(closeDb);
  beforeEach(async () => {
    await resetDb();
    CTX.jar.clear();
    CTX.hdrs = new Headers();
  });

  // ── #6 : « Ne pas appeler (LNNTE) » ⇒ doNotCall, quel que soit le chemin ──

  describe("entrer dans « Ne pas appeler (LNNTE) » pose doNotCall", () => {
    it("setClientCategoryAction (liste déroulante / pipeline) — téléphoniste", async () => {
      const cats = await seedSystemCategories();
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      const client = await makeClient({ categoryId: cats.callback.id });
      expect(client.doNotCall).toBe(false);

      expect(await actions.setClientCategoryAction(client.id, cats.dncl.id)).toEqual({
        ok: true,
        id: client.id,
      });
      const flagged = await getClient(client.id);
      expect(flagged.categoryId).toBe(cats.dncl.id);
      expect(flagged.doNotCall).toBe(true);
    });

    it("en SORTIR ne retire pas le drapeau (même comportement que la disposition)", async () => {
      const cats = await seedSystemCategories();
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      const client = await makeClient({ categoryId: cats.dncl.id, doNotCall: true });

      expect((await actions.setClientCategoryAction(client.id, cats.callback.id)).ok).toBe(true);
      const moved = await getClient(client.id);
      expect(moved.categoryId).toBe(cats.callback.id);
      expect(moved.doNotCall).toBe(true);

      // Vers « sans catégorie » non plus.
      expect((await actions.setClientCategoryAction(client.id, null)).ok).toBe(true);
      expect((await getClient(client.id)).doNotCall).toBe(true);
    });

    it("une autre catégorie ne touche pas au drapeau", async () => {
      const cats = await seedSystemCategories();
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      const client = await makeClient({ categoryId: cats.new.id });

      expect((await actions.setClientCategoryAction(client.id, cats.booked.id)).ok).toBe(true);
      expect((await getClient(client.id)).doNotCall).toBe(false);
    });

    it("createClientAction — une fiche créée directement dans ce statut (admin)", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await login(admin);

      const res = await actions.createClientAction(form({ categoryId: cats.dncl.id }));
      expect(res.ok).toBe(true);
      const created = await getClient((res as { ok: true; id: string }).id);
      expect(created.categoryId).toBe(cats.dncl.id);
      expect(created.doNotCall).toBe(true);

      const other = await actions.createClientAction(
        form({ phone: "418-476-1543", categoryId: cats.callback.id }),
      );
      expect((await getClient((other as { ok: true; id: string }).id)).doNotCall).toBe(false);
    });

    it("bulkSetClientsCategoryAction — admin, chaque fiche du lot", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await login(admin);
      const a = await makeClient({ categoryId: cats.new.id });
      const b = await makeClient({ categoryId: cats.callback.id });
      const untouched = await makeClient({ categoryId: cats.callback.id });

      expect(await actions.bulkSetClientsCategoryAction([a.id, b.id], cats.dncl.id)).toEqual({
        ok: true,
        count: 2,
      });
      const rows = await testDb.select().from(clients).where(inArray(clients.id, [a.id, b.id]));
      expect(rows.every((r) => r.categoryId === cats.dncl.id && r.doNotCall)).toBe(true);
      expect((await getClient(untouched.id)).doNotCall).toBe(false);
    });
  });

  // ── #51 / #56 : références disparues ⇒ notFound, pas une exception ────────

  describe("catégorie / source / responsable inexistants", () => {
    it("setClientCategoryAction répond notFound pour un statut inconnu et ne touche pas la fiche", async () => {
      const cats = await seedSystemCategories();
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      const client = await makeClient({ categoryId: cats.callback.id });

      await expect(actions.setClientCategoryAction(client.id, 999_999)).resolves.toEqual({
        ok: false,
        error: "notFound",
      });
      expect((await getClient(client.id)).categoryId).toBe(cats.callback.id);
    });

    it("updateClientAction répond notFound pour une source supprimée (téléphoniste)", async () => {
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      const src = await makeSource({ name: "Kijiji" });
      const client = await makeClient({ fullName: "Avant", sourceId: src.id });

      await expect(
        actions.updateClientAction(client.id, form({ fullName: "Après", sourceId: 999_999 })),
      ).resolves.toEqual({ ok: false, error: "notFound" });
      const untouched = await getClient(client.id);
      expect(untouched.fullName).toBe("Avant");
      expect(untouched.sourceId).toBe(src.id);
    });

    it("updateClientAction répond notFound pour un responsable supprimé (admin)", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);
      const client = await makeClient({ fullName: "Avant" });

      await expect(
        actions.updateClientAction(client.id, form({ fullName: "Après", assignedToId: UNKNOWN_UUID })),
      ).resolves.toEqual({ ok: false, error: "notFound" });
      expect((await getClient(client.id)).fullName).toBe("Avant");
    });

    it("createClientAction répond notFound pour une catégorie / source inconnue, sans rien insérer", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);

      await expect(actions.createClientAction(form({ categoryId: 999_999 }))).resolves.toEqual({
        ok: false,
        error: "notFound",
      });
      await expect(actions.createClientAction(form({ sourceId: 999_999 }))).resolves.toEqual({
        ok: false,
        error: "notFound",
      });
      await expect(
        actions.createClientAction(form({ assignedToId: UNKNOWN_UUID })),
      ).resolves.toEqual({ ok: false, error: "notFound" });
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("assignClientAction répond notFound pour un utilisateur inconnu", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);
      const client = await makeClient({ assignedToId: null });

      await expect(actions.assignClientAction(client.id, UNKNOWN_UUID)).resolves.toEqual({
        ok: false,
        error: "notFound",
      });
      expect((await getClient(client.id)).assignedToId).toBeNull();
    });
  });

  // ── #39 : « autre téléphone » inutilisable ⇒ refusé, pas effacé en silence ──

  describe("autre téléphone invalide", () => {
    it("updateClientAction refuse (invalidPhoneAlt) et garde l'ancien numéro", async () => {
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      const client = await makeClient({ phone: "+15145550188", phoneAlt: "+14389990000" });

      for (const bad of ["poste 22", "n/a", "abc"]) {
        expect(
          await actions.updateClientAction(client.id, form({ phoneAlt: bad })),
          `« ${bad} » devrait être refusé`,
        ).toEqual({ ok: false, error: "invalidPhoneAlt" });
      }
      expect((await getClient(client.id)).phoneAlt).toBe("+14389990000");

      // Vider le champ reste permis : c'est un effacement voulu.
      expect((await actions.updateClientAction(client.id, form({ phoneAlt: null }))).ok).toBe(true);
      expect((await getClient(client.id)).phoneAlt).toBeNull();
    });

    it("createClientAction refuse (invalidPhoneAlt) sans rien insérer", async () => {
      const admin = await makeUser({ role: "admin" });
      await login(admin);

      expect(await actions.createClientAction(form({ phoneAlt: "poste 22" }))).toEqual({
        ok: false,
        error: "invalidPhoneAlt",
      });
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });
  });

  // ── #68 : désattribuer un fil SMS ────────────────────────────────────────

  describe("assignConversationAction — désattribution", () => {
    async function thread(assignedToId: string | null) {
      const client = await makeClient();
      const number = await makeSmsNumber();
      return makeConversation({
        clientId: client.id,
        clientPhone: client.phone,
        smsNumberId: number.id,
        assignedToId,
      });
    }
    async function assignee(id: string) {
      const row = await testDb.query.conversations.findFirst({ where: eq(conversations.id, id) });
      return row!.assignedToId;
    }

    it("un téléphoniste ne désattribue PAS le fil d'un collègue", async () => {
      const caller = await makeUser({ role: "caller" });
      const colleague = await makeUser({ role: "caller" });
      await login(caller);
      const t = await thread(colleague.id);

      expect(await assignConversationAction({ conversationId: t.id, userId: null })).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(await assignee(t.id)).toBe(colleague.id);
    });

    it("un téléphoniste relâche SON fil, ou un fil sans titulaire", async () => {
      const caller = await makeUser({ role: "caller" });
      await login(caller);

      const mine = await thread(caller.id);
      expect((await assignConversationAction({ conversationId: mine.id, userId: null })).ok).toBe(true);
      expect(await assignee(mine.id)).toBeNull();

      const nobody = await thread(null);
      expect((await assignConversationAction({ conversationId: nobody.id, userId: null })).ok).toBe(
        true,
      );
      expect(await assignee(nobody.id)).toBeNull();

      // Se l'attribuer reste permis (comportement existant).
      expect((await assignConversationAction({ conversationId: nobody.id, userId: caller.id })).ok).toBe(
        true,
      );
      expect(await assignee(nobody.id)).toBe(caller.id);
    });

    it("un admin désattribue n'importe quel fil", async () => {
      const admin = await makeUser({ role: "admin" });
      const colleague = await makeUser({ role: "caller" });
      await login(admin);
      const t = await thread(colleague.id);

      expect((await assignConversationAction({ conversationId: t.id, userId: null })).ok).toBe(true);
      expect(await assignee(t.id)).toBeNull();
    });

    it("un fil inconnu répond notFound, pas une exception", async () => {
      const caller = await makeUser({ role: "caller" });
      await login(caller);
      expect(await assignConversationAction({ conversationId: UNKNOWN_UUID, userId: null })).toEqual({
        ok: false,
        error: "notFound",
      });
    });
  });
});
