/**
 * Intégration — seedSms() (src/db/seed-sms.ts)
 *
 * Vérifie le contenu semé (prompt core OACIQ, 6 règles/14 fixtures/4 paquets
 * de garde-fous, 4 assistants brouillons) et surtout l'idempotence : rejouer
 * le seed ne doit ni dupliquer ni planter.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, resetDb, testDb } from "./helpers/db";
import {
  assistants,
  guardrailFixtures,
  guardrailRules,
  objectionPacks,
  promptCores,
} from "@/db/schema-sms";

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

const { seedSms } = await import("@/db/seed-sms");

describe("seedSms", () => {
  beforeEach(resetDb);
  afterAll(closeDb);

  it("sème le prompt core OACIQ, les garde-fous, les paquets d'objections et 4 assistants", async () => {
    await seedSms();

    const cores = await testDb.select().from(promptCores);
    expect(cores).toHaveLength(1);
    expect(cores[0]!.version).toBe(1);
    expect(cores[0]!.body).toContain("# LIMITES PROFESSIONNELLES (OACIQ)");

    const rules = await testDb.select().from(guardrailRules);
    expect(rules).toHaveLength(6);
    for (const rule of rules) {
      expect(rule.origin).toBe("default");
      expect(rule.defaultSnapshot).not.toBeNull();
    }

    const fixtures = await testDb.select().from(guardrailFixtures);
    expect(fixtures).toHaveLength(14);

    const packs = await testDb.select().from(objectionPacks);
    expect(packs).toHaveLength(4);

    const assistantRows = await testDb.select().from(assistants);
    expect(assistantRows).toHaveLength(4);
    for (const row of assistantRows) {
      expect(row.status).toBe("draft");
    }
    const byName = Object.fromEntries(assistantRows.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(
      ["Acheteur FB", "Long terme", "Réactivation 90 j", "Vendeur FB"].sort(),
    );

    // La Réactivation 90 j ne doit jamais pouvoir réserver.
    const reengage = byName["Réactivation 90 j"]!;
    expect(reengage.tools).not.toContain("book_meeting");

    const acheteur = byName["Acheteur FB"]!;
    expect(acheteur.objectionPacks).toEqual(["buyer_fr"]);
    expect((acheteur.goal as { primary: { type: string } }).primary.type).toBe("video_meeting");
  });

  it("est idempotent : rejouer le seed produit les mêmes comptes", async () => {
    await seedSms();
    await seedSms();

    expect(await testDb.select().from(promptCores)).toHaveLength(1);
    expect(await testDb.select().from(guardrailRules)).toHaveLength(6);
    expect(await testDb.select().from(guardrailFixtures)).toHaveLength(14);
    expect(await testDb.select().from(objectionPacks)).toHaveLength(4);

    const assistantRows = await testDb.select().from(assistants);
    expect(assistantRows).toHaveLength(4);
    expect(assistantRows.every((r) => r.status === "draft")).toBe(true);

    // Toujours les mêmes 4 lignes (une seule par nom), pas des doublons.
    const byName = await testDb
      .select()
      .from(assistants)
      .where(eq(assistants.name, "Acheteur FB"));
    expect(byName).toHaveLength(1);
  });
});
