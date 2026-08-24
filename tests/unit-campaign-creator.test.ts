/**
 * Unitaire — création assistée d'une campagne.
 *
 * Le modèle produit un BRIEF ; l'échelle, les variantes et le déclencheur en
 * sont dérivés ici. C'est la partie déterministe qui doit être juste : une
 * échelle mal construite écrit trois fois le même jour, et un test A/B dont
 * les deux branches sont identiques annonce une mesure qui n'existe pas.
 */
import { describe, expect, it } from "vitest";
import {
  briefToCampaignConfig,
  campaignBriefSchema,
  campaignCreatorReplySchema,
  type CampaignBrief,
} from "@/lib/campaigns/creator";
import { bodyForStep } from "@/lib/campaigns/ladder";
import { variantBody } from "@/lib/campaigns/variants";

const brief = (o: Partial<CampaignBrief> = {}): CampaignBrief =>
  campaignBriefSchema.parse({ trigger: "scheduled", ...o });

describe("brief → configuration de campagne", () => {
  it("l'ouverture part tout de suite, les relances sont espacées", () => {
    const config = briefToCampaignConfig(brief({ followUps: 2, daysBetween: 3 }));
    expect(config.ladder).toHaveLength(3);
    expect(config.ladder[0].delayHours).toBe(0);
    // Les délais sont CUMULATIFS dans le moteur : 72 h sur chaque barreau veut
    // dire trois jours après le précédent, pas après l'inscription.
    expect(config.ladder[1].delayHours).toBe(72);
    expect(config.ladder[2].delayHours).toBe(72);
  });

  it("zéro relance donne un seul message", () => {
    const config = briefToCampaignConfig(brief({ followUps: 0 }));
    expect(config.ladder).toHaveLength(1);
  });

  it("sans texte dicté, TOUS les barreaux sont rédigés par l'assistant", () => {
    // `body: null` est le signal « laisse l'assistant écrire ». Y mettre un
    // texte inventé ferait partir un message que personne n'a relu.
    const config = briefToCampaignConfig(brief());
    expect(config.ladder.every((step) => step.body === null)).toBe(true);
  });

  it("un texte dicté n'est utilisé QUE pour l'ouverture", () => {
    const config = briefToCampaignConfig(brief({ opener: "Bonjour, ici Groupe Nexus." }));
    expect(config.ladder[0].body).toBe("Bonjour, ici Groupe Nexus.");
    // Les relances doivent tenir compte de ce qui a été répondu entre-temps.
    expect(config.ladder.slice(1).every((step) => step.body === null)).toBe(true);
  });

  it("un test A/B sans ouverture dictée ne crée AUCUNE variante", () => {
    // Deux variantes au corps vide retombent sur le même barreau 0 : la
    // campagne annoncerait un test et mesurerait deux fois la même chose.
    expect(briefToCampaignConfig(brief({ abTest: true })).variants).toEqual([]);
  });

  it("un test A/B avec ouverture dictée oppose le texte dicté au texte rédigé", () => {
    const config = briefToCampaignConfig(brief({ abTest: true, opener: "Bonjour." }));
    expect(config.variants).toHaveLength(2);
    expect(config.variants[0].body).toBe("Bonjour.");
    expect(config.variants[1].body).toBe("");
    expect(config.variants.reduce((sum, v) => sum + v.weight, 0)).toBe(100);

    // Ce que le MOTEUR enverra, pas seulement ce que le tableau contient : une
    // variante au corps vide retombe sur l'ouverture du barreau 0. Si celle-ci
    // portait le texte dicté, les deux branches envoyaient le même SMS — le
    // test annonçait une mesure qui n'existait pas. Le barreau 0 reste donc
    // sans texte (l'assistant rédige), et seule « dictee » porte le texte.
    expect(config.ladder[0].body).toBeNull();
    const dictee = bodyForStep(config.ladder, 0, variantBody(config.variants, "dictee"));
    const redigee = bodyForStep(config.ladder, 0, variantBody(config.variants, "redigee"));
    expect(dictee).toBe("Bonjour.");
    expect(redigee).toBeNull();
    // Les relances ne sont pas touchées par le test.
    expect(config.ladder.slice(1).every((step) => step.body === null)).toBe(true);
  });

  it("sans test A/B, le texte dicté reste sur le barreau 0", () => {
    const config = briefToCampaignConfig(brief({ abTest: false, opener: "Bonjour." }));
    expect(config.ladder[0].body).toBe("Bonjour.");
    expect(config.variants).toEqual([]);
  });

  it("chaque déclencheur produit sa forme discriminée", () => {
    expect(briefToCampaignConfig(brief({ trigger: "manual" })).trigger).toEqual({ kind: "manual" });
    expect(briefToCampaignConfig(brief({ trigger: "lead_created" })).trigger).toEqual({
      kind: "lead_created",
      sourceIds: [],
    });
    expect(briefToCampaignConfig(brief({ trigger: "category_changed" })).trigger).toEqual({
      kind: "category_changed",
      toCategoryIds: [],
    });
    expect(briefToCampaignConfig(brief({ trigger: "scheduled" })).trigger).toEqual({
      kind: "scheduled",
      everyHours: 24,
    });
  });

  it("le filtre de réactivation passe dans l'audience", () => {
    const config = briefToCampaignConfig(brief({ notContactedForDays: 180 }));
    expect(config.audience.notContactedForDays).toBe(180);
    // Les protections par défaut restent en place.
    expect(config.audience.excludeDoNotCall).toBe(true);
    expect(config.audience.excludeActiveInOtherCampaign).toBe(true);
  });

  it("le nom de repli DÉCRIT la campagne, il n'invente rien", () => {
    expect(briefToCampaignConfig(brief({ trigger: "lead_created" })).name).toBe("Nouveaux leads");
    expect(briefToCampaignConfig(brief({ notContactedForDays: 90 })).name).toBe("Réactivation 90 j");
    expect(briefToCampaignConfig(brief({ name: "Portes ouvertes" })).name).toBe("Portes ouvertes");
  });

  it("ce qui sort est directement enregistrable", () => {
    for (const trigger of ["manual", "lead_created", "category_changed", "scheduled"] as const) {
      expect(() => briefToCampaignConfig(brief({ trigger }))).not.toThrow();
    }
  });
});

