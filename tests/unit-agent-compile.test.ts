/**
 * Tests unitaires — compilateur de prompt en couches (src/lib/agent/*).
 *
 * Logique pure : aucune base de données, aucune horloge, aucun aléa. Les
 * fixtures (noyau, paquets d'objections, règles) sont inspirées de la
 * semence réelle (src/lib/guardrails/kernel.ts) sans en dépendre — ce module
 * reste autonome.
 */
import { describe, expect, it } from "vitest";

import {
  assistantConfigSchema,
  LAYER_IDS,
  type AssistantConfig,
} from "@/lib/assistants/schema";
import {
  compileAssistantPrompt,
  type CoreDoc,
  type GuardRuleInput,
  type ObjectionPack,
} from "@/lib/agent/compile";
import { renderRuntimeIntoPrompt, renderTemplate } from "@/lib/agent/render";
import { DEFAULT_TURN_INSTRUCTIONS, TURN_VARIABLES } from "@/lib/agent/templates";

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

/** Entrée brute minimale : rencontre vidéo 30 min primaire, appel 15 min en repli. */
function baseInput(): Record<string, unknown> {
  return {
    name: "Assistant SMS",
    identity: { mode: "team", orgName: "Groupe Nexus", brokerName: "Alex-Honoré" },
    goal: {
      primary: {
        type: "video_meeting",
        durationMin: 30,
        requiredFields: ["project_type", "timing"],
      },
      fallbacks: [{ type: "phone_call", durationMin: 15, requiredFields: [] }],
    },
    approach: { persistence: 3 },
    model: {},
  };
}

function buildConfig(overrides: Record<string, unknown> = {}): AssistantConfig {
  return assistantConfigSchema.parse({ ...baseInput(), ...overrides });
}

const core: CoreDoc = {
  version: 1,
  body: "# RÔLE\nTu es un assistant SMS pour {{org}}, au nom de {{broker}}.\nUn seul message par tour.",
};

const packs: ObjectionPack[] = [
  {
    id: "buyer_fr",
    label: "Acheteur — objections courantes",
    items: [
      {
        key: "just_looking",
        triggerHint: "la personne dit qu'elle regarde seulement",
        acknowledge: "c'est correct de commencer par regarder",
        reframe: "une courte rencontre aide à savoir quoi regarder",
        ask: "proposer une rencontre courte",
      },
    ],
  },
  {
    id: "seller_fr",
    label: "Vendeur — objections courantes",
    items: [
      {
        key: "no_commission",
        triggerHint: "la personne ne veut pas payer de courtier",
        acknowledge: "c'est une préoccupation légitime",
        reframe: "le courtier explique cela en rencontre",
        ask: "proposer une rencontre pour en discuter",
      },
    ],
  },
];

