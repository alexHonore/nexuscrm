/**
 * Unitaire — classification d'un tour entrant. Modèle injecté, aucun réseau.
 *
 * Ce que ce fichier verrouille : le mot-clé exact (STOP/ARRÊT…) est tranché en
 * CODE et le modèle ne peut jamais l'annuler ; une panne du classifieur ne
 * fabrique pas un refus, et n'en efface pas un.
 */
import { describe, expect, it } from "vitest";
import { classifyInbound } from "@/lib/agent/classify";

const answer = (o: Record<string, unknown>) => async () => JSON.stringify(o);

describe("classifyInbound", () => {
  it("lit une classification propre", async () => {
    const { classification, modelUsed } = await classifyInbound(
      "je cherche à vendre au printemps",
      answer({ refusal: "none", qualification: { project_type: "vendre", timing: "printemps" } }),
    );
    expect(modelUsed).toBe(true);
    expect(classification.refusal).toBe("none");
    expect(classification.qualification).toEqual({ project_type: "vendre", timing: "printemps" });
    expect(classification.optOut).toBe(false);
  });

  it("le mot-clé STOP est tranché en code — le modèle ne peut pas l'annuler", async () => {
    const { classification } = await classifyInbound(
      "STOP",
      // Le modèle se trompe complètement : on ne le suit pas.
      answer({ optOut: false, refusal: "none" }),
    );
    expect(classification.optOut).toBe(true);
    expect(classification.refusal).toBe("hard");
  });

  it("« ARRÊT » accentué compte aussi", async () => {
    const { classification } = await classifyInbound("Arrêt", answer({ refusal: "none" }));
    expect(classification.optOut).toBe(true);
  });

  it("le modèle PEUT ajouter un désabonnement en langage naturel", async () => {
    const { classification } = await classifyInbound(
      "enlevez-moi de vos listes s'il vous plaît",
      answer({ optOut: true, refusal: "hard" }),
    );
    expect(classification.optOut).toBe(true);
    expect(classification.refusal).toBe("hard");
  });

  it("distingue refus mou et refus ferme", async () => {
    const soft = await classifyInbound("pas cette semaine", answer({ refusal: "soft" }));
    expect(soft.classification.refusal).toBe("soft");
    const hard = await classifyInbound("non merci", answer({ refusal: "hard" }));
    expect(hard.classification.refusal).toBe("hard");
  });

  it("extrait le JSON même enrobé de prose", async () => {
    const { classification } = await classifyInbound(
      "budget 400k",
      async () => 'Voici :\n```json\n{"refusal":"none","qualification":{"budget":"400k"}}\n```',
    );
    expect(classification.qualification.budget).toBe("400k");
  });

  it("une panne du modèle ne fabrique PAS de refus", async () => {
    const { classification, modelUsed, error } = await classifyInbound("bonjour", async () => {
      throw new Error("llm_http_503");
    });
    expect(modelUsed).toBe(false);
    expect(error).toContain("503");
    expect(classification.refusal).toBe("none");
    expect(classification.optOut).toBe(false);
  });

  it("une panne du modèle n'EFFACE pas un STOP déjà détecté", async () => {
    const { classification } = await classifyInbound("STOP", async () => {
      throw new Error("llm_http_503");
    });
    expect(classification.optOut).toBe(true);
    expect(classification.refusal).toBe("hard");
  });

  it("une réponse illisible retombe sur une classification neutre", async () => {
    const { classification, error } = await classifyInbound("bonjour", async () => "euh, peut-être");
    expect(error).toBe("classifier_unparseable");
    expect(classification.refusal).toBe("none");
  });

  it("ignore une clé de qualification hors liste au lieu de tout rejeter", async () => {
    const { classification } = await classifyInbound(
      "j'ai un chien",
      answer({ refusal: "none", qualification: { animal: "chien" } }),
    );
    // Clé inconnue : la classification reste exploitable.
    expect(classification.refusal).toBe("none");
    expect(classification.qualification).not.toHaveProperty("animal");
  });

  it("relaie wantsHuman et unintelligible", async () => {
    const human = await classifyInbound("je veux parler à quelqu'un", answer({ wantsHuman: true }));
    expect(human.classification.wantsHuman).toBe(true);
    const garbled = await classifyInbound("zzz ??", answer({ unintelligible: true }));
    expect(garbled.classification.unintelligible).toBe(true);
  });
});
