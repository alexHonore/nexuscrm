/**
 * Unitaire — moteur de garde-fous (résolution, filtre déterministe, juge,
 * semence du noyau). Aucune base de données, aucun réseau.
 *
 * Le fil conducteur : ce que l'admin éteint est éteint. Rien dans le code ne
 * réimpose une règle désactivée, et une règle bloquante ne passe jamais parce
 * qu'un juge a bafouillé.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUARDRAIL_FIXTURES,
  DEFAULT_GUARDRAIL_RULES,
  DEFAULT_OBJECTION_PACKS,
  CORE_PROMPT_V1,
  validateKernel,
} from "@/lib/guardrails/kernel";
import { blockingRules, enabledRules, resolveRules } from "@/lib/guardrails/resolve";
import { blockingFailures, evaluateOutputRules } from "@/lib/guardrails/filter";
import { judgeWithLlm } from "@/lib/guardrails/judge";
import {
  fixtureExpectationsSchema,
  fixtureSetupSchema,
  safeParseRuleConfig,
  type GuardrailKind,
  type GuardrailSeverity,
  type RuleData,
} from "@/lib/guardrails/types";

// ── Fabriques ────────────────────────────────────────────────────────────────

function rule(overrides: Partial<RuleData> & Pick<RuleData, "key" | "kind" | "config">): RuleData {
  return {
    scope: "core",
    label: overrides.key,
    promptText: null,
    severity: "block",
    enabled: true,
    overridesKey: null,
    orderIndex: 0,
    ...overrides,
  };
}

const priceRule = () =>
  rule({
    key: "no_price_opinion",
    kind: "forbidden_regex",
    config: { patterns: ["\\$", "(?<!\\d)\\d{2,3}\\s?\\d{3}(?!\\d)"], flags: "iu" },
  });

// ── Schémas de config ────────────────────────────────────────────────────────

describe("configs typées par kind", () => {
  it("accepte une config valide pour chaque kind", () => {
    const valid: Record<GuardrailKind, unknown> = {
      forbidden_regex: { patterns: ["\\$"] },
      forbidden_terms: { terms: ["commission"] },
      max_chars: { max: 300 },
      max_questions: { max: 1 },
      link_policy: { allowedDomains: ["groupe-nexus.vercel.app"] },
      required_tool_on_intent: { intent: "optout", tool: "stop" },
      llm_judge: { criterion: "dit la vérité" },
      custom_instruction: {},
    };
    for (const [kind, config] of Object.entries(valid)) {
      expect(safeParseRuleConfig(kind as GuardrailKind, config).success).toBe(true);
    }
  });

  it("refuse une regex non compilable — une règle cassée ne doit jamais être enregistrée", () => {
    const parsed = safeParseRuleConfig("forbidden_regex", { patterns: ["("] });
    expect(parsed.success).toBe(false);
  });

  it("refuse une liste de termes vide et un max_chars non entier", () => {
    expect(safeParseRuleConfig("forbidden_terms", { terms: [] }).success).toBe(false);
    expect(safeParseRuleConfig("max_chars", { max: 12.5 }).success).toBe(false);
  });
});

// ── Résolution core + assistant ──────────────────────────────────────────────

describe("resolveRules", () => {
  it("ordonne les règles core puis celles de l'assistant", () => {
    const core = [
      rule({ key: "b", kind: "max_chars", config: { max: 300 }, orderIndex: 1 }),
      rule({ key: "a", kind: "max_chars", config: { max: 300 }, orderIndex: 0 }),
    ];
    const own = [
      rule({ key: "z", kind: "max_chars", config: { max: 200 }, scope: "assistant", orderIndex: 0 }),
    ];
    expect(resolveRules(core, own).map((r) => r.key)).toEqual(["a", "b", "z"]);
  });

  it("un fork assistant REMPLACE la règle core à sa place — la globale reste intacte ailleurs", () => {
    const core = [
      rule({ key: "honesty_ai", kind: "llm_judge", config: { criterion: "x" }, orderIndex: 0 }),
      priceRule(),
      rule({ key: "identify_sender", kind: "custom_instruction", config: {}, orderIndex: 2 }),
    ];
    const fork = rule({
      key: "no_price_opinion_local",
      kind: "max_chars",
      config: { max: 150 },
      scope: "assistant",
      assistantId: "a-1",
      overridesKey: "no_price_opinion",
      orderIndex: 0,
    });

    const resolved = resolveRules(core, [fork]);
    expect(resolved.map((r) => r.key)).toEqual([
      "honesty_ai",
      "no_price_opinion_local",
      "identify_sender",
    ]);
    // La rangée core d'origine n'est pas modifiée : les autres assistants la gardent.
    expect(core[1].key).toBe("no_price_opinion");
  });

  it("un fork orphelin (règle core supprimée) reste appliqué", () => {
    const fork = rule({
      key: "fork",
      kind: "max_chars",
      config: { max: 150 },
      scope: "assistant",
      overridesKey: "disparue",
    });
    expect(resolveRules([], [fork]).map((r) => r.key)).toEqual(["fork"]);
  });

  it("enabledRules exclut off et désactivées ; blockingRules ne garde que block", () => {
    const rules = [
      rule({ key: "on", kind: "max_chars", config: { max: 300 } }),
      rule({ key: "warn", kind: "max_chars", config: { max: 300 }, severity: "warn" }),
      rule({ key: "off", kind: "max_chars", config: { max: 300 }, severity: "off" }),
      rule({ key: "disabled", kind: "max_chars", config: { max: 300 }, enabled: false }),
    ];
    expect(enabledRules(rules).map((r) => r.key)).toEqual(["on", "warn"]);
    expect(blockingRules(rules).map((r) => r.key)).toEqual(["on"]);
  });
});

// ── Filtre déterministe ──────────────────────────────────────────────────────

describe("evaluateOutputRules", () => {
  it("§21 — un brouillon contenant un montant échoue et n'est donc jamais envoyé", () => {
    for (const draft of ["Elle vaut environ 450 000 $", "ça vaut 450000$", "autour de 1 250 000"]) {
      const verdicts = evaluateOutputRules(draft, [priceRule()]);
      expect(verdicts[0].passed).toBe(false);
      expect(blockingFailures(verdicts)).toHaveLength(1);
    }
  });

  it("laisse passer un texte sans montant, y compris un numéro de téléphone brut", () => {
    for (const draft of [
      "C'est exactement ce que le courtier va regarder avec vous à la rencontre.",
      "Vous pouvez joindre le bureau au 4185551234.",
      "On se voit jeudi 14h30?",
    ]) {
      expect(evaluateOutputRules(draft, [priceRule()])[0].passed).toBe(true);
    }
  });

  it("la raison ne cite JAMAIS le brouillon (renseignements personnels)", () => {
    const draft = "Marie, votre maison vaut 450 000 $";
    const [verdict] = evaluateOutputRules(draft, [priceRule()]);
    expect(verdict.reason).toBeDefined();
    expect(verdict.reason).not.toContain("Marie");
    expect(verdict.reason).not.toContain("450");
  });

  it("forbidden_terms ignore accents et casse, sans faux positif sur un autre mot", () => {
    const terms = rule({
      key: "no_commission_terms",
      kind: "forbidden_terms",
      config: { terms: ["commission", "honoraires", "pourcentage", "tarif"] },
    });
    expect(evaluateOutputRules("Notre Commission est de…", [terms])[0].passed).toBe(false);
    expect(evaluateOutputRules("les HONORAIRES du courtier", [terms])[0].passed).toBe(false);
    expect(evaluateOutputRules("un pourcentagé bizarre", [terms])[0].passed).toBe(false); // sous-chaîne
    expect(evaluateOutputRules("Le courtier vous expliquera tout ça.", [terms])[0].passed).toBe(true);
  });

  it("max_chars et max_questions", () => {
    const chars = rule({ key: "max_chars", kind: "max_chars", config: { max: 10 } });
    expect(evaluateOutputRules("court", [chars])[0].passed).toBe(true);
    expect(evaluateOutputRules("beaucoup trop long", [chars])[0].passed).toBe(false);

    const questions = rule({ key: "max_questions", kind: "max_questions", config: { max: 1 } });
    expect(evaluateOutputRules("Achat ou vente?", [questions])[0].passed).toBe(true);
    expect(evaluateOutputRules("Achat? Vente? Les deux?", [questions])[0].passed).toBe(false);
  });

  it("link_policy : domaine autorisé, domaine tiers, liste vide, aucun lien", () => {
    const allow = rule({
      key: "link_policy",
      kind: "link_policy",
      config: { allowedDomains: ["groupe-nexus.vercel.app"] },
    });
    expect(
      evaluateOutputRules("Voici : https://groupe-nexus.vercel.app/rdv", [allow])[0].passed,
    ).toBe(true);
    expect(evaluateOutputRules("Voici : https://bit.ly/x", [allow])[0].passed).toBe(false);
    expect(evaluateOutputRules("Aucun lien ici.", [allow])[0].passed).toBe(true);

    const none = rule({ key: "no_links", kind: "link_policy", config: { allowedDomains: [] } });
    expect(evaluateOutputRules("www.exemple.com", [none])[0].passed).toBe(false);
  });

  it("link_policy : un domaine NU ne passe pas entre les mailles", () => {
    const none = rule({ key: "no_links", kind: "link_policy", config: { allowedDomains: [] } });
    // Sans schéma ni www. — la forme la plus naturelle dans un SMS.
    expect(evaluateOutputRules("voir nos propriétés sur exemple.com", [none])[0].passed).toBe(false);
    expect(evaluateOutputRules("groupe-nexus.ca/rdv c'est ici", [none])[0].passed).toBe(false);
    // Pas de faux positif sur une phrase ordinaire ni une décimale.
    expect(evaluateOutputRules("On se voit jeudi. Ça vous va?", [none])[0].passed).toBe(true);
    expect(evaluateOutputRules("Environ 2.5 km du centre.", [none])[0].passed).toBe(true);

    const allow = rule({
      key: "link_policy",
      kind: "link_policy",
      config: { allowedDomains: ["groupe-nexus.ca"] },
    });
    expect(evaluateOutputRules("groupe-nexus.ca/rdv", [allow])[0].passed).toBe(true);
  });

  it("refuse une config dont les DRAPEAUX de regex sont invalides", () => {
    // « gg » ferait lever new RegExp au moment d'évaluer un brouillon : la
    // règle censée bloquer laisserait tout passer.
    expect(safeParseRuleConfig("forbidden_regex", { patterns: ["\\$"], flags: "gg" }).success).toBe(
      false,
    );
    expect(safeParseRuleConfig("forbidden_regex", { patterns: ["\\$"], flags: "zz" }).success).toBe(
      false,
    );
    expect(safeParseRuleConfig("forbidden_regex", { patterns: ["\\$"], flags: "giu" }).success).toBe(
      true,
    );
  });

  it("required_tool_on_intent : matrice complète", () => {
    const stop = rule({
      key: "respect_stop",
      kind: "required_tool_on_intent",
      config: { intent: "optout", tool: "stop" },
    });
    // Intention présente, outil absent → échec.
    expect(
      evaluateOutputRules("Merci, bonne journée!", [stop], { intents: ["optout"], toolCallNames: [] })[0]
        .passed,
    ).toBe(false);
    // Intention présente, outil appelé → succès.
    expect(
      evaluateOutputRules("Merci, bonne journée!", [stop], {
        intents: ["optout"],
        toolCallNames: ["stop"],
      })[0].passed,
    ).toBe(true);
    // Aucune intention connue → la règle ne s'applique pas.
    expect(evaluateOutputRules("Bonjour!", [stop])[0].passed).toBe(true);
  });

  it("une règle off ou désactivée ne produit AUCUN verdict — l'interrupteur de l'admin est réel", () => {
    const off = { ...priceRule(), severity: "off" as GuardrailSeverity };
    const disabled = { ...priceRule(), key: "autre", enabled: false };
    const verdicts = evaluateOutputRules("Elle vaut 450 000 $", [off, disabled]);
    expect(verdicts).toHaveLength(0);
    expect(blockingFailures(verdicts)).toHaveLength(0);
  });

  it("une règle warn est évaluée mais ne bloque pas", () => {
    const warn = { ...priceRule(), severity: "warn" as GuardrailSeverity };
    const verdicts = evaluateOutputRules("Elle vaut 450 000 $", [warn]);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].severity).toBe("warn");
    expect(blockingFailures(verdicts)).toHaveLength(0);
  });

  it("llm_judge et custom_instruction ne sont pas jugés ici", () => {
    const judge = rule({ key: "honesty_ai", kind: "llm_judge", config: { criterion: "x" } });
    const instruction = rule({ key: "identify_sender", kind: "custom_instruction", config: {} });
    const verdicts = evaluateOutputRules("n'importe quoi", [judge, instruction]);
    expect(verdicts.every((v) => v.passed)).toBe(true);
  });
});

// ── Juge LLM ─────────────────────────────────────────────────────────────────

describe("judgeWithLlm", () => {
  const input = { criterion: "admet être une IA", output: "Oui, je suis un assistant automatisé." };

  it("lit un JSON propre", async () => {
    const verdict = await judgeWithLlm(input, async () =>
      JSON.stringify({ passed: true, reason: "admet clairement" }),
    );
    expect(verdict).toEqual({ passed: true, reason: "admet clairement" });
  });

  it("extrait le JSON même enrobé de prose ou de balises de code", async () => {
    const verdict = await judgeWithLlm(
      input,
      async () => 'Voici mon analyse :\n```json\n{"passed": false, "reason": "esquive"}\n```',
    );
    expect(verdict).toEqual({ passed: false, reason: "esquive" });
  });

  it("échoue FERMÉ sur une réponse illisible", async () => {
    const verdict = await judgeWithLlm(input, async () => "je pense que oui, plutôt bien");
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toBe("judge_unparseable");
  });

  it("échoue FERMÉ quand le champ passed n'est pas booléen", async () => {
    const verdict = await judgeWithLlm(input, async () => '{"passed":"oui"}');
    expect(verdict.passed).toBe(false);
  });

  it("échoue FERMÉ quand l'appel au modèle lève", async () => {
    const verdict = await judgeWithLlm(input, async () => {
      throw new Error("502");
    });
    expect(verdict).toEqual({ passed: false, reason: "judge_error" });
  });

  it("transmet le critère et la sortie au modèle", async () => {
    let seen = { system: "", user: "" };
    await judgeWithLlm(input, async (p) => {
      seen = p;
      return '{"passed":true,"reason":"ok"}';
    });
    expect(seen.user).toContain("admet être une IA");
    expect(seen.user).toContain("assistant automatisé");
    expect(seen.system).toContain("JSON");
  });
});

// ── Semence du noyau ─────────────────────────────────────────────────────────

describe("noyau semé", () => {
  it("valide entièrement (configs, setups, attentes)", () => {
    expect(validateKernel()).toEqual({ rules: 6, fixtures: 14, packs: 4 });
  });

  it("la règle LCAP d'identification est vérifiable (llm_judge, pas simple consigne)", () => {
    const rule = DEFAULT_GUARDRAIL_RULES.find((r) => r.key === "identify_sender")!;
    // Une règle `custom_instruction` ne peut JAMAIS échouer : elle serait
    // affichée « bloquante » tout en étant inerte.
    expect(rule.kind).toBe("llm_judge");
    expect((rule.config as { criterion: string }).criterion).toContain("PREMIER");
  });

  it("porte les six clés de règles du cahier", () => {
    expect(DEFAULT_GUARDRAIL_RULES.map((r) => r.key)).toEqual([
      "honesty_ai",
      "no_price_opinion",
      "no_commission_terms",
      "no_fabrication",
      "respect_stop",
      "identify_sender",
    ]);
    // Toutes bloquantes par défaut, toutes avec un texte injecté en L6.
    for (const r of DEFAULT_GUARDRAIL_RULES) {
      expect(r.severity).toBe("block");
      expect(r.promptText).toBeTruthy();
    }
  });

  it("chaque regex du noyau compile", () => {
    for (const r of DEFAULT_GUARDRAIL_RULES) {
      if (r.kind !== "forbidden_regex") continue;
      const config = r.config as { patterns: string[]; flags?: string };
      for (const pattern of config.patterns) {
        expect(() => new RegExp(pattern, config.flags ?? "iu")).not.toThrow();
      }
    }
    for (const f of DEFAULT_GUARDRAIL_FIXTURES) {
      for (const pattern of [...f.expectations.mustMatch, ...f.expectations.mustNotMatch]) {
        expect(() => new RegExp(pattern, "iu")).not.toThrow();
      }
    }
  });

  it("les quatorze fixtures ont des clés uniques et des attentes exploitables", () => {
    const keys = DEFAULT_GUARDRAIL_FIXTURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(14);
    for (const f of DEFAULT_GUARDRAIL_FIXTURES) {
      expect(() => fixtureSetupSchema.parse(f.setup)).not.toThrow();
      expect(() => fixtureExpectationsSchema.parse(f.expectations)).not.toThrow();
      const e = f.expectations;
      const hasSomething =
        e.judge !== null ||
        e.mustCallTool.length > 0 ||
        e.mustNotCallTool.length > 0 ||
        e.mustMatch.length > 0 ||
        e.mustNotMatch.length > 0 ||
        e.maxChars !== null;
      expect(hasSomething).toBe(true);
    }
  });

  it("les fixtures d'arrêt exigent l'outil stop", () => {
    for (const key of ["stop_keyword", "stop_phrase"]) {
      const fixture = DEFAULT_GUARDRAIL_FIXTURES.find((f) => f.key === key)!;
      expect(fixture.expectations.mustCallTool).toContain("stop");
    }
  });

  it("les quatre paquets d'objections sont complets", () => {
    expect(DEFAULT_OBJECTION_PACKS.map((p) => p.id)).toEqual([
      "buyer_fr",
      "seller_fr",
      "longterm_fr",
      "reengage_fr",
    ]);
    for (const pack of DEFAULT_OBJECTION_PACKS) {
      expect(pack.language).toBe("fr-CA");
      expect(pack.items.length).toBeGreaterThanOrEqual(2);
      for (const item of pack.items) {
        expect(item.triggerHint).toBeTruthy();
        expect(item.acknowledge).toBeTruthy();
        expect(item.reframe).toBeTruthy();
        expect(item.ask).toBeTruthy();
      }
    }
  });

  it("le corps L0 v1 porte les six sections du cahier", () => {
    for (const heading of [
      "# RÔLE",
      "# LIMITES PROFESSIONNELLES (OACIQ)",
      "# HONNÊTETÉ",
      "# RESPECT DU REFUS",
      "# FORMAT",
      "# ESCALADE",
    ]) {
      expect(CORE_PROMPT_V1).toContain(heading);
    }
  });
});
