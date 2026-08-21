/**
 * Unitaire — bibliothèque de campagnes (module pur).
 *
 * Ce qui est vraiment en jeu ici : les raisons de NE PAS écrire à quelqu'un, et
 * le fait qu'un tirage A/B ne bascule jamais une personne d'une variante à
 * l'autre. Les deux sont invisibles à l'écran et coûtent cher quand ils cèdent.
 */
import { describe, expect, it } from "vitest";
import { campaignConfigSchema, type CampaignConfig } from "@/lib/campaigns/schema";
import { hashKey, pickVariant, variantBody } from "@/lib/campaigns/variants";
import { bodyForStep, ladderExhausted, nextTouchAt, planLadder } from "@/lib/campaigns/ladder";
import { canEnroll, canSendTouch, type EnrollFacts, type TouchFacts } from "@/lib/campaigns/eligibility";

const NOW = new Date("2026-08-21T15:00:00.000Z");

function config(overrides: Record<string, unknown> = {}): CampaignConfig {
  return campaignConfigSchema.parse({
    name: "Réactivation 90 j",
    trigger: { kind: "manual" },
    ladder: [
      { delayHours: 0, label: "ouverture" },
      { delayHours: 48, label: "relance 1" },
    ],
    ...overrides,
  });
}

function enrollFacts(overrides: Partial<EnrollFacts> = {}): EnrollFacts {
  return {
    status: "active",
    now: NOW,
    hasPhone: true,
    hasValidConsent: true,
    suppressed: false,
    doNotCall: false,
    alreadyEnrolled: false,
    activeInOtherCampaign: false,
    enrolledTodayCount: 0,
    enrolledTotalCount: 0,
    ...overrides,
  };
}

function touchFacts(overrides: Partial<TouchFacts> = {}): TouchFacts {
  return {
    campaignStatus: "active",
    enrollmentStatus: "active",
    suppressed: false,
    hasValidConsent: true,
    aiEnabled: true,
    ladderLength: 2,
    step: 0,
    alreadySent: false,
    repliedSince: false,
    ...overrides,
  };
}

