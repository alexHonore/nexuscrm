/**
 * Unitaire — le bac à sable exerce-t-il VRAIMENT les mêmes pièces?
 *
 * Un aperçu qui diverge du moteur est pire qu'aucun aperçu : on règle un ton
 * sur un comportement qui n'existe pas en production. Ces vérifications sont
 * au niveau du SOURCE parce que c'est exactement la classe de bogue déjà
 * rencontrée — la suite de garde-fous n'offrait pas `tools` au modèle, et rien
 * dans le typage ne pouvait le voir.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src", "lib", "agent", "sandbox.ts"), "utf8");
/** Simulation d'outils PARTAGÉE par le bac à sable et la suite. */
const shared = readFileSync(
  join(process.cwd(), "src", "lib", "agent", "tool-simulation.ts"),
  "utf8",
);
const runner = readFileSync(join(process.cwd(), "src", "lib", "guardrails", "runner.ts"), "utf8");

describe("fidélité du bac à sable", () => {
  it("offre les outils de l'assistant au modèle", () => {
    // Sans `tools`, le modèle ne peut jamais en appeler un : l'aperçu
    // montrerait un assistant incapable de réserver alors qu'il en est capable.
    expect(source).toContain("const tools = toolDefsFor(config.tools)");
    // …et il est réellement passé à l'appel du modèle.
    // Assertion sur la PRÉSENCE dans l'appel, pas sur une position : ajouter
    // un champ au corps de la requête ne doit pas casser le test.
    const start = source.indexOf("generator.generate({");
    const call = source.slice(start, source.indexOf("});", start));
    expect(call).toMatch(/^\s*tools,\s*$/m);
  });

  it("utilise le prompt COMPILÉ, pas une reconstruction", () => {
    expect(source).toContain("row.compiledPrompt");
    expect(source).toContain("assistant_not_compiled");
  });

  it("rend la couche d'exécution avec le MÊME gabarit que la production", () => {
    expect(source).toContain("DEFAULT_TURN_INSTRUCTIONS");
    expect(source).toContain("renderTemplate");
    expect(source).toContain("row.includeRuntimeLayer");
  });

  it("applique les règles résolues, le filtre et les juges", () => {
    expect(source).toContain("resolvedRulesFor");
    expect(source).toContain("evaluateOutputRules");
    expect(source).toContain("judgeWithLlm");
    // Et le juge reçoit la position dans la conversation, sinon il échoue fermé
    // et bloque tout — la panne déjà vue en production.
    expect(source).toContain("isFirstOutbound");
  });

  it("classe l'entrant avec le classifieur de l'assistant", () => {
    expect(source).toContain("classifyInbound");
    expect(source).toContain("config.model.classifier.model");
  });

  it("applique la descente de cran sur un refus mou", () => {
    expect(source).toContain("applyRefusal");
    expect(source).toContain("requiredFieldsFor");
  });

  it("n'ÉCRIT rien et n'ENVOIE rien", () => {
    // Un aperçu qui enregistre pollue la boîte de réception de l'équipe ; un
    // aperçu qui envoie écrit à quelqu'un.
    expect(source).not.toMatch(/db\s*\n?\s*\.insert\(/);
    expect(source).not.toMatch(/db\s*\n?\s*\.update\(/);
    expect(source).not.toContain("enqueueJob");
    expect(source).not.toContain("sendSms");
  });

  it("ne consulte AUCUNE disponibilité réelle", () => {
    // Proposer de vraies heures dans un essai mène quelqu'un à croire qu'elles
    // sont réservées, et une réservation d'essai bloquerait l'agenda.
    expect(source).not.toContain("getInternalBookingProvider");
    expect(source).toContain("bac à sable — aucune disponibilité réelle");
  });

  it("fait l'aller-retour d'outils, comme la production", () => {
    // Sans lui, un modèle qui appelle un outil renvoie un texte VIDE : trois
    // tours sur cinq ressortaient vides dans la démonstration.
    expect(source).toContain("round < 2");
    expect(source).toContain("simulatedToolResult");
  });

  it("dédoublonne les outils dans un tour et le DIT au modèle", () => {
    // Sans ce retour, le modèle rappelle le même outil au second aller-retour
    // et ne rédige jamais. Production fait exactement pareil.
    expect(shared).toContain("déjà exécuté à ce tour");
    expect(source).toContain("sideEffectsDone");
  });

  it("la simulation d'outils est PARTAGÉE avec la suite de garde-fous", () => {
    // Deux copies dériveraient, et un assistant vert à la suite se
    // comporterait autrement à l'essai — un écart invisible jusqu'à ce que
    // quelqu'un compare les deux à la main.
    expect(source).toContain('from "./tool-simulation"');
    expect(runner).toContain("@/lib/agent/tool-simulation");
  });

  it("nomme ce que la PRODUCTION ferait du tour", () => {
    // Un brouillon vide n'est pas un bogue d'aperçu : c'est une escalade.
    for (const outcome of ["sent", "blocked", "stopped", "handoff", "no_text"]) {
      expect(source, outcome).toContain(`"${outcome}"`);
    }
  });

  it("un outil terminal arrête le tour", () => {
    expect(source).toContain("isTerminalTool(c.name)");
    expect(shared).toContain('name === "stop" || name === "handoff"');
  });

  it("n'exécute AUCUN outil : il les rapporte", () => {
    expect(source).not.toContain("executeTools");
    expect(source).toContain("out.toolCalls.map");
  });
});
