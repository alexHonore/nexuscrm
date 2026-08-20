/**
 * Intégration — registre de consentement SMS alimenté par le webhook de leads.
 *
 * Une demande Facebook Lead Ads (via n8n) vaut consentement tacite LCAP/CASL
 * aux SMS pour 6 mois. On exerce le vrai handler POST /api/webhooks/leads sur
 * la base de test locale. Aucun accès réseau.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMonths, addYears } from "date-fns";
import { closeDb, makeClient, resetDb, testDb } from "./helpers/db";
import { webhookKeys } from "@/db/schema";
import { consents } from "@/db/schema-sms";

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
const { setSetting } = await import("@/lib/settings");

const URL_LEADS = `${process.env.NEXT_PUBLIC_APP_URL}/api/webhooks/leads`;
const KEY = "abcdef0123456789abcdef0123456789";

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

describe("POST /api/webhooks/leads — consentement SMS", () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  it("un nouveau lead crée exactement un consentement SMS tacite (défaut : illimité)", async () => {
    const key = await makeKey(KEY);

    const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    expect(res.status).toBe(200);
    const { clientId } = (await res.json()) as { clientId: string };

    const rows = await testDb.select().from(consents);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.clientId).toBe(clientId);
    expect(row.channel).toBe("sms");
    expect(row.kind).toBe("implied_inquiry");
    expect(row.source).toContain(key.name);
    expect(row.revokedAt).toBeNull();
    // Défaut « illimité » (choix de l'admin) : aucune échéance estampillée.
    expect(row.expiresAt).toBeNull();
  });

  it("respecte le réglage sms.consentValidity : 6 mois (fenêtre LCAP)", async () => {
    await makeKey(KEY);
    await setSetting("sms", { consentValidity: "6m" });

    const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(consents);
    expect(row.expiresAt).toBeInstanceOf(Date);
    const expected = addMonths(row.grantedAt, 6).getTime();
    expect(Math.abs(row.expiresAt!.getTime() - expected)).toBeLessThan(60_000);
  });

  it("respecte le réglage sms.consentValidity : 2 ans", async () => {
    await makeKey(KEY);
    await setSetting("sms", { consentValidity: "2y" });

    const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(consents);
    expect(row.expiresAt).toBeInstanceOf(Date);
    const expected = addYears(row.grantedAt, 2).getTime();
    expect(Math.abs(row.expiresAt!.getTime() - expected)).toBeLessThan(60_000);
  });

  it("respecte le réglage sms.consentValidity : illimité (expiresAt null)", async () => {
    await makeKey(KEY);
    await setSetting("sms", { consentValidity: "unlimited" });

    const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    expect(res.status).toBe(200);

    const [row] = await testDb.select().from(consents);
    expect(row.expiresAt).toBeNull();
  });

  it("le même numéro reposté immédiatement ne crée pas de doublon (dédoublonnage 24 h)", async () => {
    await makeKey(KEY);

    const res1 = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    const res2 = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Les reprises n8n ne doivent pas gonfler le registre.
    expect(await testDb.select().from(consents)).toHaveLength(1);
  });

  it("un client existant reçoit le consentement sur SON id", async () => {
    await makeKey(KEY);
    const existing = await makeClient({ fullName: "Marie T.", phone: "+14184761542" });

    const res = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ created: false, clientId: existing.id });

    const rows = await testDb.select().from(consents).where(eq(consents.clientId, existing.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("sms");
    expect(rows[0].kind).toBe("implied_inquiry");
  });

  it("la preuve embarque le nom de la clé webhook (evidence.keyName)", async () => {
    await makeKey(KEY, { name: "n8n Facebook" });

    await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));

    const [row] = await testDb.select().from(consents);
    expect((row.evidence as Record<string, unknown>).keyName).toBe("n8n Facebook");
  });

  it("la forme de la réponse { ok, clientId, created } reste inchangée", async () => {
    await makeKey(KEY);

    // Nouveau client…
    const res1 = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as Record<string, unknown>;
    expect(Object.keys(body1).sort()).toEqual(["clientId", "created", "ok"]);
    expect(body1.ok).toBe(true);
    expect(body1.created).toBe(true);
    expect(typeof body1.clientId).toBe("string");

    // …puis doublon (chemin « mise à jour »).
    const res2 = await POST(leadRequest(facebookPayload(), { "x-api-key": KEY }));
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(Object.keys(body2).sort()).toEqual(["clientId", "created", "ok"]);
    expect(body2).toMatchObject({ ok: true, created: false, clientId: body1.clientId });
  });
});
