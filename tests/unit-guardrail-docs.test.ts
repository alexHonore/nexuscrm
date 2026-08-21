/**
 * Unitaire — aide des garde-fous.
 *
 * L'aide existe pour rendre lisible une différence qui ne l'est pas : « motif
 * interdit » et « termes interdits » se décrivent presque pareil, et le choix
 * décide pourtant si « commissionnaire » déclenche la règle écrite pour
 * « commission ». Un type sans exemple concret n'apprend rien.
 */
import { describe, expect, it } from "vitest";
import {
  GUARDRAIL_KIND_DOCS,
  GUARDRAIL_SEVERITY_DOCS,
  defaultConfigFor,
  kindDoc,
} from "@/lib/guardrails/docs";
import {
  GUARDRAIL_KINDS,
  GUARDRAIL_SEVERITIES,
  safeParseRuleConfig,
} from "@/lib/guardrails/types";

describe("aide des types de règle", () => {
  it("CHAQUE type est documenté", () => {
    for (const kind of GUARDRAIL_KINDS) {
      expect(GUARDRAIL_KIND_DOCS[kind], kind).toBeDefined();
      expect(GUARDRAIL_KIND_DOCS[kind].kind).toBe(kind);
    }
  });

  it("chaque type donne un exemple qui PASSE et un exemple ATTRAPÉ", () => {
    for (const kind of GUARDRAIL_KINDS) {
      const doc = GUARDRAIL_KIND_DOCS[kind];
      expect(doc.passesFr.length, kind).toBeGreaterThan(20);
      expect(doc.caughtFr.length, kind).toBeGreaterThan(20);
      expect(doc.pitfallFr.length, kind).toBeGreaterThan(30);
      expect(doc.whenFr.length, kind).toBeGreaterThan(20);
    }
  });

  it("seul le jugement par le modèle coûte un appel", () => {
    // Décisif sur le volume : une règle par brouillon multiplie la facture.
    const costly = GUARDRAIL_KINDS.filter((k) => GUARDRAIL_KIND_DOCS[k].costsModelCall);
    expect(costly).toEqual(["llm_judge"]);
  });

  it("chaque sévérité dit ce qui arrive au message", () => {
    for (const severity of GUARDRAIL_SEVERITIES) {
      expect(GUARDRAIL_SEVERITY_DOCS[severity].whatFr.length, severity).toBeGreaterThan(30);
    }
    // « warn » doit dire que le message PART quand même — c'est toute la
    // différence avec « block », et la confondre laisse croire à une protection.
    expect(GUARDRAIL_SEVERITY_DOCS.warn.whatFr).toMatch(/PART|part/);
  });

  it("le piège de la consigne de prompt dit qu'elle ne bloque rien", () => {
    expect(GUARDRAIL_KIND_DOCS.custom_instruction.pitfallFr).toMatch(/rien|AUCUN/i);
  });

  it("un type inconnu ne fait pas planter la recherche", () => {
    expect(kindDoc("inventé")).toBeUndefined();
  });
});

describe("configuration par défaut d'un type", () => {
  it("chaque défaut est du bon FORME pour son type", () => {
    // Le formulaire de création part de ces valeurs : si l'une ne correspond
    // pas à son schéma, l'écran s'ouvre déjà cassé.
    for (const kind of GUARDRAIL_KINDS) {
      const config = defaultConfigFor(kind);
      expect(config, kind).toBeDefined();
      const parsed = safeParseRuleConfig(kind, config);
      // Les listes vides sont refusées par le schéma (une règle sans terme ne
      // protège de rien) — c'est attendu : le défaut amorce le formulaire.
      const allowedToFail = ["forbidden_regex", "forbidden_terms", "llm_judge"];
      if (!allowedToFail.includes(kind)) {
        expect(parsed.success, `${kind}: ${JSON.stringify(config)}`).toBe(true);
      }
    }
  });

  it("changer de type repart d'une config compatible", () => {
    // Le dialogue remplace la config quand le type change : garder l'ancienne
    // enregistrerait la config d'un autre type.
    expect(defaultConfigFor("max_chars")).toEqual({ max: 300 });
    expect(defaultConfigFor("max_questions")).toEqual({ max: 1 });
    expect(defaultConfigFor("link_policy")).toEqual({ allowedDomains: [] });
    expect(defaultConfigFor("required_tool_on_intent")).toEqual({ intent: "opt_out", tool: "stop" });
  });
});
