/**
 * Unitaire — normalisations du schéma d'assistant.
 *
 * Deux pièges fermés ici : un cran de réservation sans type de rendez-vous
 * (le prompt promet un appel que les outils d'agenda refusent), et un objectif
 * dont les champs imposés manquent (« obtenir le courriel » sans « courriel »
 * requis). Les deux sont COMPLÉTÉS à la lecture, jamais refusés : des fiches
 * déjà en base les décrivent ainsi et doivent rester lisibles.
 */
import { describe, expect, it } from "vitest";
import {
  GOAL_TYPES,
  TYPE_MANDATED_FIELDS,
  assistantConfigInputSchema,
  assistantConfigSchema,
  customQualificationFields,
  classifierChain,
  goalConfigSchema,
  goalStepSchema,
  modelChain,
  retryPolicyFor,
  withModelFallbackChain,
  DEFAULT_MODEL_FALLBACK,
} from "@/lib/assistants/schema";

describe("goalStepSchema — type de rendez-vous", () => {
  it("un appel sans type de rendez-vous reçoit « meet »", () => {
    const step = goalStepSchema.parse({ type: "phone_call", durationMin: 15 });
    expect(step.appointmentType).toBe("meet");
  });

  it("visio → meet, en personne → inperson ; un choix explicite est conservé", () => {
    expect(goalStepSchema.parse({ type: "video_meeting" }).appointmentType).toBe("meet");
    expect(goalStepSchema.parse({ type: "in_person_meeting" }).appointmentType).toBe("inperson");
    expect(
      goalStepSchema.parse({ type: "phone_call", appointmentType: "inperson" }).appointmentType,
    ).toBe("inperson");
  });

  it("un objectif qui ne réserve rien garde null", () => {
    for (const type of ["collect_email", "collect_callback_time", "qualify_only", "handoff"] as const) {
      expect(goalStepSchema.parse({ type }).appointmentType).toBeNull();
    }
  });
});

describe("goalStepSchema — champs imposés par le type", () => {
  it("chaque type reçoit ses champs imposés, l'ordre saisi est conservé", () => {
    for (const type of GOAL_TYPES) {
      const step = goalStepSchema.parse({ type, requiredFields: ["timing"] });
      expect(step.requiredFields[0]).toBe("timing");
      for (const field of TYPE_MANDATED_FIELDS[type]) expect(step.requiredFields).toContain(field);
    }
  });

  it("« obtenir le courriel » exige toujours le courriel, sans doublon", () => {
    const step = goalStepSchema.parse({ type: "collect_email", requiredFields: ["email"] });
    expect(step.requiredFields).toEqual(["email"]);
    expect(goalStepSchema.parse({ type: "collect_email" }).requiredFields).toEqual(["email"]);
  });

  it("la normalisation est idempotente : relire une config normalisée ne change rien", () => {
    const once = assistantConfigSchema.parse({
      name: "X",
      identity: {},
      goal: { primary: { type: "phone_call", durationMin: 10 }, fallbacks: [{ type: "collect_email" }] },
      approach: {},
      model: {},
    });
    expect(assistantConfigSchema.parse(once)).toEqual(once);
  });
});

