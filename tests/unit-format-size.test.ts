/**
 * `formatSize` doit rendre la MÊME chaîne au serveur et au navigateur.
 *
 * L'ICU de Node met une espace ordinaire entre le nombre et l'unité, Chrome
 * une espace insécable : sans normalisation, la jauge de l'audio conservé
 * déclenchait une erreur d'hydratation (vue le 2026-09-13). Ce test tourne
 * sous Node — exactement là où l'espace ordinaire apparaît.
 */
import { describe, expect, it } from "vitest";
import { formatSize } from "@/components/analytics/format-size";

const NBSP = String.fromCharCode(0xa0);
const MB = 1024 * 1024;

describe("formatSize", () => {
  it("n'emploie que l'espace insécable — jamais l'espace ordinaire de l'ICU de Node", () => {
    const cases: Array<[number, string]> = [
      [1.3 * MB, "fr"],
      [200 * MB, "fr"],
      [0, "fr"],
      [1.3 * MB, "en"],
      [300 * 1024, "fr"],
      [50 * 1024, "en"],
    ];
    for (const [bytes, locale] of cases) {
      const out = formatSize(bytes, locale);
      expect(out, JSON.stringify(out)).not.toContain(" ");
      expect(out, JSON.stringify(out)).toContain(NBSP);
    }
  });

  it("écrit les mégaoctets dans la langue de l'interface", () => {
    expect(formatSize(1.3 * MB, "fr")).toBe(`1,3${NBSP}Mo`);
    expect(formatSize(200 * MB, "fr")).toBe(`200${NBSP}Mo`);
    expect(formatSize(0, "fr")).toBe(`0${NBSP}Mo`);
    expect(formatSize(1.3 * MB, "en")).toBe(`1.3${NBSP}MB`);
  });

  it("sous 0,1 Mo, compte en kilo-octets plutôt que d'afficher « 0 Mo »", () => {
    expect(formatSize(50 * 1024, "fr")).toBe(`50${NBSP}ko`);
    expect(formatSize(50 * 1024, "en")).toBe(`50${NBSP}kB`);
  });
});
