/**
 * Intégration — prise de leads entrants : POST /api/webhooks/leads
 *
 * Route critique pour le revenu : un lead ne doit JAMAIS être perdu.
 * On exerce le vrai handler exporté avec de vraies `Request`, sur la base
 * de test locale. Aucun accès réseau.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, makeCategory, makeClient, makeUser, resetDb, seedSystemCategories, testDb } from "./helpers/db";
import { auditLogs, categories, clients, notifications, sources, users, webhookKeys } from "@/db/schema";

// ── Stubs d'environnement Next (aucune logique produit n'est simulée) ────────
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

const { POST } = await import("@/app/api/webhooks/leads/route");
const { encryptSecret, sha256Hex } = await import("@/lib/crypto");

const URL_LEADS = "http://localhost:3000/api/webhooks/leads";

async function makeKey(
  plain: string,
  overrides: Partial<typeof webhookKeys.$inferInsert> = {},
) {
  const [row] = await testDb
    .insert(webhookKeys)
    .values({
      name: overrides.name ?? "n8n Facebook",
      keyEnc: encryptSecret(plain),
      keyHash: sha256Hex(plain),
      keyLast4: plain.slice(-4),
      defaults: overrides.defaults ?? null,
      isActive: overrides.isActive ?? true,
      ...overrides,
    })
    .returning();
  return row;
}

function leadRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(URL_LEADS, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Charge utile RÉELLE du workflow n8n / Facebook Lead Ads du client. */
function facebookPayload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      nom_complet: "Marie Tremblay",
      "numéro_de_téléphone": "+1 418-476-1542",
      "e-mail": "marie.tremblay@example.com",
      "quel_est_votre_besoin_?": "Vendre ma maison",
      "votre_projet_est_prévu_pour_quand_?": "0-3 mois",
      ...overrides,
    },
  };
}

const KEY = "abcdef0123456789abcdef0123456789";

