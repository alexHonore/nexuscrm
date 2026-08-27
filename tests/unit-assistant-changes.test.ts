/**
 * Unitaire — ce qu'une sauvegarde change, et quand.
 *
 * Le piège qu'on ferme ici : le moteur relit certains réglages à chaque tour et
 * en lit d'autres dans le prompt compilé. Confondre les deux fait croire qu'une
 * modification est prise en compte alors qu'elle dort.
 */
import { describe, expect, it } from "vitest";
import { assistantConfigSchema, type AssistantConfig } from "@/lib/assistants/schema";
import { diffConfig } from "@/lib/assistants/changes";

const base = (): AssistantConfig =>
  assistantConfigSchema.parse({
    name: "Acheteur FB",
    identity: {},
    goal: { primary: { type: "video_meeting", durationMin: 30 }, fallbacks: [] },
    approach: {},
    model: {},
  });

describe("diffConfig", () => {
  it("aucune modification = rien à faire", () => {
    const d = diffConfig(base(), base());
    expect(d.changed).toEqual([]);
    expect(d.needsRecompile).toBe(false);
  });

  it("un réglage relu à l'exécution s'applique tout de suite", () => {
    const after = base();
    after.approach.maxTurns = 24;
    const d = diffConfig(base(), after);
    expect(d.immediate).toContain("approach.maxTurns");
    expect(d.pending).toEqual([]);
    expect(d.needsRecompile).toBe(false);
  });

  it("un réglage de ton attend la recompilation", () => {
    const after = base();
    after.approach.warmth = 5;
    const d = diffConfig(base(), after);
    expect(d.pending).toContain("approach.warmth");
    expect(d.immediate).toEqual([]);
    expect(d.needsRecompile).toBe(true);
  });

  it("les deux à la fois sont distingués", () => {
    const after = base();
    after.approach.warmth = 5;
    after.model.temperature = 0.2;
    const d = diffConfig(base(), after);
    expect(d.immediate).toContain("model.temperature");
    expect(d.pending).toContain("approach.warmth");
    expect(d.needsRecompile).toBe(true);
  });

  it("les faits autorisés vivent dans le prompt : recompilation requise", () => {
    const after = base();
    after.knowledge.claims = ["Nous couvrons Québec."];
    const d = diffConfig(base(), after);
    expect(d.pending).toContain("knowledge.claims");
    expect(d.needsRecompile).toBe(true);
  });

  it("un tableau est comparé en bloc, pas élément par élément", () => {
    const after = base();
    after.tools = ["stop", "handoff"];
    const d = diffConfig(base(), after);
    expect(d.changed).toEqual(["tools"]);
    expect(d.immediate).toEqual(["tools"]);
  });

  it("réordonner les outils compte comme une modification", () => {
    const before = base();
    before.tools = ["stop", "handoff"];
    const after = base();
    after.tools = ["handoff", "stop"];
    expect(diffConfig(before, after).changed).toEqual(["tools"]);
  });

  it("un chemin de repli ajouté est signalé — immédiat ET en attente", () => {
    const after = base();
    after.goal.fallbacks = [
      { type: "phone_call", durationMin: 15, appointmentType: "meet", withUserId: null, requiredFields: ["project_type"], slotOfferCount: 2, confirmationTemplate: null, instruction: null },
    ];
    const d = diffConfig(base(), after);
    expect(d.changed).toContain("goal.fallbacks");
    // Le moteur relit la chaîne à chaque tour (cran courant, créneaux)…
    expect(d.immediate).toContain("goal.fallbacks");
    // …mais L2 la rédige aussi : sans recompilation, le prompt décrit une
    // chaîne qui n'est plus celle que le moteur exécute.
    expect(d.pending).toContain("goal.fallbacks");
    expect(d.needsRecompile).toBe(true);
  });

  it("changer l'objectif principal force la recompilation (L2 le rédige)", () => {
    const after = base();
    after.goal.primary.type = "qualify_only";
    const d = diffConfig(base(), after);
    expect(d.pending).toContain("goal.primary.type");
    expect(d.needsRecompile).toBe(true);
  });

  it("la persistance et la longueur max vivent dans L3 : JAMAIS immédiates", () => {
    // Le piège fermé ici : persistance 5 → 1 était classée « immédiate », la
    // fiche disait « s'applique dès le prochain message », et le prompt
    // compilé continuait de dire « Persistance : insiste ». Aucun code
    // d'exécution ne relit ces deux valeurs — seul le prompt les porte.
    const after = base();
    after.approach.persistence = 1;
    after.approach.maxChars = 160;
    const d = diffConfig(base(), after);
    expect(d.immediate).toEqual([]);
    expect(d.pending).toEqual(["approach.maxChars", "approach.persistence"]);
    expect(d.needsRecompile).toBe(true);
  });

  it("§ basculer stricte → souple attend la recompilation, et le DIT", () => {
    // Le mode ne vit que dans le prompt compilé. S'il tombait dans aucune des
    // deux listes, la fiche annoncerait « 0 réglage en attente » au-dessus
    // d'un prompt qui décrit encore l'autre mode — exactement le mensonge que
    // ce module existe pour empêcher.
    const after = base();
    after.approach.qualificationMode = "flexible";
    after.approach.questionCeiling = 6;
    const d = diffConfig(base(), after);
    expect(d.immediate).toEqual([]);
    expect(d.pending).toEqual(["approach.qualificationMode", "approach.questionCeiling"]);
    expect(d.needsRecompile).toBe(true);
  });

  it("seuls les réglages strictement relus à l'exécution laissent le prompt intact", () => {
    for (const mutate of [
      (c: AssistantConfig) => void (c.approach.maxTurns = 20),
      (c: AssistantConfig) => void (c.approach.replySpeed = "instant"),
      (c: AssistantConfig) => void (c.model.temperature = 0.1),
      (c: AssistantConfig) => void (c.tools = ["stop"]),
      (c: AssistantConfig) => void (c.requireSuitePass = false),
      (c: AssistantConfig) => void (c.includeRuntimeLayer = false),
      (c: AssistantConfig) => void (c.turnInstructions = "Bloc libre"),
    ]) {
      const after = base();
      mutate(after);
      const d = diffConfig(base(), after);
      expect(d.needsRecompile, d.changed.join(",")).toBe(false);
      expect(d.pending, d.changed.join(",")).toEqual([]);
    }
  });

  it("par prudence, un chemin inconnu des deux listes force la recompilation", () => {
    // « name » n'est ni un réglage d'exécution ni un bloc de prompt identifié :
    // recompiler pour rien coûte des secondes, ne pas recompiler laisse mentir
    // le prompt.
    const after = base();
    after.name = "Autre nom";
    const d = diffConfig(base(), after);
    expect(d.needsRecompile).toBe(true);
  });

  it("passer en prompt libre attend la recompilation", () => {
    const after = base();
    after.promptMode = "raw";
    after.systemPromptOverride = "Tu es…";
    const d = diffConfig(base(), after);
    expect(d.pending).toContain("promptMode");
    expect(d.pending).toContain("systemPromptOverride");
    expect(d.needsRecompile).toBe(true);
  });
});
