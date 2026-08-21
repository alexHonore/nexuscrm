/**
 * Unitaire — création assistée.
 *
 * Le modèle produit un BRIEF court ; la configuration en est dérivée ici, de
 * façon déterministe. Ce test vérifie la partie déterministe : c'est elle qui
 * décide des outils, du type de rendez-vous et des replis — trois choses qu'un
 * modèle remplit « plausiblement » et donc parfois faux.
 */
import { describe, expect, it } from "vitest";
import {
  assistantBriefSchema,
  briefToConfig,
  creatorReplySchema,
  type AssistantBrief,
} from "@/lib/assistants/creator";

const DEFAULTS = { orgName: "Groupe Nexus", brokerName: "Alex-Honoré", brokerUserId: null };

const brief = (o: Partial<AssistantBrief> = {}): AssistantBrief =>
  assistantBriefSchema.parse({
    name: "Acheteurs Facebook",
    description: "Leads acheteurs",
    audience: "buyer",
    goalType: "video_meeting",
    durationMin: 30,
    requiredFields: ["project_type", "timing"],
    persistence: 3,
    warmth: 3,
    questionBudget: 2,
    formality: "vous",
    claims: [],
    ...o,
  });

describe("brief → configuration", () => {
  it("un objectif de rencontre reçoit les outils d'agenda", () => {
    const config = briefToConfig(brief(), DEFAULTS);
    expect(config.tools).toContain("get_slots");
    expect(config.tools).toContain("book_meeting");
    expect(config.goal.primary.appointmentType).toBe("meet");
    expect(config.goal.primary.durationMin).toBe(30);
  });

  it("un objectif qui NE réserve PAS n'a pas d'outils d'agenda", () => {
    // Offrir `book_meeting` à un assistant qui ne réserve rien produit des
    // appels d'outil qui échouent, et des tours sans réponse.
    const config = briefToConfig(brief({ goalType: "qualify_only" }), DEFAULTS);
    expect(config.tools).not.toContain("book_meeting");
    expect(config.tools).not.toContain("get_slots");
    expect(config.goal.primary.appointmentType).toBeNull();
    expect(config.goal.primary.durationMin).toBeNull();
  });

  it("« stop » et « handoff » sont TOUJOURS présents", () => {
    for (const goalType of ["video_meeting", "qualify_only", "collect_email"] as const) {
      const config = briefToConfig(brief({ goalType }), DEFAULTS);
      expect(config.tools, goalType).toContain("stop");
      expect(config.tools, goalType).toContain("handoff");
    }
  });

  it("une rencontre en personne réserve en personne", () => {
    const config = briefToConfig(brief({ goalType: "in_person_meeting" }), DEFAULTS);
    expect(config.goal.primary.appointmentType).toBe("inperson");
  });

  it("un repli d'un cran est proposé sous une rencontre", () => {
    // « pas cette semaine » ne doit pas clore la conversation quand une
    // demande plus légère peut encore aboutir.
    const config = briefToConfig(brief(), DEFAULTS);
    expect(config.goal.fallbacks[0].type).toBe("phone_call");
  });

  it("l'audience choisit les paquets d'objections", () => {
    expect(briefToConfig(brief({ audience: "buyer" }), DEFAULTS).objectionPacks).toEqual(["buyer_fr"]);
    expect(briefToConfig(brief({ audience: "seller" }), DEFAULTS).objectionPacks).toEqual(["seller_fr"]);
    expect(briefToConfig(brief({ audience: "both" }), DEFAULTS).objectionPacks).toHaveLength(2);
    expect(briefToConfig(brief({ audience: "unknown" }), DEFAULTS).objectionPacks).toEqual([]);
  });

  it("sans compte de courtier, l'assistant écrit au nom de l'ÉQUIPE", () => {
    // Nommer quelqu'un sans compte rattaché ferait retomber les rendez-vous
    // sur un administrateur.
    expect(briefToConfig(brief(), DEFAULTS).identity.mode).toBe("team");
    const named = briefToConfig(brief(), { ...DEFAULTS, brokerUserId: crypto.randomUUID() });
    expect(named.identity.mode).toBe("named_person");
  });

  it("les faits autorisés passent tels quels, et restent vides par défaut", () => {
    // Tout ce qui est ici sera affirmé au nom d'un courtier titulaire d'un
    // permis : le modèle n'a pas le droit d'en inventer.
    expect(briefToConfig(brief(), DEFAULTS).knowledge.claims).toEqual([]);
    const withClaims = briefToConfig(brief({ claims: ["Nous couvrons Québec."] }), DEFAULTS);
    expect(withClaims.knowledge.claims).toEqual(["Nous couvrons Québec."]);
  });

  it("la configuration produite est VALIDE au sens du schéma", () => {
    // Le point de tout ce module : ce qui sort est directement enregistrable.
    for (const goalType of ["video_meeting", "phone_call", "collect_email", "qualify_only"] as const) {
      expect(() => briefToConfig(brief({ goalType }), DEFAULTS)).not.toThrow();
    }
  });
});

describe("réponse du créateur", () => {
  it("une question est acceptée avec ses suggestions", () => {
    const parsed = creatorReplySchema.parse({
      done: false,
      question: "Vous écrivez surtout à des acheteurs ou à des vendeurs?",
      suggestions: ["Acheteurs", "Vendeurs", "Les deux"],
    });
    expect(parsed.done).toBe(false);
  });

  it("un brief SANS OBJECTIF est refusé — il n'y a rien à configurer", () => {
    const result = creatorReplySchema.safeParse({ done: true, summary: "ok", brief: { name: "X" } });
    expect(result.success).toBe(false);
  });

  it("des champs à null sont ACCEPTÉS et reçoivent des défauts", () => {
    // Un modèle honnête renvoie null pour ce qu'il ne sait pas — il n'invente
    // pas un nom. Rejeter le brief entier pour ça obligerait à tout
    // recommencer et donnerait l'impression que la fonction est cassée.
    const result = creatorReplySchema.safeParse({
      done: true,
      summary: "ok",
      brief: {
        goalType: "video_meeting",
        name: null, description: null, warmth: null,
        persistence: null, questionBudget: null, formality: null,
        audience: "seller", durationMin: 30, requiredFields: null, claims: null,
      },
    });
    expect(result.success).toBe(true);

    const config = briefToConfig(
      (result as { data: { done: true; brief: AssistantBrief } }).data.brief,
      DEFAULTS,
    );
    // Le nom de repli décrit ce que fait l'assistant, il n'invente rien.
    expect(config.name).toBe("Vendeurs — rencontre");
    expect(config.approach.warmth).toBe(3);
    expect(config.knowledge.claims).toEqual([]);
  });

  it("un objectif inventé est refusé", () => {
    const result = creatorReplySchema.safeParse({
      done: true,
      summary: "ok",
      brief: { ...brief(), goalType: "vendre_la_maison" },
    });
    expect(result.success).toBe(false);
  });

  it("trop de faits affirmés est refusé", () => {
    const result = creatorReplySchema.safeParse({
      done: true,
      summary: "ok",
      brief: { ...brief(), claims: Array.from({ length: 9 }, (_, i) => `fait ${i}`) },
    });
    expect(result.success).toBe(false);
  });
});
