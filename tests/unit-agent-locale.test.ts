/**
 * Unitaire — la langue de l'INTERFACE ne touche jamais celle de l'ASSISTANT.
 *
 * L'application se lit en français ou en anglais, au choix de l'utilisateur.
 * L'assistant SMS, lui, écrit dans la langue de SA configuration : ses
 * destinataires sont des Québécois francophones, et ce que le courtier a
 * choisi comme affichage n'a rien à voir avec ce qu'un client reçoit sur son
 * téléphone.
 *
 * La façon dont ça casserait est banale : quelqu'un ajoute `useTranslations`
 * dans un module du moteur pour « traduire une étiquette », et six mois plus
 * tard un administrateur passe l'écran en anglais — les SMS suivent. Ce test
 * l'interdit à la racine : aucun module du chemin d'exécution n'a le droit de
 * connaître la locale de la requête.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assistantConfigInputSchema,
  assistantConfigSchema,
  type AssistantConfig,
} from "@/lib/assistants/schema";
import { compileAssistantPrompt, type CoreDoc } from "@/lib/agent/compile";

/** Les dossiers dont le contenu part dans un SMS ou dans un prompt. */
const ENGINE_PATHS = [
  "src/lib/agent",
  "src/lib/sms",
  "src/lib/sms-server",
  "src/lib/guardrails",
  "src/lib/campaigns",
  "src/lib/assistants",
  // Les gestionnaires de tâches sont le DERNIER maillon : c'est
  // `handlers/send-sms.ts` qui remet le texte au transporteur.
  "src/lib/jobs",
];

/**
 * L'aide en ligne des garde-fous et des campagnes vit dans les mêmes dossiers
 * que leur moteur, et elle, elle DOIT suivre la langue de l'écran. Ces
 * fichiers ne portent aucun texte qui parte dans un prompt (un test dédié le
 * vérifie dans `unit-docs-locale`).
 */
const UI_HELP = new Set([
  "src/lib/guardrails/docs.ts",
  "src/lib/guardrails/docs.en.ts",
  "src/lib/campaigns/docs.ts",
  "src/lib/campaigns/docs.en.ts",
]);

/** Tout ce qui ferait entrer la locale de la requête dans un module. */
const FORBIDDEN = [
  { pattern: /from\s+["']next-intl/, why: "next-intl" },
  { pattern: /\bNEXT_LOCALE\b/, why: "le cookie NEXT_LOCALE" },
  { pattern: /from\s+["']next\/headers["']/, why: "next/headers (cookies de la requête)" },
  { pattern: /\buseLocale\s*\(/, why: "useLocale()" },
  { pattern: /\bgetLocale\s*\(/, why: "getLocale()" },
];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("langue de l'assistant", () => {
  it("aucun module du moteur ne connaît la locale de l'interface", () => {
    const offenders: string[] = [];
    for (const dir of ENGINE_PATHS) {
      for (const file of walk(dir)) {
        if (UI_HELP.has(file)) continue;
        const source = readFileSync(file, "utf8");
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(source)) offenders.push(`${file} → ${why}`);
        }
      }
    }
    expect(
      offenders,
      "Ces modules décident de ce qu'un client reçoit par SMS ; la langue de l'écran ne doit " +
        "pas y entrer :\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("un préréglage de garde-fou enregistre son libellé FRANÇAIS", () => {
    // Quand un garde-fou refuse un brouillon, le moteur renvoie le modèle au
    // travail avec « refusée par un garde-fou (<libellé>) » — le libellé
    // ENTRE dans le prompt. Le localiser ferait écrire un assistant québécois
    // avec une consigne anglaise dès qu'un administrateur anglophone crée une
    // règle depuis un préréglage.
    const correction = readFileSync("src/lib/agent/runtime.ts", "utf8");
    expect(correction, "le libellé n'entre plus dans le prompt : ce test peut être revu").toContain(
      "CONSIGNE DE CORRECTION",
    );

    const dialog = readFileSync("src/components/admin/guardrail-rule-dialog.tsx", "utf8");
    expect(dialog).toContain("label: preset.labelFr");
    expect(dialog).not.toMatch(/label:\s*text\.label/);
  });

  it("la configuration porte la langue de rédaction, et c'est la seule source", () => {
    const config = assistantConfigSchema.parse({
      name: "A",
      identity: {},
      goal: { primary: { type: "video_meeting" } },
      approach: {},
      model: {},
    });
    expect(config.language).toBe("fr-CA");
  });

  it("le prompt compilé est identique quelle que soit la locale d'exécution", () => {
    const core: CoreDoc = { version: 1, body: "# RÔLE\nAssistant de {{org}}." };
    const config: AssistantConfig = assistantConfigSchema.parse({
      name: "A",
      identity: { orgName: "Groupe Nexus", brokerName: "Alex-Honoré" },
      goal: { primary: { type: "video_meeting", durationMin: 30 } },
      approach: {},
      knowledge: { claims: ["Nous couvrons Québec."] },
      model: {},
    });

    const before = compileAssistantPrompt(config, core, [], []).prompt;
    const saved = process.env.NEXT_LOCALE;
    try {
      process.env.NEXT_LOCALE = "en";
      expect(compileAssistantPrompt(config, core, [], []).prompt).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.NEXT_LOCALE;
      else process.env.NEXT_LOCALE = saved;
    }
    // …et il est bien rédigé en français.
    expect(before).toContain("CONNAISSANCES ET CONSIGNES");
  });
});

describe("langue de rédaction — réglage réel", () => {
  const core: CoreDoc = { version: 1, body: "# RÔLE\nAssistant." };
  const build = (overrides: Record<string, unknown>) =>
    compileAssistantPrompt(
      assistantConfigSchema.parse({
        name: "A",
        identity: {},
        goal: { primary: { type: "video_meeting" } },
        approach: {},
        model: {},
        ...overrides,
      }),
      core,
      [],
      [],
    ).layers.find((l) => l.id === "L3")!.text;

  it("la langue principale est ÉCRITE dans le prompt, pas seulement stockée", () => {
    // Elle était enregistrée sur la fiche et n'entrait dans aucune couche : le
    // modèle écrivait en français par imprégnation, pas sur consigne.
    expect(build({ language: "fr-CA" })).toContain("Tu écris en français québécois.");
    expect(build({ language: "en-CA" })).toContain("Tu écris en anglais canadien.");
  });

  it("sans seconde langue, l'assistant NE bascule pas", () => {
    const l3 = build({ language: "fr-CA", secondaryLanguage: null });
    expect(l3).toContain("tu continues en français québécois");
  });

  it("avec une seconde langue, il bascule — mais n'OUVRE jamais avec", () => {
    const l3 = build({ language: "fr-CA", secondaryLanguage: "en-CA" });
    expect(l3).toContain("Si la personne écrit en anglais canadien");
    // On ne devine pas la langue de quelqu'un qui n'a encore rien écrit.
    expect(l3).toMatch(/PREMIER message reste en français québécois/);
  });

  it("une seconde langue identique à la principale est REFUSÉE", () => {
    const input = {
      name: "A",
      identity: {},
      goal: { primary: { type: "video_meeting" } },
      approach: {},
      model: {},
      language: "fr-CA",
      secondaryLanguage: "fr-CA",
    };
    // Un réglage sans effet, affiché comme s'il en avait un.
    expect(assistantConfigInputSchema.safeParse(input).success).toBe(false);
    expect(assistantConfigSchema.parse(input).secondaryLanguage).toBe("fr-CA");
  });
});
