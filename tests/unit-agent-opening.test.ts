/**
 * Unitaire — la consigne d'ouverture/relance (`lib/agent/opening.ts`).
 *
 * La formulation est figée mot pour mot : c'est la MÊME que la production
 * envoie (`runtime.ts::outreachInstruction`). Le bac à sable s'en sert pour que
 * l'ouverture approuvée à l'essai soit produite par la consigne réelle — une
 * version antérieure avait sa propre phrase et l'admin réglait un ton sur un
 * message que la production n'écrivait jamais.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { outreachContext, outreachInstructionText } from "@/lib/agent/opening";

describe("outreachInstructionText", () => {
  it("ouverture sur un fil vide, avec le contexte de campagne « à ne pas citer »", () => {
    const text = outreachInstructionText({
      step: 0,
      historyLength: 0,
      campaignName: "Réactivation 2025",
      campaignDescription: "Anciens acheteurs sans nouvelles depuis 6 mois",
    });
    expect(text).toBe(
      "Tu écris en premier : ce contact n'a encore reçu aucun message de ta part. Contexte interne (à ne pas citer) : Réactivation 2025 — Anciens acheteurs sans nouvelles depuis 6 mois. Écris le PREMIER message de la conversation.",
    );
  });

  it("ouverture sans campagne : le contexte disparaît, la phrase reste celle de la production", () => {
    const text = outreachInstructionText({ step: 0, historyLength: 0 });
    expect(text.startsWith("Tu écris en premier : ce contact n'a encore reçu aucun message de ta part.")).toBe(true);
    expect(text.endsWith("Écris le PREMIER message de la conversation.")).toBe(true);
    expect(text).not.toContain("Contexte interne");
  });

  it("ouverture dans un fil qui a déjà des échanges", () => {
    const text = outreachInstructionText({ step: 0, historyLength: 3, campaignName: "Relance" });
    expect(text).toBe(
      "Tu écris en premier dans ce fil : tiens compte des échanges précédents. Contexte interne (à ne pas citer) : Relance. Écris ton premier message.",
    );
  });

  it("relance : numérote le barreau sur la longueur de l'échelle", () => {
    const text = outreachInstructionText({ step: 2, historyLength: 2, ladderLength: 4 });
    expect(text).toContain("Tu relances : le contact n'a pas répondu à ton dernier message (relance 2 sur 3).");
    expect(text).toContain("Écris une relance courte qui ne répète pas le message précédent et laisse une porte de sortie.");
  });

  it("relance sans échelle connue : le total vaut le barreau courant (comme la production)", () => {
    expect(outreachInstructionText({ step: 1, historyLength: 1 })).toContain("(relance 1 sur 1)");
  });

  it("un nom vide ou blanc = aucun contexte", () => {
    expect(outreachContext("", "desc")).toBe("");
    expect(outreachContext("  ", "desc")).toBe("");
    expect(outreachContext("Nom", "")).toBe("Contexte interne (à ne pas citer) : Nom.");
  });

  it("la production utilise la MÊME formulation (partagée ou copiée mot pour mot)", () => {
    // Tant que `runtime.ts` n'importe pas ce module, ses littéraux doivent
    // rester identiques ; une fois basculé, l'import suffit.
    const runtime = readFileSync(join(process.cwd(), "src", "lib", "agent", "runtime.ts"), "utf8");
    const shared = runtime.includes('from "./opening"');
    if (!shared) {
      expect(runtime).toContain(
        "Tu écris en premier : ce contact n'a encore reçu aucun message de ta part. ${context} Écris le PREMIER message de la conversation.",
      );
      expect(runtime).toContain(
        "Tu écris en premier dans ce fil : tiens compte des échanges précédents. ${context} Écris ton premier message.",
      );
      expect(runtime).toContain(
        "Tu relances : le contact n'a pas répondu à ton dernier message (relance ${outreach.step} sur ${total}). ${context} Écris une relance courte qui ne répète pas le message précédent et laisse une porte de sortie.",
      );
    }
  });
});
