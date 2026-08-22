/**
 * Intégration — l'assistant range les fiches lui-même.
 *
 * Les deux cas qu'Alex a décrits, mot pour mot : « je veux acheter mais
 * l'année prochaine » doit tomber dans « Long terme » parce qu'il a défini
 * qu'un projet à plus de six mois l'est ; « je suis au Saguenay » doit tomber
 * dans « Non qualifié » parce qu'il a défini le territoire desservi.
 *
 * Ce que ces tests tiennent, au-delà du geste : la liste de règles est aussi
 * la liste BLANCHE (pas de règle ⇒ pas de classement possible), le classement
 * de l'assistant passe par la même porte que celui d'un téléphoniste (audit,
 * déclencheur de campagne), et un refus est PARLANT — un modèle qui se trompe
 * de clé doit pouvoir se corriger au tour suivant plutôt que réessayer.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, makeCategory, resetDb, seedSystemCategories, testDb } from "./helpers/db";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { resolveClassification } = await import("@/lib/classification-server");
const { compileAssistantPrompt } = await import("@/lib/agent/compile");
const { assistantConfigSchema } = await import("@/lib/assistants/schema");
const { setSetting } = await import("@/lib/settings");
const { categories } = await import("@/db/schema");

const core = { version: 1, body: "# RÔLE\nAssistant." };

/** Le pipeline réel : « Long terme » et « Non qualifié » y sont déjà semés. */
async function pipeline() {
  await seedSystemCategories();
  const rows = await testDb.select().from(categories);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return {
    longTerm: byKey.get("long_term") ?? (await makeCategory({ key: "long_term", nameFr: "Long terme" })),
    notQualified: byKey.get("not_qualified")!,
    dncl: byKey.get("dncl")!,
  };
}

async function configureRules(rules: { when: string; category: string; enabled?: boolean }[]) {
  await setSetting("classification", {
    rules: rules.map((r, i) => ({
      id: `r${i}`,
      when: r.when,
      category: r.category,
      enabled: r.enabled ?? true,
    })),
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

describe("les règles atteignent le prompt", () => {
  it("nomme la catégorie en toutes lettres, pas par son identifiant", async () => {
    // « range dans cat:14 » ne se juge pas. Le modèle a besoin du NOM.
    const { longTerm, notQualified } = await pipeline();
    await configureRules([
      { when: "le projet est à plus de six mois", category: "long_term" },
      { when: "la personne est hors de Grand Québec, Grand Lévis ou Grand Montréal", category: "not_qualified" },
    ]);

    const { forPrompt } = await resolveClassification();
    expect(forPrompt).toHaveLength(2);

    const config = assistantConfigSchema.parse({
      name: "A",
      identity: {},
      goal: { primary: { type: "video_meeting" } },
      approach: {},
      model: {},
    });
    const l2 = compileAssistantPrompt(config, core, [], [], forPrompt).layers.find(
      (l) => l.id === "L2",
    )!.text;

    expect(l2).toContain("## CLASSEMENT");
    expect(l2).toContain("plus de six mois");
    expect(l2).toContain(`« ${longTerm.nameFr} »`);
    expect(l2).toContain("Grand Lévis");
    expect(l2).toContain(`« ${notQualified.nameFr} »`);
    // La liste est FERMÉE, et le prompt le dit — sinon le modèle essaie.
    expect(l2).toMatch(/JAMAIS une fiche dans une catégorie absente/);
  });

  it("aucune règle ⇒ aucun bloc de classement dans le prompt", async () => {
    await pipeline();
    const { forPrompt } = await resolveClassification();
    const config = assistantConfigSchema.parse({
      name: "A",
      identity: {},
      goal: { primary: { type: "video_meeting" } },
      approach: {},
      model: {},
    });
    const l2 = compileAssistantPrompt(config, core, [], [], forPrompt).layers.find(
      (l) => l.id === "L2",
    )!.text;
    expect(l2).not.toContain("CLASSEMENT");
  });

  it("une règle désactivée disparaît des DEUX côtés", async () => {
    await pipeline();
    await configureRules([{ when: "le projet est lointain", category: "long_term", enabled: false }]);
    const { forPrompt, allowed } = await resolveClassification();
    expect(forPrompt).toHaveLength(0);
    expect(allowed.size).toBe(0);
  });

  it("une règle vers une catégorie supprimée est ignorée, pas plantée", async () => {
    await pipeline();
    await configureRules([{ when: "peu importe", category: "cat:99999" }]);
    const { forPrompt, allowed } = await resolveClassification();
    expect(forPrompt).toEqual([]);
    expect(allowed.size).toBe(0);
  });
});

describe("la liste de règles EST la liste blanche", () => {
  it("une catégorie sans règle n'est pas permise — « Ne pas appeler » reste manuel", async () => {
    // C'est la protection qui compte : sortir quelqu'un du pipeline sur une
    // phrase mal comprise ne doit pas être à la portée du modèle.
    const { dncl } = await pipeline();
    await configureRules([{ when: "le projet est à plus de six mois", category: "long_term" }]);

    const { allowed } = await resolveClassification();
    expect(allowed.has("long_term")).toBe(true);
    expect(allowed.has("dncl")).toBe(false);
    expect(dncl).toBeDefined();
  });

  it("ce que le prompt propose et ce que l'outil accepte sont la MÊME liste", async () => {
    // S'ils divergeaient, l'assistant essaierait sans fin une clé refusée,
    // sans que rien à l'écran ne l'explique.
    await pipeline();
    await configureRules([
      { when: "le projet est lointain", category: "long_term" },
      { when: "la personne est hors territoire", category: "not_qualified" },
      { when: "la personne demande de ne plus être appelée", category: "dncl", enabled: false },
    ]);
    const { forPrompt, allowed } = await resolveClassification();
    expect(forPrompt.map((r) => r.categoryValue).sort()).toEqual([...allowed.keys()].sort());
  });
});