describe("réponse du créateur de campagne", () => {
  it("une question est acceptée avec ses suggestions", () => {
    const parsed = campaignCreatorReplySchema.parse({
      done: false,
      question: "Qu'est-ce qui déclenche la campagne?",
      suggestions: ["Un nouveau lead", "Un balayage de ma base"],
    });
    expect(parsed.done).toBe(false);
  });

  it("un brief SANS DÉCLENCHEUR est refusé — il n'y a rien à déclencher", () => {
    const result = campaignCreatorReplySchema.safeParse({
      done: true,
      summary: "ok",
      brief: { name: "X" },
    });
    expect(result.success).toBe(false);
  });

  it("des champs à null sont ACCEPTÉS et reçoivent des défauts", () => {
    // Un modèle honnête renvoie null pour ce qu'il ne sait pas — refuser le
    // brief entier pour ça obligerait à tout recommencer.
    const result = campaignCreatorReplySchema.safeParse({
      done: true,
      summary: "ok",
      brief: {
        trigger: "scheduled",
        name: null,
        description: null,
        notContactedForDays: 180,
        followUps: null,
        daysBetween: null,
        opener: null,
        abTest: null,
        dailyCap: null,
      },
    });
    expect(result.success).toBe(true);
    const config = briefToCampaignConfig(
      (result as { data: { done: true; brief: CampaignBrief } }).data.brief,
    );
    expect(config.ladder).toHaveLength(2);
    expect(config.dailyEnrollmentCap).toBe(50);
  });

  it("un déclencheur inventé est refusé", () => {
    const result = campaignCreatorReplySchema.safeParse({
      done: true,
      summary: "ok",
      brief: { trigger: "quand_il_pleut" },
    });
    expect(result.success).toBe(false);
  });

  it("une échelle démesurée est refusée en amont", () => {
    // Huit relances, c'est du harcèlement — et le schéma de campagne plafonne
    // l'échelle à huit barreaux au total.
    expect(campaignBriefSchema.safeParse({ trigger: "manual", followUps: 9 }).success).toBe(false);
  });
});
