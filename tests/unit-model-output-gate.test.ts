import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isHumanReadable, looksLikeMachineOutput } from "@/lib/model-output";
import { pickOutboundDraft } from "@/lib/agent/draft";
import { parseTranscriptOutput } from "@/lib/transcripts/prompt";

/**
 * La porte entre ce qu'un modèle écrit et ce qu'un humain lit.
 *
 * Ce fichier tient DEUX promesses. La première est sur la règle elle-même :
 * les deux sorties qui ont vraiment atteint des clients sont refusées, et rien
 * de ce qu'un téléphoniste écrirait ne l'est. La seconde est sur les
 * FRONTIÈRES : chaque endroit qui écrit un texte de modèle là où un humain le
 * lira appelle bien la porte. C'est celle-là qui compte le plus — les deux
 * pannes de 2026 ne sont pas venues d'une règle fausse, mais d'un chemin
 * d'écriture qui n'en avait aucune.
 */

const SRC = join(process.cwd(), "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

// ── Les deux sorties qui sont VRAIMENT parties ──────────────────────────────

/** Le corps exact du SMS livré à une cliente le 2026-08-25. */
const SMS_LIVRÉ = "{ }";

/** Le début exact du commentaire poussé sur 8 fiches, dont celle du 2026-09-15. */
const NOTE_POUSSÉE =
  '{\n  "transcript": "Allô. Allô. Monsieur Larbi, est-ce que vous m\'entendez ?';

describe("les sorties qui ont atteint un client", () => {
  it("le SMS « { } » est refusé", () => {
    expect(looksLikeMachineOutput(SMS_LIVRÉ)).toBe(true);
  });

  it("la note « { \"transcript\"… » est refusée", () => {
    expect(looksLikeMachineOutput(NOTE_POUSSÉE)).toBe(true);
  });

  it("et aucune des deux ne ressort du lecteur ni du sélecteur", () => {
    expect(parseTranscriptOutput(NOTE_POUSSÉE).summary).toBe("");
    expect(pickOutboundDraft(SMS_LIVRÉ).draft).toBe("");
  });
});

describe("ce qu'un humain écrit passe", () => {
  const vrais = [
    "Bonjour Jessica, avez-vous un moment cette semaine ?",
    "Merci Nadjia, bonne journée.",
    "Parfait — 14 h, mardi.",
    // Une accolade DANS le message n'en fait pas du bruit de machine.
    "Votre code {G1V 2M3} est bien noté.",
    // La réponse que le prompt des notes RÉCLAME pour une boîte vocale.
    "Boîte vocale : message type {} laissé, aucun échange.",
    "Client rappelle en janvier. Budget 400-500k, secteur LaSalle.",
  ];
  for (const texte of vrais) {
    it(`« ${texte.slice(0, 40)}… »`, () => {
      expect(isHumanReadable(texte)).toBe(true);
    });
  }
});

describe("le bruit de machine est refusé", () => {
  const faux = [
    "{ }",
    '{"reason":"Projet de vente non actif"}',
    '[{"name":"read_client"}]',
    "<thinking>il faut clore</thinking>",
    "```json\n{}\n```",
    "---",
    "…",
    "   ",
    "",
  ];
  for (const texte of faux) {
    it(`« ${texte.slice(0, 40)} »`, () => {
      expect(looksLikeMachineOutput(texte)).toBe(true);
    });
  }
});

/**
 * L'invariant de FRONTIÈRE. Une règle juste posée sur trois chemins sur quatre
 * ne vaut rien : c'est le quatrième qui écrit sur la fiche. Chaque fichier qui
 * mène un texte de modèle vers un humain doit appeler la porte — et ce test
 * tombe le jour où quelqu'un ajoute un cinquième chemin sans elle.
 */
describe("chaque frontière d'écriture passe par la porte", () => {
  const frontières: Array<{ fichier: string; écrit: string }> = [
    { fichier: "lib/transcripts/run.ts", écrit: "la note d'appel, en commentaire sur la fiche" },
    { fichier: "lib/agent/runtime.ts", écrit: "la note d'assistant et la note de rappel" },
    { fichier: "lib/jobs/handlers/send-sms.ts", écrit: "le corps du texto, juste avant Twilio" },
    { fichier: "lib/agent/draft.ts", écrit: "le choix du paragraphe qui part au client" },
  ];

  for (const { fichier, écrit } of frontières) {
    it(`${fichier} — ${écrit}`, () => {
      const source = read(fichier);
      expect(source).toMatch(/looksLikeMachineOutput|isHumanReadable/);
      expect(source).toContain('@/lib/model-output');
    });
  }

  it("la règle n'est écrite qu'à UN endroit", () => {
    // Deux définitions du « bruit de machine » divergeraient, et c'est
    // précisément une divergence entre deux copies d'une même découpe qui a
    // laissé « { } » partir sans que l'aperçu de l'admin le montre jamais.
    const définition = /!\/\\p\{L\}\/u\.test\(/;
    const ailleurs = [
      "lib/agent/draft.ts",
      "lib/agent/runtime.ts",
      "lib/agent/sandbox.ts",
      "lib/transcripts/run.ts",
      "lib/transcripts/prompt.ts",
      "lib/jobs/handlers/send-sms.ts",
    ];
    expect(read("lib/model-output.ts")).toMatch(définition);
    for (const fichier of ailleurs) {
      expect(read(fichier), fichier).not.toMatch(définition);
    }
  });
});
