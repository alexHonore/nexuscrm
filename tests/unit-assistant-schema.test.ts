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
  goalStepSchema,
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
