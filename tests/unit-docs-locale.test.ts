/**
 * Unitaire — la référence existe dans les DEUX langues.
 *
 * L'application est bilingue ; l'aide en ligne et la page de documentation en
 * sont la moitié la plus dense. Tant qu'elles n'existaient qu'en français, un
 * administrateur anglophone basculait la langue et retombait sur mille lignes
 * de français dès qu'il ouvrait une bulle d'aide.
 *
 * Le français est la SOURCE (il décide quels paramètres existent), l'anglais
 * une surcouche par clé — même règle que `messages/<locale>/*.json`. Ce test
 * fait échouer le build quand une fiche part sans traduction : c'est la seule
 * discipline qui tient dans le temps.
 *
 * Ce que ce test NE vérifie PAS, et c'est délibéré : la langue de
 * l'ASSISTANT. Elle vient de sa configuration, pas de l'écran — voir
 * `tests/unit-agent-locale.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { CAMPAIGN_FIELD_DOCS, campaignFieldText } from "@/lib/campaigns/docs";
import { CAMPAIGN_FIELD_TEXT_EN } from "@/lib/campaigns/docs.en";
import { paramDocText, resolveParamDoc } from "@/lib/docs/locale";
import { PARAM_DOCS } from "@/lib/docs/params";
import { PARAM_DOCS_EN } from "@/lib/docs/params.en";
import {
  FIXTURE_FIELD_DOCS,
  GUARDRAIL_KIND_DOCS,
  GUARDRAIL_SEVERITY_DOCS,
  RULE_PRESETS,
  fixtureText,
  kindText,
  presetText,
  severityText,
} from "@/lib/guardrails/docs";
import {
  FIXTURE_FIELD_TEXT_EN,
  GUARDRAIL_KIND_TEXT_EN,
  GUARDRAIL_SEVERITY_TEXT_EN,
  RULE_PRESET_TEXT_EN,
} from "@/lib/guardrails/docs.en";

/**
 * Un texte encore français, reconnu sans dictionnaire : les guillemets
 * français, et les mots-outils qui n'existent pas en anglais. « Québec »,
 * « Lévis » et « Alex-Honoré » restent évidemment permis.
 */
function looksFrench(text: string): boolean {
  if (/[«»]/.test(text)) return true;
  return /\b(le|la|les|une|des|du|aux|et|ou|pour|avec|sans|dans|sur|par|est|sont|pas|plus|vous|votre|nous|cette|qui|que|quand|aucun|aucune|tout|tous|ce|ça)\b/i.test(
    text,
  );
}

