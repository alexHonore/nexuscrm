/**
 * Tests unitaires — analyse de segmentation SMS (src/lib/sms/segments.ts).
 *
 * Logique pure : aucune base de données, aucun réseau, aucun mock.
 */
import { describe, expect, it } from "vitest";

import { analyzeSms, lintSms } from "@/lib/sms/segments";

// ═══════════════════════════════════════════════════════════════════════════
// Détection d'encodage
// ═══════════════════════════════════════════════════════════════════════════

describe("analyzeSms — détection d'encodage", () => {
  it("« peut-être » est UCS-2 (ê hors GSM)", () => {
    expect(analyzeSms("peut-être").encoding).toBe("UCS-2");
  });

  it("« telephone » est GSM-7", () => {
    expect(analyzeSms("telephone").encoding).toBe("GSM-7");
  });

  it("« déjà réglé à Québec » est GSM-7 (é è à sont dans la table de base)", () => {
    const result = analyzeSms("déjà réglé à Québec");
    expect(result.encoding).toBe("GSM-7");
    expect(result.units).toBe(19);
  });

  it("« allô » est UCS-2 (ô hors GSM)", () => {
    expect(analyzeSms("allô").encoding).toBe("UCS-2");
  });

  it("ù ì ò de la table de base restent GSM-7", () => {
    expect(analyzeSms("où ìò").encoding).toBe("GSM-7");
  });

  it("un émoji force l'UCS-2", () => {
    expect(analyzeSms("ok 👍").encoding).toBe("UCS-2");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Segments GSM-7 : 160 seul, 153 par segment en multi
// ═══════════════════════════════════════════════════════════════════════════

describe("analyzeSms — segments GSM-7", () => {
  it.each([
    [160, 1, 160],
    [161, 2, 153],
    [306, 2, 153],
    [307, 3, 153],
  ])("%i caractères GSM → %i segment(s), perSegment %i", (length, segments, perSegment) => {
    const result = analyzeSms("a".repeat(length));
    expect(result).toEqual({ encoding: "GSM-7", units: length, segments, perSegment });
  });

  it("« {} » coûte 4 septets (caractères d'extension, 2 septets chacun)", () => {
    const result = analyzeSms("{}");
    expect(result.encoding).toBe("GSM-7");
    expect(result.units).toBe(4);
    expect(result.segments).toBe(1);
  });

  it("un € (2 septets) fait basculer un corps de 159 septets en 2 segments", () => {
    const base = "a".repeat(159);
    expect(analyzeSms(base)).toEqual({
      encoding: "GSM-7",
      units: 159,
      segments: 1,
      perSegment: 160,
    });
    expect(analyzeSms(base + "€")).toEqual({
      encoding: "GSM-7",
      units: 161,
      segments: 2,
      perSegment: 153,
    });
  });

  it("un € après 158 septets tient encore dans un seul segment (160 pile)", () => {
    const result = analyzeSms("a".repeat(158) + "€");
    expect(result.units).toBe(160);
    expect(result.segments).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Segments UCS-2 : 70 seul, 67 par segment en multi
// ═══════════════════════════════════════════════════════════════════════════

describe("analyzeSms — segments UCS-2", () => {
  it("70 caractères UCS-2 → 1 segment", () => {
    const result = analyzeSms("ô".repeat(70));
    expect(result).toEqual({ encoding: "UCS-2", units: 70, segments: 1, perSegment: 70 });
  });

  it("71 caractères UCS-2 → 2 segments", () => {
    const result = analyzeSms("ô".repeat(71));
    expect(result).toEqual({ encoding: "UCS-2", units: 71, segments: 2, perSegment: 67 });
  });

  it("un pouce levé (paire de substitution) compte 2 unités", () => {
    const result = analyzeSms("👍");
    expect(result.encoding).toBe("UCS-2");
    expect(result.units).toBe(2);
    expect(result.segments).toBe(1);
  });

  it("35 émojis (70 unités) tiennent en 1 segment, 36 débordent en 2", () => {
    expect(analyzeSms("👍".repeat(35)).segments).toBe(1);
    expect(analyzeSms("👍".repeat(36)).segments).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Corps vide
// ═══════════════════════════════════════════════════════════════════════════

describe("analyzeSms — corps vide", () => {
  it("chaîne vide → 0 segment, 0 unité, GSM-7", () => {
    expect(analyzeSms("")).toEqual({
      encoding: "GSM-7",
      units: 0,
      segments: 0,
      perSegment: 160,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// lintSms
// ═══════════════════════════════════════════════════════════════════════════

describe("lintSms", () => {
  it("un corps entièrement GSM ne produit aucun avertissement", () => {
    const result = lintSms("déjà réglé à Québec (2 unités) €");
    expect(result.encoding).toBe("GSM-7");
    expect(result.warnings).toEqual([]);
  });

  it("apostrophe courbe → suggestion ' ; lettre circonflexe → aucune suggestion", () => {
    const body = "C’est peut-être bon";
    const result = lintSms(body);
    expect(result.encoding).toBe("UCS-2");
    expect(result.warnings).toEqual([
      { char: "’", index: 1, suggestion: "'" },
      { char: "ê", index: 11 },
    ]);
  });

  it("déduplique par caractère et garde la première position", () => {
    const result = lintSms("ôô…ô…");
    expect(result.warnings).toEqual([{ char: "ô", index: 0 }, { char: "…", index: 2, suggestion: "..." }]);
  });

  it.each([
    ["guillemet ouvrant courbe", "“", '"'],
    ["guillemet fermant courbe", "”", '"'],
    ["guillemet français ouvrant", "«", '"'],
    ["guillemet français fermant", "»", '"'],
    ["tiret demi-cadratin", "–", "-"],
    ["tiret cadratin", "—", "-"],
    ["points de suspension", "…", "..."],
    ["espace insécable", " ", " "],
    ["espace fine insécable", " ", " "],
  ])("suggestion pour %s", (_label, char, suggestion) => {
    const result = lintSms(`a${char}b`);
    expect(result.warnings).toEqual([{ char, index: 1, suggestion }]);
  });

  it("un émoji est signalé sans suggestion", () => {
    const result = lintSms("Bonjour 👍");
    expect(result.warnings).toEqual([{ char: "👍", index: 8 }]);
  });

  it("rapporte l'encodage et le nombre de segments du corps analysé", () => {
    const result = lintSms("ô".repeat(71));
    expect(result.encoding).toBe("UCS-2");
    expect(result.segments).toBe(2);
  });
});