const rules: GuardRuleInput[] = [
  {
    key: "honesty_ai",
    label: "Admet être une IA",
    promptText: "Si on te demande si tu es un robot, une IA ou un humain, tu réponds la vérité.",
    severity: "block",
    enabled: true,
    scope: "core",
    overridesKey: null,
    orderIndex: 0,
  },
  {
    key: "no_price_opinion",
    label: "Aucune valeur ni prix de propriété",
    promptText: "Tu ne donnes jamais la valeur ni le prix d'une propriété.",
    severity: "block",
    enabled: true,
    scope: "core",
    overridesKey: null,
    orderIndex: 1,
  },
  {
    key: "no_commission_terms",
    label: "Aucun terme de commission",
    promptText: "Tu ne discutes jamais de commission ni d'honoraires.",
    severity: "block",
    enabled: false,
    scope: "core",
    overridesKey: null,
    orderIndex: 2,
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// compileAssistantPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("compileAssistantPrompt — déterminisme", () => {
  it("mêmes entrées → sortie strictement identique (octet pour octet)", () => {
    const config = buildConfig();
    const first = compileAssistantPrompt(config, core, packs, rules);
    const second = compileAssistantPrompt(config, core, packs, rules);

    expect(first.prompt).toBe(second.prompt);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("compileAssistantPrompt — mode composed", () => {
  it("produit les 7 couches, chacune amorcée d'un titre « # »", () => {
    const config = buildConfig();
    const result = compileAssistantPrompt(config, core, packs, rules);

    expect(result.layers).toHaveLength(7);
    expect(result.layers.map((l) => l.id)).toEqual([...LAYER_IDS]);
    for (const layer of result.layers) {
      expect(layer.text.startsWith("# ")).toBe(true);
      expect(layer.source).toBe("generated");
    }
    expect(result.coreVersion).toBe(1);
  });

  it("L0 substitue {{org}} et {{broker}} d'après identity", () => {
    const config = buildConfig();
    const result = compileAssistantPrompt(config, core, packs, rules);
    const l0 = result.layers.find((l) => l.id === "L0");

    expect(l0).toBeDefined();
    expect(l0!.text).toContain("Groupe Nexus");
    expect(l0!.text).toContain("Alex-Honoré");
    expect(l0!.text).not.toContain("{{org}}");
    expect(l0!.text).not.toContain("{{broker}}");
  });

  it("qualify_only : la formulation interdit toute proposition de rencontre", () => {
    const config = buildConfig({
      goal: {
        primary: { type: "qualify_only", requiredFields: [] },
        fallbacks: [],
      },
    });
    const result = compileAssistantPrompt(config, core, packs, rules);
    const l2 = result.layers.find((l) => l.id === "L2");

    expect(l2!.text).toContain("qualifier la personne sans JAMAIS proposer de rencontre");
  });

  it("L5 : seuls les packs sélectionnés apparaissent, dans l'ordre de config.objectionPacks", () => {
    const config = buildConfig({ objectionPacks: ["seller_fr", "buyer_fr"] });
    const result = compileAssistantPrompt(config, core, packs, rules);
    const l5 = result.layers.find((l) => l.id === "L5")!.text;

    const sellerIndex = l5.indexOf("Vendeur — objections courantes");
    const buyerIndex = l5.indexOf("Acheteur — objections courantes");
    expect(sellerIndex).toBeGreaterThanOrEqual(0);
    expect(buyerIndex).toBeGreaterThan(sellerIndex);
    expect(l5).toContain(
      "Si la personne ne veut pas payer de courtier : reconnais (c'est une préoccupation légitime)",
    );
  });

  it("L4 : les entrées sont NUMÉROTÉES dans l'ordre saisi", () => {
    // L'ordre est une donnée : c'est lui qui tranche entre deux consignes
    // contradictoires. Une puce « - » ne le dit pas ; un numéro, oui.
    const config = buildConfig({
      knowledge: {
        claims: [
          "Nous couvrons Québec et Lévis.",
          "Si la personne demande le prix, réponds que c'est Alex qui en parle.",
        ],
      },
    });
    const l4 = compileAssistantPrompt(config, core, packs, rules).layers.find((l) => l.id === "L4")!
      .text;

    expect(l4).toContain("1. Nous couvrons Québec et Lévis.");
    expect(l4).toContain(
      "2. Si la personne demande le prix, réponds que c'est Alex qui en parle.",
    );
    expect(l4.indexOf("1. Nous")).toBeLessThan(l4.indexOf("2. Si la personne"));
  });

  it("L4 : le prompt DIT qu'une entrée peut être une consigne, pas seulement un fait", () => {
    // Le régression que ce test attrape : revenir à une couche « FAITS
    // AUTORISÉS » où une consigne écrite par l'administrateur n'a aucune
    // garantie d'être appliquée plutôt que citée.
    const config = buildConfig({ knowledge: { claims: ["Ne parle jamais de la commission."] } });
    const l4 = compileAssistantPrompt(config, core, packs, rules).layers.find((l) => l.id === "L4")!
      .text;

    expect(l4.startsWith("# CONNAISSANCES ET CONSIGNES")).toBe(true);
    expect(l4).toContain("DANS L'ORDRE");
    expect(l4).toMatch(/CONDUITE|consigne/);
    expect(l4).toMatch(/PREMIÈRE l'emporte/);
    // Une consigne ne peut pas servir à lever un garde-fou.
    expect(l4).toMatch(/garde-fou/);
  });

  it("L4 : liste vide → aucune affirmation d'affaires autorisée", () => {
    const config = buildConfig({ knowledge: { claims: [] } });
    const l4 = compileAssistantPrompt(config, core, packs, rules).layers.find((l) => l.id === "L4")!
      .text;

    expect(l4).toContain("# CONNAISSANCES ET CONSIGNES");
    expect(l4).toContain("tu n'affirmes aucun fait d'affaires");
    expect(l4).not.toContain("1.");
  });

  it("L5 : aucun pack sélectionné → note explicite, aucune section", () => {
    const config = buildConfig({ objectionPacks: [] });
    const result = compileAssistantPrompt(config, core, packs, rules);
    const l5 = result.layers.find((l) => l.id === "L5")!.text;

    expect(l5).toBe("# OBJECTIONS\n(aucun pack d'objections configuré)");
  });
});

describe("compileAssistantPrompt — layerOverrides", () => {
  it("L3 replace : SEULE L3 diffère de la base ; les 6 autres restent identiques", () => {
    const config = buildConfig();
    const baseline = compileAssistantPrompt(config, core, packs, rules);

    const overridden = buildConfig({
      layerOverrides: { L3: { mode: "replace", text: "Bloc d'approche entièrement personnalisé." } },
    });
    const result = compileAssistantPrompt(overridden, core, packs, rules);

    for (const layer of result.layers) {
      const base = baseline.layers.find((l) => l.id === layer.id)!;
      if (layer.id === "L3") {
        expect(layer.source).toBe("replaced");
        expect(layer.text).toBe("Bloc d'approche entièrement personnalisé.");
        expect(layer.text).not.toBe(base.text);
      } else {
        expect(layer.source).toBe("generated");
        expect(layer.text).toBe(base.text);
      }
    }
  });

  it("L0 append : texte généré + \\n + texte ajouté, source « appended »", () => {
    const config = buildConfig();
    const baseline = compileAssistantPrompt(config, core, packs, rules);
    const baseL0 = baseline.layers.find((l) => l.id === "L0")!.text;

    const overridden = buildConfig({
      layerOverrides: { L0: { mode: "append", text: "Ligne additionnelle propre à cet assistant." } },
    });
    const result = compileAssistantPrompt(overridden, core, packs, rules);
    const l0 = result.layers.find((l) => l.id === "L0")!;

    expect(l0.source).toBe("appended");
    expect(l0.text).toBe(`${baseL0}\nLigne additionnelle propre à cet assistant.`);
  });
});

describe("compileAssistantPrompt — mode raw et éjection", () => {
  it("raw : prompt = systemPromptOverride, layers = []", () => {
    const config = buildConfig({
      promptMode: "raw",
      systemPromptOverride: "Prompt brut fourni intégralement par l'admin.",
    });
    const result = compileAssistantPrompt(config, core, packs, rules);

    expect(result.prompt).toBe("Prompt brut fourni intégralement par l'admin.");
    expect(result.layers).toEqual([]);
    expect(result.coreVersion).toBe(1);
  });

  it("raw sans override : prompt = « »", () => {
    const config = buildConfig({ promptMode: "raw", systemPromptOverride: null });
    const result = compileAssistantPrompt(config, core, packs, rules);

    expect(result.prompt).toBe("");
    expect(result.layers).toEqual([]);
  });

  it("éjection : composed → copié dans systemPromptOverride d'une config raw → identique à l'octet", () => {
    const composedConfig = buildConfig();
    const composed = compileAssistantPrompt(composedConfig, core, packs, rules);

    const ejectedConfig = buildConfig({
      promptMode: "raw",
      systemPromptOverride: composed.prompt,
    });
    const ejected = compileAssistantPrompt(ejectedConfig, core, packs, rules);

    expect(ejected.prompt).toBe(composed.prompt);
  });
});

describe("compileAssistantPrompt — L6 garde-fous : ordre, fork, exclusion", () => {
  it("un fork assistant remplace la règle core visée EN PLACE ; une règle désactivée est exclue", () => {
    const forkRule: GuardRuleInput = {
      key: "no_price_opinion_fork",
      label: "Fork — prix (personnalisé)",
      promptText: "Texte de remplacement personnalisé sur le prix.",
      severity: "block",
      enabled: true,
      scope: "assistant",
      overridesKey: "no_price_opinion",
      orderIndex: 99,
    };
    const rulesWithFork = [...rules, forkRule];
    const config = buildConfig();
    const result = compileAssistantPrompt(config, core, packs, rulesWithFork);
    const l6 = result.layers.find((l) => l.id === "L6")!.text;

    // Le fork remplace le texte core, dans l'ordre du core qu'il remplace (position 1).
    expect(l6).toContain("- Texte de remplacement personnalisé sur le prix.");
    expect(l6).not.toContain("Tu ne donnes jamais la valeur ni le prix d'une propriété.");
    // La règle désactivée (no_commission_terms) est exclue.
    expect(l6).not.toContain("commission");
    // Ordre : honesty_ai (core, orderIndex 0) précède le fork (à la position de no_price_opinion, 1).
    const honestyIndex = l6.indexOf("Si on te demande");
    const forkIndex = l6.indexOf("Texte de remplacement");
    expect(honestyIndex).toBeGreaterThanOrEqual(0);
    expect(forkIndex).toBeGreaterThan(honestyIndex);
  });

  it("aucune règle active → note explicite", () => {
    const allDisabled = rules.map((rule) => ({ ...rule, enabled: false }));
    const config = buildConfig();
    const result = compileAssistantPrompt(config, core, packs, allDisabled);
    const l6 = result.layers.find((l) => l.id === "L6")!.text;

    expect(l6).toBe("# GARDE-FOUS\n(aucune règle active)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderTemplate
// ═══════════════════════════════════════════════════════════════════════════

describe("renderTemplate", () => {
  it("résout les clés pointées", () => {
    const result = renderTemplate("Bonjour {{lead.prenom}}, secteur {{lead.secteur}}.", {
      "lead.prenom": "Marie",
      "lead.secteur": "Rive-Sud",
    });

    expect(result.text).toBe("Bonjour Marie, secteur Rive-Sud.");
    expect(result.warnings).toEqual([]);
  });

  it("variable inconnue → chaîne vide + UN avertissement dédupliqué même répétée", () => {
    const result = renderTemplate("{{a}} puis {{a}} puis {{b}}", {});

    expect(result.text).toBe(" puis  puis ");
    expect(result.warnings).toEqual(["unknown_variable: a", "unknown_variable: b"]);
  });

  it("une clé fournie explicitement à null/undefined ne déclenche PAS d'avertissement", () => {
    const result = renderTemplate("[{{x}}]", { x: null });

    expect(result.text).toBe("[]");
    expect(result.warnings).toEqual([]);
  });

  it("tolère les espaces internes {{ clé }}", () => {
    const result = renderTemplate("Valeur : {{   slots   }}.", { slots: "lundi 9h, mardi 14h" });

    expect(result.text).toBe("Valeur : lundi 9h, mardi 14h.");
    expect(result.warnings).toEqual([]);
  });

  it("un gabarit farfelu ne lève JAMAIS", () => {
    const garbage = [
      "{{",
      "}}",
      "{{}}",
      "{{{{}}}}",
      "{{ }}",
      "}}{{",
      "{{a}",
      "{a}}",
      "{{a.b.c.d.e}}",
      "n'importe quoi sans jeton",
      "",
      "{{🙂}}",
    ];

    for (const template of garbage) {
      expect(() => renderTemplate(template, { a: "x" })).not.toThrow();
      const result = renderTemplate(template, { a: "x" });
      expect(typeof result.text).toBe("string");
      expect(Array.isArray(result.warnings)).toBe(true);
    }
  });

  it("convertit les nombres en chaîne", () => {
    const result = renderTemplate("{{turns_used}}/{{max_turns}}", { turns_used: 3, max_turns: 16 });
    expect(result.text).toBe("3/16");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderRuntimeIntoPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("renderRuntimeIntoPrompt", () => {
  const runtimeBlock = "[[bloc d'exécution : rung=primary, turns_used=2]]";

  it("includeRuntimeLayer = false → prompt inchangé", () => {
    const prompt = "# PROMPT\nContenu quelconque avec {{runtime}} dedans.";
    expect(renderRuntimeIntoPrompt(prompt, runtimeBlock, false)).toBe(prompt);
  });

  it("prompt contenant {{runtime}} → substitution en place", () => {
    const prompt = "# PROMPT\nAvant.\n{{runtime}}\nAprès.";
    const result = renderRuntimeIntoPrompt(prompt, runtimeBlock, true);

    expect(result).toBe(`# PROMPT\nAvant.\n${runtimeBlock}\nAprès.`);
  });

  it("prompt sans {{runtime}} → ajouté à la fin, séparé par une ligne vide", () => {
    const prompt = "# PROMPT\nAucun jeton runtime ici.";
    const result = renderRuntimeIntoPrompt(prompt, runtimeBlock, true);

    expect(result).toBe(`${prompt}\n\n${runtimeBlock}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT_TURN_INSTRUCTIONS × TURN_VARIABLES
// ═══════════════════════════════════════════════════════════════════════════

describe("DEFAULT_TURN_INSTRUCTIONS", () => {
  it("se rend sans aucun avertissement quand toutes les variables catalogue sont fournies", () => {
    const fullVars: Record<string, string> = {};
    for (const key of TURN_VARIABLES) fullVars[key] = `valeur-${key}`;

    const result = renderTemplate(DEFAULT_TURN_INSTRUCTIONS, fullVars);

    expect(result.warnings).toEqual([]);
    expect(result.text).not.toContain("{{");
  });

  it("TURN_VARIABLES couvre chaque jeton présent dans DEFAULT_TURN_INSTRUCTIONS", () => {
    const tokenRe = /\{\{\s*([^{}]+?)\s*\}\}/g;
    const found = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(DEFAULT_TURN_INSTRUCTIONS)) !== null) {
      found.add(match[1]);
    }

    expect(found.size).toBeGreaterThan(0);
    for (const token of found) {
      expect(TURN_VARIABLES).toContain(token);
    }
  });
});

describe("compileAssistantPrompt — objectif et approche, révision 2026-08-22", () => {
  it("L2 : la consigne d'un cran suit SON cran", () => {
    // Posée en bloc à la fin, on ne savait plus à quel repli elle s'applique.
    const config = buildConfig({
      goal: {
        primary: { type: "video_meeting", durationMin: 30, instruction: "Reste bref." },
        fallbacks: [
          { type: "phone_call", durationMin: 15, instruction: "Propose-le comme un dépannage." },
          { type: "collect_email" },
        ],
      },
    });
    const l2 = compileAssistantPrompt(config, core, packs, rules).layers.find((l) => l.id === "L2")!
      .text;

    expect(l2).toContain("Pour ce cran : Reste bref.");
    expect(l2).toMatch(/1\).*— Propose-le comme un dépannage\./);
    // Le cran sans consigne n'en invente pas une.
    expect(l2).not.toMatch(/2\).*—/);
  });

  it("L2 : une exigence LIBRE part telle quelle, sans traduction", () => {
    const config = buildConfig({
      goal: {
        primary: {
          type: "video_meeting",
          requiredFields: ["project_type", "nombre de chambres"],
        },
        fallbacks: [],
      },
    });
    const l2 = compileAssistantPrompt(config, core, packs, rules).layers.find((l) => l.id === "L2")!
      .text;

    expect(l2).toContain("- type de projet");
    // C'est la personne qui l'a écrite qui sait ce qu'elle veut dire.
    expect(l2).toContain("- nombre de chambres");
  });

  it("L3 : le budget de questions est un plafond ABSOLU, pas « avant la première demande »", () => {
    // L'ancienne formulation laissait l'assistant relancer un interrogatoire
    // après un premier refus, comme si le compteur repartait de zéro.
    const l3 = compileAssistantPrompt(
      buildConfig({ approach: { questionBudget: 4 } }),
      core,
      packs,
      rules,
    ).layers.find((l) => l.id === "L3")!.text;

    expect(l3).toContain("4 questions de qualification EN TOUT");
    expect(l3).not.toContain("avant ta première proposition");
  });

  it("L3 : « beaucoup » d'émojis est un quatrième cran, distinct de « modéré »", () => {
    const phrase = (emoji: string) =>
      compileAssistantPrompt(buildConfig({ approach: { emoji } }), core, packs, rules)
        .layers.find((l) => l.id === "L3")!
        .text.split("\n")
        .find((line) => line.startsWith("Émoji :"));

    expect(phrase("moderate")).not.toBe(phrase("lots"));
    expect(phrase("lots")).toMatch(/deux ou trois/);
    expect(phrase("none")).toBe("Émoji : aucun émoji.");
  });
});