describe("référence des paramètres — parité fr/en", () => {
  it("CHAQUE fiche documentée a une traduction anglaise", () => {
    const missing = PARAM_DOCS.filter((d) => !PARAM_DOCS_EN[d.path]).map((d) => d.path);
    expect(
      missing,
      `Fiches sans traduction dans src/lib/docs/params.en.ts :\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("aucune traduction ne pointe vers un chemin disparu du registre", () => {
    const known = new Set(PARAM_DOCS.map((d) => d.path));
    const orphans = Object.keys(PARAM_DOCS_EN).filter((p) => !known.has(p));
    expect(orphans, `Traductions orphelines : ${orphans.join(", ")}`).toEqual([]);
  });

  it("la traduction porte les MÊMES champs que le français, ni plus ni moins", () => {
    for (const doc of PARAM_DOCS) {
      const en = PARAM_DOCS_EN[doc.path];
      if (!en) continue;
      expect(en.label.trim().length, doc.path).toBeGreaterThan(0);
      expect(en.what.trim().length, doc.path).toBeGreaterThan(20);
      expect(en.why.trim().length, doc.path).toBeGreaterThan(20);
      // Un « effet » ou un « piège » qui disparaît en anglais est une
      // information perdue, pas une traduction.
      expect(Boolean(en.effect), `${doc.path} — effect`).toBe(Boolean(doc.effectFr));
      expect(Boolean(en.pitfalls), `${doc.path} — pitfalls`).toBe(Boolean(doc.pitfallsFr));
      expect(Boolean(en.allowed), `${doc.path} — allowed`).toBe(Boolean(doc.allowed));
      if (doc.allowed) {
        expect(Object.keys(en.allowed ?? {}).sort(), `${doc.path} — valeurs permises`).toEqual(
          doc.allowed.map((a) => String(a.value)).sort(),
        );
      }
    }
  });

  it("le texte anglais est en ANGLAIS", () => {
    const french: string[] = [];
    for (const doc of PARAM_DOCS) {
      const text = paramDocText(doc, "en");
      for (const [field, value] of Object.entries({
        label: text.label,
        what: text.what,
        why: text.why,
        effect: text.effect ?? "",
        pitfalls: text.pitfalls ?? "",
        ...Object.fromEntries(Object.entries(text.allowed ?? {}).map(([k, v]) => [`allowed.${k}`, v])),
      })) {
        if (value && looksFrench(value)) french.push(`${doc.path}.${field}`);
      }
    }
    expect(french, `Texte encore français :\n  ${french.join("\n  ")}`).toEqual([]);
  });

  it("le français reste la source : le registre fr est rendu tel quel", () => {
    for (const doc of PARAM_DOCS.slice(0, 12)) {
      const fr = resolveParamDoc(doc, "fr");
      expect(fr.label).toBe(doc.labelFr);
      expect(fr.what).toBe(doc.whatFr);
      expect(fr.why).toBe(doc.whyFr);
    }
  });

  it("une traduction manquante RETOMBE sur le français plutôt que sur du vide", () => {
    const orphan = { ...PARAM_DOCS[0], path: "chemin.sans.traduction" };
    const text = paramDocText(orphan, "en");
    expect(text.label).toBe(orphan.labelFr);
    expect(text.what).toBe(orphan.whatFr);
  });
});

describe("garde-fous — parité fr/en", () => {
  it("chaque type de règle est traduit, en entier", () => {
    for (const doc of Object.values(GUARDRAIL_KIND_DOCS)) {
      const en = GUARDRAIL_KIND_TEXT_EN[doc.kind];
      expect(en, `type « ${doc.kind} » non traduit`).toBeDefined();
      const text = kindText(doc, "en");
      for (const [field, value] of Object.entries(text)) {
        expect(value.trim().length, `${doc.kind}.${field}`).toBeGreaterThan(0);
        expect(looksFrench(value), `${doc.kind}.${field} est encore en français`).toBe(false);
      }
    }
  });

  it("chaque sévérité est traduite", () => {
    for (const doc of Object.values(GUARDRAIL_SEVERITY_DOCS)) {
      expect(GUARDRAIL_SEVERITY_TEXT_EN[doc.severity], doc.severity).toBeDefined();
      const text = severityText(doc, "en");
      expect(looksFrench(text.label), `${doc.severity}.label`).toBe(false);
      expect(looksFrench(text.what), `${doc.severity}.what`).toBe(false);
    }
  });

  it("chaque champ de fixture est traduit", () => {
    for (const doc of FIXTURE_FIELD_DOCS) {
      expect(FIXTURE_FIELD_TEXT_EN[doc.key], doc.key).toBeDefined();
      const text = fixtureText(doc, "en");
      for (const [field, value] of Object.entries(text)) {
        // L'exemple cite un message de client — il peut rester tel quel s'il
        // est déjà en anglais ; il doit au moins exister.
        expect(value.trim().length, `${doc.key}.${field}`).toBeGreaterThan(0);
      }
      expect(looksFrench(text.label), `${doc.key}.label`).toBe(false);
      expect(looksFrench(text.what), `${doc.key}.what`).toBe(false);
      expect(looksFrench(text.pitfall), `${doc.key}.pitfall`).toBe(false);
    }
  });

  it("chaque préréglage a un libellé traduit — mais PAS son promptText", () => {
    for (const preset of RULE_PRESETS) {
      expect(RULE_PRESET_TEXT_EN[preset.key], preset.key).toBeDefined();
      const text = presetText(preset, "en");
      expect(looksFrench(text.label), `${preset.key}.label`).toBe(false);
      expect(looksFrench(text.what), `${preset.key}.what`).toBe(false);
    }
    // Le texte injecté dans le prompt appartient à l'ASSISTANT : il est écrit
    // dans SA langue, pas dans celle de l'écran. Le traduire ferait écrire
    // l'assistant en anglais à des clients québécois.
    const serialized = JSON.stringify({
      kinds: GUARDRAIL_KIND_TEXT_EN,
      severities: GUARDRAIL_SEVERITY_TEXT_EN,
      fixtures: FIXTURE_FIELD_TEXT_EN,
      presets: RULE_PRESET_TEXT_EN,
    });
    for (const preset of RULE_PRESETS) {
      if (preset.promptText) expect(serialized).not.toContain(preset.promptText);
    }
  });
});

describe("champs de campagne — parité fr/en", () => {
  it("chaque champ est traduit, avec les mêmes champs facultatifs", () => {
    for (const doc of CAMPAIGN_FIELD_DOCS) {
      const en = CAMPAIGN_FIELD_TEXT_EN[doc.path];
      expect(en, `champ « ${doc.path} » non traduit`).toBeDefined();
      if (!en) continue;
      expect(Boolean(en.pitfalls), `${doc.path} — pitfalls`).toBe(Boolean(doc.pitfallsFr));
      const text = campaignFieldText(doc, "en");
      expect(looksFrench(text.label), `${doc.path}.label`).toBe(false);
      expect(looksFrench(text.what), `${doc.path}.what`).toBe(false);
      expect(looksFrench(text.why), `${doc.path}.why`).toBe(false);
    }
  });

  it("aucune traduction orpheline", () => {
    const known = new Set(CAMPAIGN_FIELD_DOCS.map((d) => d.path));
    const orphans = Object.keys(CAMPAIGN_FIELD_TEXT_EN).filter((p) => !known.has(p));
    expect(orphans, `Traductions orphelines : ${orphans.join(", ")}`).toEqual([]);
  });
});