describe("POST /api/webhooks/leads", () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  // ── Authentification ──────────────────────────────────────────────────────

  describe("authentification par clé API", () => {
    it("refuse (401) une requête sans clé", async () => {
      await makeKey(KEY);
      const res = await POST(leadRequest(facebookPayload()));
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("refuse (401) une mauvaise clé", async () => {
      await makeKey(KEY);
      const res = await POST(
        leadRequest(facebookPayload(), { "x-api-key": "not-the-right-key" }),
      );
      expect(res.status).toBe(401);
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("refuse (401) une clé désactivée", async () => {
      await makeKey(KEY, { isActive: false });
      const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
      expect(res.status).toBe(401);
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("accepte la clé via x-api-key", async () => {
      await makeKey(KEY);
      const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true, created: true });
    });

    it("accepte la clé via Authorization: Bearer", async () => {
      await makeKey(KEY);
      const res = await POST(
        leadRequest(facebookPayload(), { authorization: `Bearer ${KEY}` }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; clientId: string };
      expect(body.ok).toBe(true);
      const [client] = await testDb.select().from(clients).where(eq(clients.id, body.clientId));
      expect(client.phone).toBe("+14184761542");
    });
  });

  // ── Création de lead ──────────────────────────────────────────────────────

  describe("création du lead", () => {
    it("crée un client depuis la charge utile Facebook/n8n imbriquée à clés accentuées", async () => {
      const cats = await seedSystemCategories();
      const key = await makeKey(KEY);

      const payload = facebookPayload();
      const res = await POST(leadRequest(payload, { "x-api-key": KEY }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; clientId: string; created: boolean };
      expect(body).toMatchObject({ ok: true, created: true });

      const [client] = await testDb.select().from(clients).where(eq(clients.id, body.clientId));
      expect(client.fullName).toBe("Marie Tremblay");
      expect(client.phone).toBe("+14184761542"); // E.164
      expect(client.email).toBe("marie.tremblay@example.com");
      expect(client.projectType).toBe("Vendre ma maison");
      expect(client.timing).toBe("0-3 mois");
      // meta = charge utile brute, telle quelle (traçabilité n8n).
      expect(client.meta).toEqual(payload);
      // Sans défaut de clé : catégorie « Non contacté ».
      expect(client.categoryId).toBe(cats.new.id);
      expect(key.name).toBe("n8n Facebook");
    });

    it("accepte la variante plate en anglais (name / phone / email)", async () => {
      await seedSystemCategories();
      await makeKey(KEY);

      const payload = {
        name: "John Smith",
        phone: "(514) 555-0142",
        email: "john@example.com",
        city: "Laval",
        notes: "Rappeler en soirée",
        type: "acheter",
        timing: "6-12 mois",
      };
      const res = await POST(leadRequest(payload, { "x-api-key": KEY }));
      expect(res.status).toBe(200);
      const { clientId } = (await res.json()) as { clientId: string };

      const [client] = await testDb.select().from(clients).where(eq(clients.id, clientId));
      expect(client.fullName).toBe("John Smith");
      expect(client.phone).toBe("+15145550142");
      expect(client.email).toBe("john@example.com");
      expect(client.city).toBe("Laval");
      expect(client.notes).toBe("Rappeler en soirée");
      expect(client.projectType).toBe("acheter");
      expect(client.timing).toBe("6-12 mois");
      expect(client.meta).toEqual(payload);
    });

    it("applique catégorie, source et assigné par défaut de la clé", async () => {
      const cats = await seedSystemCategories();
      const custom = await makeCategory({ nameFr: "Lead chaud", nameEn: "Hot lead" });
      const [src] = await testDb.insert(sources).values({ name: "Facebook" }).returning();
      const caller = await makeUser({ role: "caller", name: "Alex" });
      await makeKey(KEY, {
        defaults: { categoryId: custom.id, sourceId: src.id, assignedToId: caller.id },
      });

      const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
      expect(res.status).toBe(200);
      const { clientId } = (await res.json()) as { clientId: string };

      const [client] = await testDb.select().from(clients).where(eq(clients.id, clientId));
      expect(client.categoryId).toBe(custom.id);
      expect(client.categoryId).not.toBe(cats.new.id);
      expect(client.sourceId).toBe(src.id);
      expect(client.assignedToId).toBe(caller.id);
    });

    it("nomme le client avec son numéro formaté quand le nom manque", async () => {
      await makeKey(KEY);
      const res = await POST(
        leadRequest({ phone: "4184761542" }, { "x-api-key": KEY }),
      );
      expect(res.status).toBe(200);
      const { clientId } = (await res.json()) as { clientId: string };
      const [client] = await testDb.select().from(clients).where(eq(clients.id, clientId));
      expect(client.fullName).toBe("(418) 476-1542");
    });

    it("journalise l'intake dans l'audit", async () => {
      await makeKey(KEY);
      const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
      const { clientId } = (await res.json()) as { clientId: string };

      const logs = await testDb.select().from(auditLogs);
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("webhook.lead");
      expect(logs[0].entityId).toBe(clientId);
      expect(logs[0].detail).toMatchObject({ created: true, keyName: "n8n Facebook" });
    });
  });

  // ── Notifications ─────────────────────────────────────────────────────────

  describe("notifications", () => {
    it("notifie tous les admins actifs (et pas les inactifs ni les téléphonistes)", async () => {
      const adminFr = await makeUser({ role: "admin", locale: "fr", name: "Patron" });
      const adminEn = await makeUser({ role: "admin", locale: "en", name: "Boss" });
      const adminOff = await makeUser({ role: "admin", isActive: false, name: "Ancien" });
      const caller = await makeUser({ role: "caller", name: "Téléphoniste" });
      await makeKey(KEY);

      const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
      const { clientId } = (await res.json()) as { clientId: string };

      const rows = await testDb.select().from(notifications);
      const byUser = new Map(rows.map((r) => [r.userId, r]));
      expect(byUser.size).toBe(2);
      expect(byUser.has(adminFr.id)).toBe(true);
      expect(byUser.has(adminEn.id)).toBe(true);
      expect(byUser.has(adminOff.id)).toBe(false);
      expect(byUser.has(caller.id)).toBe(false);

      expect(byUser.get(adminFr.id)!.title).toBe("Nouveau lead : Marie Tremblay");
      expect(byUser.get(adminFr.id)!.body).toBe("(418) 476-1542 — via n8n Facebook");
      expect(byUser.get(adminEn.id)!.title).toBe("New lead: Marie Tremblay");
      expect(byUser.get(adminFr.id)!.type).toBe("incoming_lead");
      expect(byUser.get(adminFr.id)!.link).toBe(`/clients/${clientId}`);
    });

    it("notifie aussi le téléphoniste assigné par défaut", async () => {
      const admin = await makeUser({ role: "admin", locale: "fr" });
      const caller = await makeUser({ role: "caller", locale: "en", name: "Alex" });
      await makeKey(KEY, { defaults: { assignedToId: caller.id } });

      await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));

      const rows = await testDb.select().from(notifications);
      expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([admin.id, caller.id]));
    });
  });

  // ── Dédoublonnage ─────────────────────────────────────────────────────────

  describe("dédoublonnage par téléphone", () => {
    it("met à jour au lieu de dupliquer quand le numéro arrive dans un autre format", async () => {
      await seedSystemCategories();
      await makeKey(KEY);
      const existing = await makeClient({
        fullName: "Marie T.",
        phone: "+14184761542",
        categoryId: null,
      });

      const res = await POST(
        leadRequest(
          facebookPayload({ "numéro_de_téléphone": "418.476.1542" }),
          { "x-api-key": KEY },
        ),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ created: false, clientId: existing.id });

      const all = await testDb.select().from(clients);
      expect(all).toHaveLength(1);
      // Les champs vides sont complétés, le nom existant est conservé.
      expect(all[0].fullName).toBe("Marie T.");
      expect(all[0].email).toBe("marie.tremblay@example.com");
      expect(all[0].timing).toBe("0-3 mois");
      expect(all[0].projectType).toBe("Vendre ma maison");
      // Trace du nouveau lead dans meta.
      expect((all[0].meta as Record<string, unknown>).lastWebhook).toMatchObject({
        keyName: "n8n Facebook",
      });
    });

    it("RÉGRESSION : un numéro correspondant au phoneAlt d'un client existant dédoublonne aussi", async () => {
      await makeKey(KEY);
      const existing = await makeClient({
        fullName: "Marie T.",
        phone: "+15145550000",
        phoneAlt: "+14184761542",
      });

      const res = await POST(
        leadRequest(
          facebookPayload({ "numéro_de_téléphone": "(418) 476-1542" }),
          { "x-api-key": KEY },
        ),
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ created: false, clientId: existing.id });
      expect(await testDb.select().from(clients)).toHaveLength(1);
    });

    it("ne réanime PAS un client marqué « ne pas appeler »", async () => {
      await seedSystemCategories();
      await makeKey(KEY);
      await makeClient({ phone: "+14184761542", doNotCall: true, categoryId: null });

      const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
      expect(res.status).toBe(200);

      const [client] = await testDb.select().from(clients);
      expect(client.doNotCall).toBe(true);
    });

    it("n'écrase pas une catégorie déjà attribuée, mais remplit une catégorie nulle", async () => {
      const cats = await seedSystemCategories();
      await makeKey(KEY, { defaults: { categoryId: cats.callback.id } });
      const withCat = await makeClient({
        phone: "+14184761542",
        categoryId: cats.not_interested.id,
      });
      const withoutCat = await makeClient({ phone: "+15145550199", categoryId: null });

      await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
      await POST(
        leadRequest(
          facebookPayload({ "numéro_de_téléphone": "514-555-0199" }),
          { "x-api-key": KEY },
        ),
      );

      const [a] = await testDb.select().from(clients).where(eq(clients.id, withCat.id));
      const [b] = await testDb.select().from(clients).where(eq(clients.id, withoutCat.id));
      expect(a.categoryId).toBe(cats.not_interested.id);
      expect(b.categoryId).toBe(cats.new.id);
    });

    it("notifie avec le libellé « client existant » lors d'un doublon", async () => {
      const admin = await makeUser({ role: "admin", locale: "fr" });
      await makeKey(KEY);
      await makeClient({ phone: "+14184761542" });

      await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));

      const rows = await testDb.select().from(notifications).where(eq(notifications.userId, admin.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe("Client existant recontacté — (418) 476-1542 — via n8n Facebook");
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe("validation de la charge utile", () => {
    it("refuse (422) un lead sans téléphone", async () => {
      await makeKey(KEY);
      const res = await POST(
        leadRequest({ data: { nom_complet: "Sans Numéro" } }, { "x-api-key": KEY }),
      );
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toEqual({ error: "invalid_phone" });
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("refuse (422) un téléphone sans aucun chiffre", async () => {
      await makeKey(KEY);
      const res = await POST(
        leadRequest(facebookPayload({ "numéro_de_téléphone": "à venir" }), {
          "x-api-key": KEY,
        }),
      );
      expect(res.status).toBe(422);
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("refuse (413) un corps de plus de 100 Ko", async () => {
      await makeKey(KEY);
      const huge = { data: { nom_complet: "X".repeat(120_000), phone: "4184761542" } };
      const res = await POST(leadRequest(huge, { "x-api-key": KEY }));
      expect(res.status).toBe(413);
      await expect(res.json()).resolves.toEqual({ error: "payload_too_large" });
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });

    it("refuse (413) sur l'en-tête content-length annoncé, sans lire le corps", async () => {
      await makeKey(KEY);
      const res = await POST(
        leadRequest(facebookPayload(), { "x-api-key": KEY, "content-length": "999999" }),
      );
      expect(res.status).toBe(413);
    });

    it("répond 400 (et non 500) sur du JSON malformé", async () => {
      await makeKey(KEY);
      const res = await POST(leadRequest("{ ceci n'est pas du json", { "x-api-key": KEY }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid_json" });
    });

    it("répond 400 sur un corps JSON qui n'est pas un objet", async () => {
      await makeKey(KEY);
      const res = await POST(leadRequest([{ phone: "4184761542" }], { "x-api-key": KEY }));
      expect(res.status).toBe(400);
      expect(await testDb.select().from(clients)).toHaveLength(0);
    });
  });

  // ── Robustesse des défauts de clé ─────────────────────────────────────────

  describe("robustesse", () => {
    it("horodate lastUsedAt de la clé après un lead accepté", async () => {
      const key = await makeKey(KEY);
      expect(key.lastUsedAt).toBeNull();

      await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));

      const [after] = await testDb.select().from(webhookKeys).where(eq(webhookKeys.id, key.id));
      expect(after.lastUsedAt).toBeInstanceOf(Date);
      expect(after.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it("RÉGRESSION : une catégorie/source/assigné par défaut supprimé ne fait pas perdre le lead", async () => {
      const cats = await seedSystemCategories();
      // Catégorie et source supprimées + utilisateur disparu → ids orphelins.
      const ghostCategory = await makeCategory({ nameFr: "Fantôme", nameEn: "Ghost" });
      const [ghostSource] = await testDb.insert(sources).values({ name: "Fantôme" }).returning();
      const ghostUser = await makeUser({ role: "caller" });
      await makeKey(KEY, {
        defaults: {
          categoryId: ghostCategory.id,
          sourceId: ghostSource.id,
          assignedToId: ghostUser.id,
        },
      });
      await testDb.delete(sources).where(eq(sources.id, ghostSource.id));
      await testDb.delete(categories).where(eq(categories.id, ghostCategory.id));
      await testDb.delete(users).where(eq(users.id, ghostUser.id));

      const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
      expect(res.status).toBe(200);
      const { clientId } = (await res.json()) as { clientId: string };

      const [client] = await testDb.select().from(clients).where(eq(clients.id, clientId));
      expect(client.phone).toBe("+14184761542");
      // Repli sur « Non contacté », aucune source ni assignation fantôme.
      expect(client.categoryId).toBe(cats.new.id);
      expect(client.sourceId).toBeNull();
      expect(client.assignedToId).toBeNull();
    });

    it("résout la source par son nom quand la charge utile en fournit une", async () => {
      const [fb] = await testDb.insert(sources).values({ name: "Facebook" }).returning();
      const [site] = await testDb.insert(sources).values({ name: "Site web" }).returning();
      await makeKey(KEY, { defaults: { sourceId: site.id } });

      const res = await POST(
        leadRequest({ phone: "4184761542", source: "facebook" }, { "x-api-key": KEY }),
      );
      const { clientId } = (await res.json()) as { clientId: string };
      const [client] = await testDb.select().from(clients).where(eq(clients.id, clientId));
      expect(client.sourceId).toBe(fb.id);
      expect(fb.id).not.toBe(site.id);
    });
  });
});
