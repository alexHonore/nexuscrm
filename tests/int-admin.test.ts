/**
 * Intégration — opérations d'administration.
 *
 * Comptes (création / édition / réinitialisation / suppression), import et
 * export CSV, catégories, annotation des DID voip.ms.
 *
 * Les gardes RBAC sont réellement exercées : on fabrique de vrais JWT `jose`
 * signés avec AUTH_SECRET et on les dépose dans le cookie `nexus_session`.
 * Seul le réseau voip.ms est simulé (fetch global).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  closeDb,
  makeCategory,
  makeClient,
  makeSource,
  makeUser,
  resetDb,
  seedSystemCategories,
  testDb,
} from "./helpers/db";
import { auditLogs, calls, categories, clients, users } from "@/db/schema";

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

const usersRoute = await import("@/app/api/admin/users/route");
const userIdRoute = await import("@/app/api/admin/users/[id]/route");
const resetPasswordRoute = await import("@/app/api/admin/users/[id]/reset-password/route");
const importRoute = await import("@/app/api/admin/import/route");
const exportRoute = await import("@/app/api/admin/export/route");
const categoryIdRoute = await import("@/app/api/admin/categories/[id]/route");
const categoryTransferRoute = await import("@/app/api/admin/categories/[id]/transfer/route");
const sourceIdRoute = await import("@/app/api/admin/sources/[id]/route");
const sourceTransferRoute = await import("@/app/api/admin/sources/[id]/transfer/route");
const didsRoute = await import("@/app/api/admin/voipms/dids/route");
const { verifyPassword } = await import("@/lib/auth/password");

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

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("opérations d'administration", () => {
  beforeEach(async () => {
    await resetDb();
    logout();
  });
  afterAll(closeDb);

  // ══ Comptes utilisateurs ═══════════════════════════════════════════════════

  describe("POST /api/admin/users", () => {
    it("RÉGRESSION : le mot de passe temporaire retourné vérifie contre le hash bcrypt stocké", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const res = await usersRoute.POST(
        jsonRequest("http://localhost/api/admin/users", "POST", {
          name: "Nouvelle Téléphoniste",
          email: "Nouvelle@Nexus.CA",
          role: "caller",
          locale: "fr",
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { id: string; email: string }; tempPassword: string };

      expect(typeof body.tempPassword).toBe("string");
      expect(body.tempPassword.length).toBeGreaterThanOrEqual(12);
      // L'email est normalisé en minuscules par le schéma.
      expect(body.user.email).toBe("nouvelle@nexus.ca");

      const [created] = await testDb.select().from(users).where(eq(users.id, body.user.id));
      expect(created.passwordHash).not.toBe(body.tempPassword);
      // Le cœur de l'incident : le mot de passe affiché doit permettre de se connecter.
      await expect(verifyPassword(body.tempPassword, created.passwordHash)).resolves.toBe(true);
      await expect(verifyPassword("mauvais-mot-de-passe", created.passwordHash)).resolves.toBe(false);
    });

    it("RÉGRESSION (corrigé) : un courriel déjà pris doit renvoyer 409 email_taken (le handler lève → 500)", async () => {
      const admin = await makeUser({ role: "admin" });
      await makeUser({ email: "deja@nexus.ca" });
      await loginAs(admin);

      const outcome = await usersRoute
        .POST(
          jsonRequest("http://localhost/api/admin/users", "POST", {
            name: "Doublon",
            email: "deja@nexus.ca",
            role: "caller",
            locale: "fr",
          }),
        )
        .then(
          (r) => r as unknown,
          (e) => e as unknown,
        );

      // drizzle-orm ≥ 0.44 emballe l'erreur Postgres dans un DrizzleQueryError
      // dont le message est « Failed query: … » : le `catch` de la route teste
      // `err.message` et ne voit donc jamais « users_email_unique » /
      // « duplicate key ». L'exception remonte → 500 au lieu de 409.
      expect(
        outcome,
        "POST /api/admin/users lève une exception au lieu de renvoyer 409 email_taken",
      ).toBeInstanceOf(Response);
      expect((outcome as Response).status).toBe(409);
      await expect((outcome as Response).json()).resolves.toEqual({ error: "email_taken" });
      expect(await testDb.select().from(users)).toHaveLength(2);
    });

    it("refuse un téléphoniste (403) et une requête anonyme (401)", async () => {
      const caller = await makeUser({ role: "caller" });
      const payload = { name: "X", email: "x@nexus.ca", role: "caller", locale: "fr" };

      const anon = await usersRoute.POST(
        jsonRequest("http://localhost/api/admin/users", "POST", payload),
      );
      expect(anon.status).toBe(401);

      await loginAs(caller);
      const forbidden = await usersRoute.POST(
        jsonRequest("http://localhost/api/admin/users", "POST", payload),
      );
      expect(forbidden.status).toBe(403);
      expect(await testDb.select().from(users)).toHaveLength(1);
    });
  });

  describe("PATCH /api/admin/users/[id]", () => {
    it("modifie le courriel et journalise l'ancienne valeur", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ email: "ancien@nexus.ca" });
      await loginAs(admin);

      const res = await userIdRoute.PATCH(
        jsonRequest(`http://localhost/api/admin/users/${target.id}`, "PATCH", {
          email: "Nouveau@Nexus.ca",
        }),
        ctx(target.id),
      );
      expect(res.status).toBe(200);

      const [updated] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(updated.email).toBe("nouveau@nexus.ca");

      const log = (await testDb.select().from(auditLogs)).find((l) => l.action === "user.update");
      expect(log?.detail).toMatchObject({ previousEmail: "ancien@nexus.ca" });
      // Avant → après lisible dans le journal, sans jamais toucher aux secrets.
      expect(log?.detail).toMatchObject({
        changes: { email: { from: "ancien@nexus.ca", to: "nouveau@nexus.ca" } },
      });
      expect(JSON.stringify(log?.detail)).not.toMatch(/password|hash/i);
    });

    it("RÉGRESSION (corrigé) : un courriel déjà utilisé par un autre compte doit renvoyer 409 (le handler lève → 500)", async () => {
      const admin = await makeUser({ role: "admin" });
      await makeUser({ email: "occupe@nexus.ca" });
      const target = await makeUser({ email: "libre@nexus.ca" });
      await loginAs(admin);

      const outcome = await userIdRoute
        .PATCH(
          jsonRequest(`http://localhost/api/admin/users/${target.id}`, "PATCH", {
            email: "occupe@nexus.ca",
          }),
          ctx(target.id),
        )
        .then(
          (r) => r as unknown,
          (e) => e as unknown,
        );

      // Même cause que pour POST : le message du DrizzleQueryError ne contient
      // pas « users_email_unique », donc le mapping 409 ne se déclenche jamais.
      expect(
        outcome,
        "PATCH /api/admin/users/[id] lève une exception au lieu de renvoyer 409 email_taken",
      ).toBeInstanceOf(Response);
      expect((outcome as Response).status).toBe(409);
      await expect((outcome as Response).json()).resolves.toEqual({ error: "email_taken" });

      // L'unicité en base tient : la cible garde son courriel.
      const [unchanged] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(unchanged.email).toBe("libre@nexus.ca");
    });

    it("la désactivation incrémente tokenVersion et invalide les sessions en cours", async () => {
      const admin = await makeUser({ role: "admin" });
      const other = await makeUser({ role: "admin", name: "Second admin" });
      expect(other.tokenVersion).toBe(1);
      await loginAs(admin);

      const res = await userIdRoute.PATCH(
        jsonRequest(`http://localhost/api/admin/users/${other.id}`, "PATCH", { isActive: false }),
        ctx(other.id),
      );
      expect(res.status).toBe(200);

      const [after] = await testDb.select().from(users).where(eq(users.id, other.id));
      expect(after.isActive).toBe(false);
      expect(after.tokenVersion).toBe(2);

      // La session émise avant (tv = 1) ne passe plus les gardes.
      jar.set("nexus_session", await signSession(other.id, "admin", 1));
      const stale = await usersRoute.POST(
        jsonRequest("http://localhost/api/admin/users", "POST", {
          name: "Z",
          email: "z@nexus.ca",
          role: "caller",
          locale: "fr",
        }),
      );
      expect(stale.status).toBe(401);
    });

    it("empêche un admin de se désactiver lui-même", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const res = await userIdRoute.PATCH(
        jsonRequest(`http://localhost/api/admin/users/${admin.id}`, "PATCH", { isActive: false }),
        ctx(admin.id),
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "cannot_deactivate_self" });
    });
  });

  describe("POST /api/admin/users/[id]/reset-password", () => {
    it("émet un mot de passe fonctionnel et incrémente tokenVersion", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ email: "reset@nexus.ca" });
      await loginAs(admin);

      const [before] = await testDb.select().from(users).where(eq(users.id, target.id));

      const res = await resetPasswordRoute.POST(
        jsonRequest(`http://localhost/api/admin/users/${target.id}/reset-password`, "POST"),
        ctx(target.id),
      );
      expect(res.status).toBe(200);
      const { tempPassword } = (await res.json()) as { tempPassword: string };

      const [after] = await testDb.select().from(users).where(eq(users.id, target.id));
      expect(after.passwordHash).not.toBe(before.passwordHash);
      await expect(verifyPassword(tempPassword, after.passwordHash)).resolves.toBe(true);
      // L'ancien mot de passe ne fonctionne plus.
      await expect(verifyPassword(target.plainPassword!, after.passwordHash)).resolves.toBe(false);
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    });

    it("refuse (403) un téléphoniste", async () => {
      const caller = await makeUser({ role: "caller" });
      const target = await makeUser();
      await loginAs(caller);

      const res = await resetPasswordRoute.POST(
        jsonRequest(`http://localhost/api/admin/users/${target.id}/reset-password`, "POST"),
        ctx(target.id),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/admin/users/[id]", () => {
    it("refuse (409 has_activity) la suppression d'un compte avec de l'historique", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Téléphoniste actif" });
      const client = await makeClient();
      await testDb.insert(calls).values({
        userId: target.id,
        clientId: client.id,
        direction: "outbound",
        startedAt: new Date("2026-01-15T14:00:00Z"),
        durationSec: 120,
      });
      await loginAs(admin);

      const res = await userIdRoute.DELETE(
        new Request(`http://localhost/api/admin/users/${target.id}`, { method: "DELETE" }),
        ctx(target.id),
      );
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "has_activity" });

      // Le compte ET son historique d'appels sont intacts.
      expect(await testDb.select().from(users).where(eq(users.id, target.id))).toHaveLength(1);
      expect(await testDb.select().from(calls)).toHaveLength(1);
    });

    it("supprime un compte neuf et se contente de désassigner ses clients", async () => {
      const admin = await makeUser({ role: "admin" });
      const target = await makeUser({ name: "Jamais utilisé" });
      const client = await makeClient({ fullName: "Client suivi", assignedToId: target.id });
      await loginAs(admin);

      const res = await userIdRoute.DELETE(
        new Request(`http://localhost/api/admin/users/${target.id}`, { method: "DELETE" }),
        ctx(target.id),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });

      expect(await testDb.select().from(users).where(eq(users.id, target.id))).toHaveLength(0);
      const [kept] = await testDb.select().from(clients).where(eq(clients.id, client.id));
      expect(kept).toBeDefined();
      expect(kept.fullName).toBe("Client suivi");
      expect(kept.assignedToId).toBeNull();
    });

    it("empêche un admin de se supprimer lui-même", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const res = await userIdRoute.DELETE(
        new Request(`http://localhost/api/admin/users/${admin.id}`, { method: "DELETE" }),
        ctx(admin.id),
      );
      expect(res.status).toBe(400);
      expect(await testDb.select().from(users)).toHaveLength(1);
    });
  });

  // ══ Import CSV ═════════════════════════════════════════════════════════════

  describe("POST /api/admin/import", () => {
    const importUrl = "http://localhost/api/admin/import";

    it("crée les lignes valides, compte les téléphones invalides et les doublons du lot", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [
            { fullName: "Alice Roy", phone: "418-476-1542", email: "alice@example.com" },
            { fullName: "Bob Gagné", phone: "(514) 555-0142", city: "Laval" },
            { fullName: "Sans numéro", phone: "N/A" },
            { fullName: "Vide", phone: "" },
            { fullName: "Alice en double", phone: "4184761542" },
          ],
          mode: "skip",
        }),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        created: 2,
        updated: 0,
        skipped: 1,
        invalid: 2,
      });

      const rows = await testDb.select().from(clients);
      expect(rows.map((r) => r.phone).sort()).toEqual(["+14184761542", "+15145550142"]);
      expect(rows.every((r) => r.categoryId === cats.new.id)).toBe(true);
      expect(rows.every((r) => r.createdById === admin.id)).toBe(true);
    });

    it("dit POURQUOI chaque ligne est écartée, motif par motif", async () => {
      await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      // Fiche déjà en base → doublon « en base » (distinct du doublon interne).
      await makeClient({ phone: "+15145550142" });

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [
            { fullName: "Valide", phone: "418-476-1542" },
            { fullName: "Cellule vide", phone: "" },
            { fullName: "Sans chiffre", phone: "à venir" },
            { fullName: "Doublon fichier", phone: "4184761542" },
            { fullName: "Déjà au CRM", phone: "514 555 0142" },
            { fullName: "Colonne absente" },
          ],
          mode: "skip",
        }),
      );
      const body = (await res.json()) as {
        created: number;
        skipped: number;
        invalid: number;
        issues: Array<{ index: number; reason: string; name?: string; existingId?: string }>;
      };

      expect(body).toMatchObject({ created: 1, skipped: 2, invalid: 3 });
      // Une entrée par ligne écartée : aucun rejet muet.
      expect(body.issues).toHaveLength(body.skipped + body.invalid);
      expect(body.issues.map((i) => [i.index, i.reason])).toEqual([
        [1, "phone_missing"],
        [2, "phone_invalid"],
        [3, "duplicate_in_file"],
        [4, "duplicate_in_db"],
        [5, "phone_missing"],
      ]);
      // Le motif « déjà en base » pointe la fiche existante (lien depuis l'UI).
      const dup = body.issues.find((i) => i.reason === "duplicate_in_db")!;
      expect(dup.existingId).toEqual(expect.any(String));
      expect(dup.name).toBe("Déjà au CRM");
    });

    it("mode « update » : le doublon en base n'est plus signalé comme écarté", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      await makeClient({ phone: "+14184761542", fullName: "Ancien nom" });

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [{ fullName: "Nom du CSV", phone: "418-476-1542" }],
          mode: "update",
        }),
      );
      const body = (await res.json()) as { updated: number; issues: unknown[] };
      expect(body.updated).toBe(1);
      expect(body.issues).toEqual([]);
    });

    it("mode « skip » : ignore un client déjà présent sans le modifier", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      await makeClient({ fullName: "Nom d'origine", phone: "+14184761542", city: "Québec" });

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [{ fullName: "Nom du CSV", phone: "418 476 1542", city: "Montréal" }],
          mode: "skip",
        }),
      );
      await expect(res.json()).resolves.toMatchObject({ created: 0, updated: 0, skipped: 1 });

      const [row] = await testDb.select().from(clients);
      expect(row.fullName).toBe("Nom d'origine");
      expect(row.city).toBe("Québec");
    });

    it("mode « update » : met à jour le client existant", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const existing = await makeClient({ fullName: "Nom d'origine", phone: "+14184761542" });

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [
            {
              fullName: "Nom du CSV",
              phone: "418 476 1542",
              city: "Montréal",
              budget: "400 000 $",
            },
          ],
          mode: "update",
        }),
      );
      await expect(res.json()).resolves.toMatchObject({ created: 0, updated: 1, skipped: 0 });

      const rows = await testDb.select().from(clients);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(existing.id);
      expect(rows[0].fullName).toBe("Nom du CSV");
      expect(rows[0].city).toBe("Montréal");
      expect(rows[0].budget).toBe("400 000 $");
    });

    it("RÉGRESSION : le mode « update » n'efface pas un phoneAlt existant quand la cellule est vide ou « N/A »", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const withAlt = await makeClient({ phone: "+14184761542", phoneAlt: "+15819990001" });
      const withAlt2 = await makeClient({ phone: "+15145550142", phoneAlt: "+15819990002" });

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [
            { fullName: "Alice", phone: "418-476-1542", phoneAlt: "" },
            { fullName: "Bob", phone: "514-555-0142", phoneAlt: "N/A" },
          ],
          mode: "update",
        }),
      );
      await expect(res.json()).resolves.toMatchObject({ updated: 2 });

      const [a] = await testDb.select().from(clients).where(eq(clients.id, withAlt.id));
      const [b] = await testDb.select().from(clients).where(eq(clients.id, withAlt2.id));
      expect(a.phoneAlt).toBe("+15819990001");
      expect(b.phoneAlt).toBe("+15819990002");
    });

    it("normalise un phoneAlt fourni en E.164", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);

      await importRoute.POST(
        jsonRequest(importUrl, "POST", {
          rows: [{ fullName: "Alice", phone: "418-476-1542", phoneAlt: "581 999-0001" }],
        }),
      );
      const [row] = await testDb.select().from(clients);
      expect(row.phoneAlt).toBe("+15819990001");
    });

    it("refuse (403) un téléphoniste — l'import est réservé aux admins", async () => {
      const caller = await makeUser({ role: "caller" });
      await loginAs(caller);

      const res = await importRoute.POST(
        jsonRequest(importUrl, "POST", { rows: [{ fullName: "X", phone: "4184761542" }] }),
      );
      expect(res.status).toBe(403);
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });
  });

  // ══ Export CSV ═════════════════════════════════════════════════════════════

  describe("GET /api/admin/export", () => {
    const EXPECTED_HEADER =
      "id,fullName,phone,phoneAlt,email,language,category,source,assignedTo,projectType," +
      "timing,budget,city,address,notes,doNotCall,lastDisposition,lastContactedAt," +
      "nextFollowupAt,createdAt";

    it("renvoie un CSV avec BOM UTF-8, l'en-tête attendu et les clients", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin", name: "Le Courtier" });
      await loginAs(admin);
      await makeClient({
        fullName: "Marie, Tremblay",
        phone: "+14184761542",
        categoryId: cats.callback.id,
        assignedToId: admin.id,
        doNotCall: true,
      });

      const res = await exportRoute.GET(new Request("http://localhost/api/admin/export"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toContain("attachment");

      // On lit les octets bruts : `Response.text()` supprime le BOM au décodage.
      const buf = Buffer.from(await res.arrayBuffer());
      expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]); // BOM UTF-8 (Excel)
      const text = buf.subarray(3).toString("utf8");
      const lines = text.split("\r\n").filter(Boolean);
      expect(lines[0]).toBe(EXPECTED_HEADER);
      expect(lines).toHaveLength(2);
      // Les virgules du nom sont échappées entre guillemets.
      expect(lines[1]).toContain('"Marie, Tremblay"');
      expect(lines[1]).toContain("+14184761542");
      expect(lines[1]).toContain("À rappeler");
      expect(lines[1]).toContain("Le Courtier");
    });

    it("filtre par catégorie", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      await makeClient({ fullName: "Gardé", phone: "+14184761542", categoryId: cats.callback.id });
      await makeClient({ fullName: "Exclu", phone: "+15145550142", categoryId: cats.dncl.id });

      const res = await exportRoute.GET(
        new Request(`http://localhost/api/admin/export?categoryId=${cats.callback.id}`),
      );
      const text = await res.text();
      expect(text).toContain("Gardé");
      expect(text).not.toContain("Exclu");
    });

    it("est réservé aux admins (403 pour un téléphoniste, 401 sans session)", async () => {
      const caller = await makeUser({ role: "caller" });

      const anon = await exportRoute.GET(new Request("http://localhost/api/admin/export"));
      expect(anon.status).toBe(401);

      await loginAs(caller);
      const forbidden = await exportRoute.GET(new Request("http://localhost/api/admin/export"));
      expect(forbidden.status).toBe(403);
      expect(forbidden.headers.get("content-type")).toContain("application/json");
    });
  });

  // ══ Catégories ═════════════════════════════════════════════════════════════

  describe("DELETE /api/admin/categories/[id]", () => {
    it("réaffecte les clients de la catégorie supprimée vers la cible choisie", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const custom = await makeCategory({ nameFr: "Lead chaud", nameEn: "Hot lead" });
      const a = await makeClient({ phone: "+14184761542", categoryId: custom.id });
      const b = await makeClient({ phone: "+15145550142", categoryId: custom.id });

      const res = await categoryIdRoute.DELETE(
        jsonRequest(`http://localhost/api/admin/categories/${custom.id}`, "DELETE", {
          reassignTo: cats.callback.id,
        }),
        ctx(String(custom.id)),
      );
      expect(res.status).toBe(200);

      expect(
        await testDb.select().from(categories).where(eq(categories.id, custom.id)),
      ).toHaveLength(0);
      const [ra] = await testDb.select().from(clients).where(eq(clients.id, a.id));
      const [rb] = await testDb.select().from(clients).where(eq(clients.id, b.id));
      expect(ra.categoryId).toBe(cats.callback.id);
      expect(rb.categoryId).toBe(cats.callback.id);
    });

    it("refuse (400) la suppression d'une catégorie système", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const client = await makeClient({ categoryId: cats.callback.id });

      const res = await categoryIdRoute.DELETE(
        jsonRequest(`http://localhost/api/admin/categories/${cats.callback.id}`, "DELETE", {
          reassignTo: cats.new.id,
        }),
        ctx(String(cats.callback.id)),
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "system_category" });

      expect(
        await testDb.select().from(categories).where(eq(categories.id, cats.callback.id)),
      ).toHaveLength(1);
      const [untouched] = await testDb.select().from(clients).where(eq(clients.id, client.id));
      expect(untouched.categoryId).toBe(cats.callback.id);
    });

    it("exige une destination explicite tant que des fiches sont rattachées", async () => {
      await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const custom = await makeCategory({ nameFr: "Lead chaud", nameEn: "Hot lead" });
      const client = await makeClient({ categoryId: custom.id });

      // Corps absent : refusé — sinon la fiche perdrait sa catégorie en silence.
      const res = await categoryIdRoute.DELETE(
        jsonRequest(`http://localhost/api/admin/categories/${custom.id}`, "DELETE"),
        ctx(String(custom.id)),
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "reassign_required",
        clientCount: 1,
      });
      expect(
        await testDb.select().from(categories).where(eq(categories.id, custom.id)),
      ).toHaveLength(1);
      const [kept] = await testDb.select().from(clients).where(eq(clients.id, client.id));
      expect(kept.categoryId).toBe(custom.id);

      // « Aucune catégorie » choisi explicitement : accepté.
      const explicit = await categoryIdRoute.DELETE(
        jsonRequest(`http://localhost/api/admin/categories/${custom.id}`, "DELETE", {
          reassignTo: null,
        }),
        ctx(String(custom.id)),
      );
      expect(explicit.status).toBe(200);
      const [orphan] = await testDb.select().from(clients).where(eq(clients.id, client.id));
      expect(orphan.categoryId).toBeNull();
    });

    it("refuse une destination inexistante ou la catégorie elle-même", async () => {
      await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const custom = await makeCategory({ nameFr: "Lead chaud", nameEn: "Hot lead" });
      await makeClient({ categoryId: custom.id });

      for (const reassignTo of [999_999, custom.id]) {
        const res = await categoryIdRoute.DELETE(
          jsonRequest(`http://localhost/api/admin/categories/${custom.id}`, "DELETE", {
            reassignTo,
          }),
          ctx(String(custom.id)),
        );
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "invalid_target" });
      }
      expect(
        await testDb.select().from(categories).where(eq(categories.id, custom.id)),
      ).toHaveLength(1);
    });

    it("sans fiche rattachée, la suppression n'exige aucune destination", async () => {
      await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const empty = await makeCategory({ nameFr: "Vide", nameEn: "Empty" });

      const res = await categoryIdRoute.DELETE(
        jsonRequest(`http://localhost/api/admin/categories/${empty.id}`, "DELETE"),
        ctx(String(empty.id)),
      );
      expect(res.status).toBe(200);
      expect(
        await testDb.select().from(categories).where(eq(categories.id, empty.id)),
      ).toHaveLength(0);
    });
  });

  // ══ Transfert des fiches (sans suppression) ════════════════════════════════

  describe("POST /api/admin/categories|sources/[id]/transfer", () => {
    it("déplace les fiches d'une catégorie vers une autre et journalise", async () => {
      const cats = await seedSystemCategories();
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const from = await makeCategory({ nameFr: "Ancienne", nameEn: "Old" });
      const a = await makeClient({ phone: "+14184761542", categoryId: from.id });
      const b = await makeClient({ phone: "+15145550142", categoryId: from.id });
      const other = await makeClient({ phone: "+15145550143", categoryId: cats.new.id });

      const res = await categoryTransferRoute.POST(
        jsonRequest(`http://localhost/api/admin/categories/${from.id}/transfer`, "POST", {
          targetId: cats.callback.id,
        }),
        ctx(String(from.id)),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ moved: 2 });

      // La catégorie d'origine survit, vidée de ses fiches.
      expect(
        await testDb.select().from(categories).where(eq(categories.id, from.id)),
      ).toHaveLength(1);
      for (const id of [a.id, b.id]) {
        const [row] = await testDb.select().from(clients).where(eq(clients.id, id));
        expect(row.categoryId).toBe(cats.callback.id);
      }
      // Les fiches des autres catégories ne bougent pas.
      const [untouched] = await testDb.select().from(clients).where(eq(clients.id, other.id));
      expect(untouched.categoryId).toBe(cats.new.id);

      const [entry] = await testDb
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "category.transfer"));
      // Des ids (résolus à l'affichage selon la langue), pas des noms figés.
      expect(entry.detail).toMatchObject({
        count: 2,
        changes: { categoryId: { from: from.id, to: cats.callback.id } },
      });
    });

    it("déplace les fiches d'une source, cible nulle acceptée", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const from = await makeSource({ name: "Kijiji" });
      const client = await makeClient({ sourceId: from.id });

      const res = await sourceTransferRoute.POST(
        jsonRequest(`http://localhost/api/admin/sources/${from.id}/transfer`, "POST", {
          targetId: null,
        }),
        ctx(String(from.id)),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ moved: 1 });
      const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
      expect(row.sourceId).toBeNull();
    });

    it("refuse une cible inexistante et refuse un téléphoniste", async () => {
      const admin = await makeUser({ role: "admin" });
      const caller = await makeUser({ role: "caller" });
      const from = await makeSource({ name: "Kijiji" });
      const client = await makeClient({ sourceId: from.id });

      await loginAs(admin);
      const bad = await sourceTransferRoute.POST(
        jsonRequest(`http://localhost/api/admin/sources/${from.id}/transfer`, "POST", {
          targetId: 999_999,
        }),
        ctx(String(from.id)),
      );
      expect(bad.status).toBe(400);
      await expect(bad.json()).resolves.toEqual({ error: "invalid_target" });

      // Protection serveur : le téléphoniste n'a pas accès au pipeline.
      await loginAs(caller);
      const forbidden = await sourceTransferRoute.POST(
        jsonRequest(`http://localhost/api/admin/sources/${from.id}/transfer`, "POST", {
          targetId: null,
        }),
        ctx(String(from.id)),
      );
      expect(forbidden.status).toBe(403);
      const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
      expect(row.sourceId).toBe(from.id);
    });
  });

  // ══ Sources ════════════════════════════════════════════════════════════════

  describe("DELETE /api/admin/sources/[id]", () => {
    it("exige une destination explicite, puis réaffecte les fiches", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      const from = await makeSource({ name: "Kijiji" });
      const to = await makeSource({ name: "Site web" });
      const client = await makeClient({ sourceId: from.id });

      const missing = await sourceIdRoute.DELETE(
        jsonRequest(`http://localhost/api/admin/sources/${from.id}`, "DELETE"),
        ctx(String(from.id)),
      );
      expect(missing.status).toBe(400);
      await expect(missing.json()).resolves.toMatchObject({ error: "reassign_required" });

      const res = await sourceIdRoute.DELETE(
        jsonRequest(`http://localhost/api/admin/sources/${from.id}`, "DELETE", {
          reassignTo: to.id,
        }),
        ctx(String(from.id)),
      );
      expect(res.status).toBe(200);
      const [row] = await testDb.select().from(clients).where(eq(clients.id, client.id));
      expect(row.sourceId).toBe(to.id);
    });
  });

  // ══ DID voip.ms ════════════════════════════════════════════════════════════

  describe("GET /api/admin/voipms/dids", () => {
    const VOIPMS_DIDS = [
      { did: "4184761542", description: "Québec", routing: "account:551013_alex", pop: "1", state: "QC" },
      { did: "5145550142", description: "Montréal", routing: "account:551013", pop: "1", state: "QC" },
    ];

    function stubVoipms(payload: unknown) {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("marque un DID comme assigné quand un utilisateur le détient en E.164 (voip.ms renvoie les chiffres bruts)", async () => {
      const admin = await makeUser({ role: "admin" });
      const alex = await makeUser({
        name: "Alex",
        didNumber: "+14184761542",
        sipUsername: "551013_alex",
      });
      await loginAs(admin);
      const fetchMock = stubVoipms({ status: "success", dids: VOIPMS_DIDS });

      const res = await didsRoute.GET();
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        dids: {
          did: string;
          e164: string;
          assignedUserId: string | null;
          assignedUserName: string | null;
          assignedSipUsername: string | null;
          available: boolean;
        }[];
        availableCount: number;
        assignedCount: number;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain("method=getDIDsInfo");

      const assigned = body.dids.find((d) => d.did === "4184761542")!;
      expect(assigned.available).toBe(false);
      expect(assigned.assignedUserId).toBe(alex.id);
      expect(assigned.assignedUserName).toBe("Alex");
      expect(assigned.assignedSipUsername).toBe("551013_alex");
      expect(assigned.e164).toBe("+14184761542");

      const free = body.dids.find((d) => d.did === "5145550142")!;
      expect(free.available).toBe(true);
      expect(free.assignedUserId).toBeNull();

      expect(body.availableCount).toBe(1);
      expect(body.assignedCount).toBe(1);
      // Les disponibles remontent en tête.
      expect(body.dids[0].did).toBe("5145550142");
    });

    it("est réservé aux admins", async () => {
      const caller = await makeUser({ role: "caller" });
      stubVoipms({ status: "success", dids: VOIPMS_DIDS });

      const anon = await didsRoute.GET();
      expect(anon.status).toBe(401);

      await loginAs(caller);
      const forbidden = await didsRoute.GET();
      expect(forbidden.status).toBe(403);
    });

    it("remonte une erreur voip.ms en 502 sans planter", async () => {
      const admin = await makeUser({ role: "admin" });
      await loginAs(admin);
      stubVoipms({ status: "ip_not_enabled" });

      const res = await didsRoute.GET();
      expect(res.status).toBe(502);
      await expect(res.json()).resolves.toMatchObject({
        error: "voipms",
        status: "ip_not_enabled",
      });
    });

    it("réassigner un DID le retire de son détenteur précédent (jamais partagé à deux)", async () => {
      const admin = await makeUser({ role: "admin" });
      const alex = await makeUser({ name: "Alex", didNumber: "+14184761542" });
      const sam = await makeUser({ name: "Sam" });
      await loginAs(admin);

      const res = await userIdRoute.PATCH(
        jsonRequest(`http://localhost/api/admin/users/${sam.id}`, "PATCH", {
          didNumber: "418-476-1542",
        }),
        ctx(sam.id),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        user: { didNumber: string | null };
        released: { id: string }[];
      };
      expect(body.user.didNumber).toBe("+14184761542");
      expect(body.released.map((r) => r.id)).toEqual([alex.id]);

      const [alexAfter] = await testDb.select().from(users).where(eq(users.id, alex.id));
      const [samAfter] = await testDb.select().from(users).where(eq(users.id, sam.id));
      expect(alexAfter.didNumber).toBeNull();
      expect(samAfter.didNumber).toBe("+14184761542");

      // Le listing ne montre plus qu'un seul détenteur.
      stubVoipms({ status: "success", dids: VOIPMS_DIDS });
      const listing = await didsRoute.GET();
      const { dids } = (await listing.json()) as {
        dids: { did: string; assignedUserId: string | null }[];
      };
      const holders = dids.filter((d) => d.did === "4184761542").map((d) => d.assignedUserId);
      expect(holders).toEqual([samAfter.id]);
    });
  });
});
