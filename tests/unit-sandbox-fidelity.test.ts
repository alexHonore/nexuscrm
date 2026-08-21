/**
 * Unitaire — le bac à sable exerce-t-il VRAIMENT les mêmes pièces?
 *
 * Un aperçu qui diverge du moteur est pire qu'aucun aperçu : on règle un ton
 * sur un comportement qui n'existe pas en production. Ces vérifications sont
 * au niveau du SOURCE parce que c'est exactement la classe de bogue déjà
 * rencontrée — la suite de garde-fous n'offrait pas `tools` au modèle, et rien
 * dans le typage ne pouvait le voir. Le comportement lui-même est couvert par
 * `tests/int-sandbox.test.ts`.
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
const runtime = readFileSync(join(process.cwd(), "src", "lib", "agent", "runtime.ts"), "utf8");

/** Le corps du code, sans commentaires ni imports : ce qui peut atteindre le modèle. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^import .*$/gm, "");
}

describe("fidélité du bac à sable", () => {
  it("offre les outils de l'assistant au modèle", () => {
    // Sans `tools`, le modèle ne peut jamais en appeler un : l'aperçu
    // montrerait un assistant incapable de réserver alors qu'il en est capable.
    expect(source).toContain("const tools = toolDefsFor(config.tools)");
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
    expect(source).toContain("isFirstOutbound: turnsUsed === 0");
  });

  it("classe l'entrant avec le classifieur de l'assistant et RAPPORTE ses pannes", () => {
    expect(source).toContain("classifyInbound");
    expect(source).toContain("config.model.classifier.model");
    expect(source).toContain("classifierError");
  });

  it("applique la descente de cran sur un refus mou", () => {
    expect(source).toContain("applyRefusal");
    expect(source).toContain("requiredFieldsFor");
  });

  it("passe les MÊMES portes que la production AVANT d'appeler le générateur", () => {
    // Désabonnement, refus ferme, budget de tours, chaîne épuisée, demande
    // d'humain : la production n'appelle pas le modèle — l'aperçu non plus.
    const gates = source.indexOf("classification.optOut");
    const generate = source.indexOf("generator.generate(");
    expect(gates).toBeGreaterThan(-1);
    expect(gates).toBeLessThan(generate);
    for (const reason of [
      "optout",
      "hard_refusal",
      "client_wants_human",
      "goal_chain_exhausted",
      "max_turns",
    ]) {
      expect(source, reason).toContain(`"${reason}"`);
    }
    expect(source).toContain(
      "turnsUsed >= config.approach.maxTurns || downgrade.exhausted || classification.wantsHuman",
    );
  });

  it("n'ÉCRIT rien et n'ENVOIE rien", () => {
    expect(source).not.toMatch(/db\s*\n?\s*\.insert\(/);
    expect(source).not.toMatch(/db\s*\n?\s*\.update\(/);
    expect(source).not.toContain("enqueueJob");
    expect(source).not.toContain("sendSms");
  });

  it("ne consulte AUCUNE disponibilité réelle, mais ne dit JAMAIS au modèle qu'il est à l'essai", () => {
    expect(source).not.toContain("getInternalBookingProvider");
    // Ce que le modèle lit (code hors commentaires) ne contient aucun aveu.
    const code = codeOnly(source) + codeOnly(shared);
    expect(code).not.toMatch(/bac à sable/i);
    expect(code).not.toMatch(/"[^"\n]*sandbox[^"\n]*"/i);
    expect(code).not.toMatch(/`[^`\n]*sandbox[^`\n]*`/i);
    expect(code).not.toMatch(/`[^`\n]*simulation[^`\n]*`/i);
    expect(code).not.toMatch(/"[^"\n]*simulation[^"\n]*"/i);
    // Les disponibilités de la couche L7 et de get_slots viennent de la MÊME
    // source, et « aucune » exactement quand la production dirait « aucune ».
    // Les disponibilités suivent les JOURS RÉSERVABLES configurés : un essai
    // « juste la fin de semaine » doit refléter la production, pas un agenda
    // figé qui n'ouvre jamais le samedi.
    expect(source).toContain("simulatedSlotsText(rung.goal.slotOfferCount, undefined, { days: bookableDays })");
    expect(source).toContain('getSetting("booking")');
    expect(source).toContain("bookableDays,");
    expect(source).toContain('rungNeedsSlots(rung) && rung.goal.appointmentType');
    expect(source).toContain(': "aucune"');
  });

  it("fait l'aller-retour d'outils, comme la production, avec la même simulation", () => {
    expect(source).toContain("round < 2");
    expect(source).toContain("simulateToolCall(call.name, sideEffectsDone, {");
    // Les arguments, le cran et la qualification sont transmis : sans eux,
    // book_meeting ne peut pas refuser ce que la production refuse.
    expect(source).toContain("args: call.arguments");
    expect(source).toContain("appointmentType: rung.goal.appointmentType");
    expect(source).toContain("requiredFields: requiredFieldsFor(rung)");
    // Le filtre ne voit que les appels VALIDES, comme `effects.filter(ok)`.
    expect(source).toContain("toolCalls.filter((c) => c.ok).map((c) => c.name)");
  });

  it("la simulation d'outils est PARTAGÉE avec la suite, et applique les règles de production", () => {
    expect(source).toContain('from "./tool-simulation"');
    expect(runner).toContain("@/lib/agent/tool-simulation");
    expect(shared).toContain("parseToolArgs");
    expect(shared).toContain("missingFieldsError");
    expect(shared).toContain("déjà exécuté à ce tour");
    // Même liste d'effets de bord qu'en production.
    const prodList = /SIDE_EFFECT_TOOLS = new Set\(\[([^\]]+)\]\)/.exec(runtime)?.[1] ?? "";
    for (const name of ["book_meeting", "stop", "handoff", "schedule_followup"]) {
      expect(prodList, name).toContain(name);
      expect(shared, name).toContain(`"${name}"`);
    }
  });

  it("coupe au premier paragraphe et régénère UNE fois sur un refus, comme la production", () => {
    expect(source).toContain("attempt < 2");
    expect(source).toContain("CONSIGNE DE CORRECTION");
    expect(source).toContain(".split(/\\n{2,}/)");
    expect(source).toContain("droppedParagraphs");
    // Le même texte de correction que la production, mot pour mot.
    const prodCorrection = /CONSIGNE DE CORRECTION : ta réponse précédente[^`]*`/.exec(runtime)?.[0];
    expect(prodCorrection).toBeTruthy();
    expect(source).toContain(prodCorrection as string);
  });

  it("utilise la MÊME consigne d'ouverture que la production", () => {
    expect(source).toContain('from "./opening"');
    expect(source).toContain("outreachInstructionText(");
    // L'ancienne phrase maison ne doit pas revenir.
    expect(source).not.toContain("Ce contact vient d'arriver comme nouveau lead");
  });

  it("nomme ce que la PRODUCTION ferait du tour, avec la raison", () => {
    for (const outcome of ["sent", "blocked", "stopped", "handoff", "error"]) {
      expect(source, outcome).toContain(`"${outcome}"`);
    }
    for (const reason of ["tool_stop", "tool_handoff", "booking_failed", "no_text", "blocked_after_regeneration"]) {
      expect(source, reason).toContain(`"${reason}"`);
    }
    // Le verdict suit l'ordre de la production : outil terminal, panne,
    // bloqué, réservation échouée, sans texte, envoyé.
    const order = [
      'reason: terminatedByTool === "stop" ? "tool_stop" : "tool_handoff"',
      'reason: "llm_error"',
      'outcome: "blocked"',
      'reason: "booking_failed"',
      'reason: "no_text"',
      'outcome: "sent", reason: null',
    ].map((needle) => source.lastIndexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < order.length; i += 1) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  it("écarte les messages vides de l'historique — la production n'en a jamais", () => {
    expect(source).toContain('input.history.filter((m) => m.content.trim() !== "")');
  });

  it("n'exécute AUCUN outil : il les simule", () => {
    expect(source).not.toContain("executeTools");
    expect(shared).not.toContain("getInternalBookingProvider");
    expect(shared).not.toContain("@/db");
  });
});