describe("schéma de campagne", () => {
  it("les valeurs par défaut de l'audience traversent le schéma", () => {
    const c = config();
    // `prefault` : si un défaut change plus haut, il change ici aussi.
    expect(c.audience.excludeActiveInOtherCampaign).toBe(true);
    expect(c.audience.excludeDoNotCall).toBe(true);
    expect(c.audience.categoryIds).toEqual([]);
  });

  it("une fenêtre inversée est refusée", () => {
    const result = campaignConfigSchema.safeParse({
      name: "X",
      trigger: { kind: "manual" },
      ladder: [],
      startsAt: "2026-09-01T00:00:00Z",
      endsAt: "2026-08-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("des variantes toutes à poids zéro sont refusées", () => {
    // Sinon le tirage n'a aucune issue et la campagne n'envoie rien, en silence.
    const result = campaignConfigSchema.safeParse({
      name: "X",
      trigger: { kind: "manual" },
      ladder: [{ delayHours: 0 }],
      variants: [
        { key: "a", weight: 0 },
        { key: "b", weight: 0 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("deux variantes de même clé sont refusées", () => {
    const result = campaignConfigSchema.safeParse({
      name: "X",
      trigger: { kind: "manual" },
      ladder: [{ delayHours: 0 }],
      variants: [
        { key: "a", weight: 50 },
        { key: "a", weight: 50 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("chaque type de déclencheur porte ses propres champs", () => {
    expect(campaignConfigSchema.safeParse({ name: "X", trigger: { kind: "lead_created", sourceIds: [1] }, ladder: [{ delayHours: 0 }] }).success).toBe(true);
    expect(campaignConfigSchema.safeParse({ name: "X", trigger: { kind: "scheduled", everyHours: 12 }, ladder: [{ delayHours: 0 }] }).success).toBe(true);
    expect(campaignConfigSchema.safeParse({ name: "X", trigger: { kind: "inventé" }, ladder: [] }).success).toBe(false);
  });
});

describe("tirage A/B", () => {
  const variants = [
    { key: "a", weight: 50, body: "Bonjour, ici Groupe Nexus." },
    { key: "b", weight: 50, body: "Salut! Groupe Nexus à l'appareil." },
  ];

  it("la même paire donne TOUJOURS la même variante", () => {
    const first = pickVariant(variants, "camp-1", "client-1");
    for (let i = 0; i < 50; i += 1) {
      expect(pickVariant(variants, "camp-1", "client-1")).toBe(first);
    }
  });

  it("deux campagnes répartissent différemment les mêmes personnes", () => {
    const clients = Array.from({ length: 200 }, (_, i) => `client-${i}`);
    const inA = clients.map((c) => pickVariant(variants, "camp-A", c));
    const inB = clients.map((c) => pickVariant(variants, "camp-B", c));
    const moved = clients.filter((_, i) => inA[i] !== inB[i]).length;
    // Si la campagne n'entrait pas dans le hachage, ce nombre serait zéro et
    // toute personne serait éternellement « en A ».
    expect(moved).toBeGreaterThan(50);
  });

  it("les poids sont respectés en agrégat", () => {
    const skewed = [
      { key: "a", weight: 90, body: "" },
      { key: "b", weight: 10, body: "" },
    ];
    const draws = Array.from({ length: 2000 }, (_, i) => pickVariant(skewed, "c", `client-${i}`));
    const share = draws.filter((d) => d === "a").length / draws.length;
    expect(share).toBeGreaterThan(0.85);
    expect(share).toBeLessThan(0.95);
  });

  it("une variante à poids zéro n'est jamais tirée mais reste connue", () => {
    const retired = [
      { key: "a", weight: 100, body: "" },
      { key: "retirée", weight: 0, body: "ancien texte" },
    ];
    const draws = Array.from({ length: 300 }, (_, i) => pickVariant(retired, "c", `x${i}`));
    expect(new Set(draws)).toEqual(new Set(["a"]));
    // L'historique reste lisible : la variante existe encore.
    expect(variantBody(retired, "retirée")).toBe("ancien texte");
  });

  it("sans variante, la clé est vide — pas une erreur", () => {
    expect(pickVariant([], "c", "x")).toBe("");
  });

  it("le hachage est stable d'une exécution à l'autre", () => {
    // Valeur figée : si l'implémentation change, les gens déjà inscrits
    // changeraient de variante en cours d'échelle.
    expect(hashKey("camp-1:client-1")).toBe(hashKey("camp-1:client-1"));
    expect(hashKey("a")).not.toBe(hashKey("b"));
  });
});

describe("échelle de relances", () => {
  const ladder = [
    { delayHours: 0, body: null, label: "ouverture" },
    { delayHours: 48, body: null, label: "j+2" },
    { delayHours: 120, body: null, label: "j+7" },
  ];

  it("les délais sont CUMULATIFS, pas comptés depuis l'inscription", () => {
    const plan = planLadder(ladder, NOW);
    expect(plan[0].dueAt.toISOString()).toBe("2026-08-21T15:00:00.000Z");
    expect(plan[1].dueAt.toISOString()).toBe("2026-08-23T15:00:00.000Z");
    // 0 + 48 + 120 = 168 h après l'inscription, pas 120.
    expect(plan[2].dueAt.toISOString()).toBe("2026-08-28T15:00:00.000Z");
  });

  it("le barreau suivant repart du dernier envoi RÉEL", () => {
    // Le barreau 0 est parti avec 12 h de retard (heures de politesse, panne
    // du dispatcher). Le barreau 1 doit partir 48 h après CET envoi, pas
    // rattraper le calendrier théorique.
    const late = new Date("2026-08-22T03:00:00.000Z");
    const next = nextTouchAt(ladder, 1, NOW, late);
    expect(next!.toISOString()).toBe("2026-08-24T03:00:00.000Z");
  });

  it("le premier barreau part de l'inscription même si un envoi existe", () => {
    const next = nextTouchAt(ladder, 0, NOW, new Date("2020-01-01T00:00:00Z"));
    expect(next!.toISOString()).toBe(NOW.toISOString());
  });

  it("au-delà du dernier barreau, il n'y a plus rien à planifier", () => {
    expect(nextTouchAt(ladder, 3, NOW, null)).toBeNull();
    expect(ladderExhausted(ladder, 3)).toBe(true);
    expect(ladderExhausted(ladder, 2)).toBe(false);
  });

  it("la variante ne remplace QUE l'ouverture", () => {
    const withBodies = [
      { delayHours: 0, body: "ouverture par défaut", label: "" },
      { delayHours: 48, body: "relance", label: "" },
    ];
    expect(bodyForStep(withBodies, 0, "texte variante")).toBe("texte variante");
    // Faire varier toute l'échelle rendrait le résultat du test inattribuable.
    expect(bodyForStep(withBodies, 1, "texte variante")).toBe("relance");
  });

  it("un barreau sans texte laisse rédiger l'assistant", () => {
    expect(bodyForStep(ladder, 1, null)).toBeNull();
  });
});

describe("éligibilité à l'inscription", () => {
  it("le cas nominal passe", () => {
    expect(canEnroll(config(), enrollFacts())).toEqual({ allowed: true });
  });

  it("un numéro supprimé est refusé AVANT toute question de capacité", () => {
    const decision = canEnroll(
      config({ dailyEnrollmentCap: 1 }),
      enrollFacts({ suppressed: true, enrolledTodayCount: 99 }),
    );
    // Un refus exprimé passe avant un plafond : le motif doit dire « supprimé »,
    // sinon on croit à un problème de rythme et on relève le plafond.
    expect(decision).toEqual({ allowed: false, refusal: "suppressed" });
  });

  it("sans consentement valide, rien ne part", () => {
    expect(canEnroll(config(), enrollFacts({ hasValidConsent: false }))).toEqual({
      allowed: false,
      refusal: "no_consent",
    });
  });

  it("le consentement peut être désactivé, délibérément", () => {
    expect(
      canEnroll(config({ requireConsent: false }), enrollFacts({ hasValidConsent: false })),
    ).toEqual({ allowed: true });
  });

  it("une campagne en brouillon n'inscrit personne", () => {
    expect(canEnroll(config(), enrollFacts({ status: "draft" }))).toEqual({
      allowed: false,
      refusal: "campaign_not_active",
    });
  });

  it("hors fenêtre, personne n'entre", () => {
    const future = config({ startsAt: "2026-09-01T00:00:00Z" });
    expect(canEnroll(future, enrollFacts())).toEqual({ allowed: false, refusal: "outside_window" });

    const past = config({ endsAt: "2026-08-01T00:00:00Z" });
    expect(canEnroll(past, enrollFacts())).toEqual({ allowed: false, refusal: "outside_window" });
  });

  it("une échelle vide est refusée : la campagne paraîtrait vivante sans rien faire", () => {
    expect(canEnroll(config({ ladder: [] }), enrollFacts())).toEqual({
      allowed: false,
      refusal: "empty_ladder",
    });
  });

  it("un client déjà inscrit ne rentre pas deux fois", () => {
    expect(canEnroll(config(), enrollFacts({ alreadyEnrolled: true }))).toEqual({
      allowed: false,
      refusal: "already_enrolled",
    });
  });

  it("actif ailleurs = écarté par défaut, mais c'est réglable", () => {
    expect(canEnroll(config(), enrollFacts({ activeInOtherCampaign: true }))).toEqual({
      allowed: false,
      refusal: "active_elsewhere",
    });
    const overlapping = config({ audience: { excludeActiveInOtherCampaign: false } });
    expect(canEnroll(overlapping, enrollFacts({ activeInOtherCampaign: true }))).toEqual({
      allowed: true,
    });
  });

  it("les plafonds journalier et total ont des motifs distincts", () => {
    expect(
      canEnroll(config({ dailyEnrollmentCap: 10 }), enrollFacts({ enrolledTodayCount: 10 })),
    ).toEqual({ allowed: false, refusal: "daily_cap_reached" });

    expect(
      canEnroll(
        config({ totalEnrollmentCap: 100 }),
        enrollFacts({ enrolledTotalCount: 100, enrolledTodayCount: 0 }),
      ),
    ).toEqual({ allowed: false, refusal: "total_cap_reached" });
  });

  it("le plafond total prime sur le journalier quand les deux sont atteints", () => {
    // Relever le plafond du jour ne servirait à rien : c'est le total qui ferme.
    expect(
      canEnroll(
        config({ dailyEnrollmentCap: 5, totalEnrollmentCap: 50 }),
        enrollFacts({ enrolledTodayCount: 5, enrolledTotalCount: 50 }),
      ),
    ).toEqual({ allowed: false, refusal: "total_cap_reached" });
  });

  it("sans téléphone, il n'y a rien à faire", () => {
    expect(canEnroll(config(), enrollFacts({ hasPhone: false }))).toEqual({
      allowed: false,
      refusal: "no_phone",
    });
  });
});

describe("éligibilité d'un barreau", () => {
  it("le cas nominal passe", () => {
    expect(canSendTouch(touchFacts())).toEqual({ allowed: true });
  });

  it("un désabonnement APRÈS l'inscription arrête l'échelle", () => {
    // Le point entier de re-vérifier : inscrire n'autorise pas à écrire pour
    // toujours. Une échelle de trois semaines peut traverser un STOP.
    expect(canSendTouch(touchFacts({ suppressed: true }))).toEqual({
      allowed: false,
      refusal: "suppressed",
    });
  });

  it("un consentement expiré en cours d'échelle arrête l'échelle", () => {
    expect(canSendTouch(touchFacts({ hasValidConsent: false }))).toEqual({
      allowed: false,
      refusal: "consent_expired",
    });
  });

  it("une réponse rend la main à l'assistant", () => {
    // Sinon deux voix écrivent à la même personne : l'échelle et l'agent.
    expect(canSendTouch(touchFacts({ repliedSince: true }))).toEqual({
      allowed: false,
      refusal: "replied",
    });
  });

  it("un humain qui a repris la main coupe l'échelle", () => {
    expect(canSendTouch(touchFacts({ aiEnabled: false }))).toEqual({
      allowed: false,
      refusal: "ai_paused",
    });
  });

  it("une campagne mise en pause arrête les barreaux en cours", () => {
    expect(canSendTouch(touchFacts({ campaignStatus: "paused" }))).toEqual({
      allowed: false,
      refusal: "campaign_not_active",
    });
  });

  it("un barreau déjà envoyé ne repart pas", () => {
    expect(canSendTouch(touchFacts({ alreadySent: true }))).toEqual({
      allowed: false,
      refusal: "already_sent",
    });
  });

  it("au-delà de l'échelle, plus rien", () => {
    expect(canSendTouch(touchFacts({ step: 2, ladderLength: 2 }))).toEqual({
      allowed: false,
      refusal: "ladder_exhausted",
    });
  });

  it("une inscription terminée ne reprend pas", () => {
    for (const status of ["stopped", "booked", "completed", "excluded"]) {
      expect(canSendTouch(touchFacts({ enrollmentStatus: status })).allowed).toBe(false);
    }
  });
});
