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

  it("un chemin de repli ajouté est signalé", () => {
    const after = base();
    after.goal.fallbacks = [
      { type: "phone_call", durationMin: 15, appointmentType: null, withUserId: null, requiredFields: [], slotOfferCount: 2, confirmationTemplate: null },
    ];
    const d = diffConfig(base(), after);
    expect(d.changed).toContain("goal.fallbacks");
    expect(d.immediate).toContain("goal.fallbacks");
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