describe("assistantConfigInputSchema — ce qui ARRIVE", () => {
  const base = {
    name: "X",
    identity: {},
    goal: { primary: { type: "qualify_only" }, fallbacks: [] },
    approach: {},
    model: {},
  };

  it("un prompt libre vide est refusé à l'entrée, avec le champ en cause", () => {
    const result = assistantConfigInputSchema.safeParse({ ...base, promptMode: "raw" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "systemPromptOverride")).toBe(true);
    }
    expect(
      assistantConfigInputSchema.safeParse({ ...base, promptMode: "raw", systemPromptOverride: "   " })
        .success,
    ).toBe(false);
  });

  it("un prompt libre rempli, ou le mode composé sans texte, passent", () => {
    expect(
      assistantConfigInputSchema.safeParse({ ...base, promptMode: "raw", systemPromptOverride: "Tu es…" })
        .success,
    ).toBe(true);
    expect(assistantConfigInputSchema.safeParse(base).success).toBe(true);
  });

  it("la lecture d'une rangée existante reste tolérante (schéma de stockage)", () => {
    // Une fiche déjà en base avec un prompt libre vide doit rester OUVRABLE :
    // le refus vaut pour ce qui arrive, pas pour ce qui est déjà là.
    expect(assistantConfigSchema.safeParse({ ...base, promptMode: "raw" }).success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// customQualificationFields — champs requis LIBRES de la chaîne d'objectifs
// ═══════════════════════════════════════════════════════════════════════════

describe("customQualificationFields", () => {
  it("extrait les champs hors vocabulaire, dédoublonnés, sur TOUS les crans", () => {
    const goal = goalConfigSchema.parse({
      primary: {
        type: "video_meeting",
        requiredFields: ["timing", "budget", "type de propriété recherché"],
      },
      fallbacks: [
        { type: "phone_call", requiredFields: ["budget", "type de propriété recherché", "nombre de chambres"] },
      ],
    });
    expect(customQualificationFields(goal)).toEqual([
      "type de propriété recherché",
      "nombre de chambres",
    ]);
  });

  it("chaîne 100 % canonique → aucun champ libre", () => {
    const goal = goalConfigSchema.parse({
      primary: { type: "video_meeting", requiredFields: ["timing", "budget", "email"] },
      fallbacks: [],
    });
    expect(customQualificationFields(goal)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Chaîne de replis du modèle
// ═══════════════════════════════════════════════════════════════════════════

describe("model.fallbacks — la chaîne de replis", () => {
  const parse = (model: unknown) =>
    assistantConfigSchema.parse({
      name: "X",
      identity: {},
      goal: { primary: { type: "phone_call", durationMin: 10 }, fallbacks: [] },
      approach: {},
      model,
    }).model;

  it("sans rien dire : un cran de repli, chez un fournisseur DIRECT", () => {
    expect(parse({}).fallbacks).toEqual([DEFAULT_MODEL_FALLBACK]);
    expect(DEFAULT_MODEL_FALLBACK.provider).not.toBe("openrouter");
  });

  it("accepte trois crans, refuse le quatrième", () => {
    const three = [
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "google", model: "gemini-2.5-pro" },
      { provider: "openai", model: "gpt-5" },
    ];
    expect(parse({ fallbacks: three }).fallbacks).toHaveLength(3);
    expect(() => parse({ fallbacks: [...three, { provider: "openrouter", model: "x" }] })).toThrow();
  });

  it("un tableau vide = aucun repli, et ça se relit tel quel", () => {
    expect(parse({ fallbacks: [] }).fallbacks).toEqual([]);
  });

  it("une fiche d'AVANT la chaîne garde son repli — et un `fallback: null` reste sans repli", () => {
    // Les rangées déjà en base portent `fallback: {…} | null`. Les relire
    // telles quelles remettrait le repli du DÉFAUT à la place de celui que
    // l'exploitant a choisi (ou retiré).
    expect(
      parse(withModelFallbackChain({ fallback: { provider: "google", model: "gemini-2.5-pro" } }))
        .fallbacks,
    ).toEqual([{ provider: "google", model: "gemini-2.5-pro" }]);
    expect(parse(withModelFallbackChain({ fallback: null })).fallbacks).toEqual([]);
  });

  it("la conversion ne touche PAS une fiche déjà convertie", () => {
    const already = { fallbacks: [{ provider: "openai", model: "gpt-5" }], fallback: null };
    expect(parse(withModelFallbackChain(already)).fallbacks).toEqual([
      { provider: "openai", model: "gpt-5" },
    ]);
  });

  it("les chaînes d'appel commencent par le modèle visé, replis ensuite", () => {
    const model = parse({
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
      classifier: { provider: "openrouter", model: "google/gemini-2.5-flash" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5" }],
    });
    expect(modelChain(model)).toEqual([
      { provider: "openrouter", model: "openai/gpt-5.6-luna" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
    // Le classifieur hérite des MÊMES replis : les juges échouent par
    // fermeture, un classifieur en panne fait taire tout l'assistant.
    expect(classifierChain(model)).toEqual([
      { provider: "openrouter", model: "google/gemini-2.5-flash" },
      { provider: "anthropic", model: "claude-sonnet-5" },
    ]);
  });
});

describe("model.retry — la reprise réglée par l'assistant", () => {
  const parse = (model: unknown) =>
    assistantConfigSchema.parse({
      name: "X",
      identity: {},
      goal: { primary: { type: "phone_call", durationMin: 10 }, fallbacks: [] },
      approach: {},
      model,
    }).model;

  it("par défaut : trois tentatives, la première reprise après 0,8 s", () => {
    expect(parse({}).retry).toEqual({ attempts: 3, delaySec: 0.8 });
    expect(retryPolicyFor(parse({}))).toEqual({ attempts: 3, baseDelayMs: 800 });
  });

  it("les bornes sont ÉTROITES : au-delà, la configuration est refusée", () => {
    expect(() => parse({ retry: { attempts: 6, delaySec: 1 } })).toThrow();
    expect(() => parse({ retry: { attempts: 0, delaySec: 1 } })).toThrow();
    expect(() => parse({ retry: { attempts: 3, delaySec: 60 } })).toThrow();
    expect(() => parse({ retry: { attempts: 3, delaySec: 0 } })).toThrow();
  });

  it("« une seule tentative » est un réglage valable : aucune reprise", () => {
    expect(retryPolicyFor(parse({ retry: { attempts: 1, delaySec: 0.8 } })).attempts).toBe(1);
  });

  it("secondes à l'écran, millisecondes dans le transport", () => {
    expect(retryPolicyFor(parse({ retry: { attempts: 2, delaySec: 2.5 } }))).toEqual({
      attempts: 2,
      baseDelayMs: 2500,
    });
  });

  it("une fiche écrite avant le réglage reçoit les défauts, sans devenir illisible", () => {
    // Toutes les rangées en base sont dans ce cas : `model` n'a pas de bloc
    // `retry`. Refuser la lecture rendrait chaque assistant inouvrable.
    expect(parse({ provider: "openrouter", model: "openai/gpt-5.6-luna" }).retry.attempts).toBe(3);
  });
});
