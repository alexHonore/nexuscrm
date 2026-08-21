/**
 * Aides pures du BookingProvider (src/lib/booking/provider.ts) : le libellé
 * français d'un créneau et le calcul des prochains jours ouvrables. Aucune
 * dépendance à la base ni à Next.js — le test s'exécute directement.
 */
import { describe, expect, it } from "vitest";
import { formatSlotLabel, nextBusinessDays } from "@/lib/booking/provider";

const TZ = "America/Toronto";

describe("formatSlotLabel", () => {
  it("jeudi 14 h — pas de minutes affichées à :00", () => {
    // 13 août 2026, 18:00Z = 14:00 à Toronto (EDT, UTC-4).
    expect(formatSlotLabel(new Date("2026-08-13T18:00:00.000Z"), TZ)).toBe("jeudi 14 h");
  });

  it("vendredi 18 h 30 — minutes affichées quand non nulles", () => {
    // 14 août 2026, 22:30Z = 18:30 à Toronto (EDT, UTC-4).
    expect(formatSlotLabel(new Date("2026-08-14T22:30:00.000Z"), TZ)).toBe("vendredi 18 h 30");
  });

  it("garde le zéro des minutes à un chiffre (« 09 », pas « 9 »)", () => {
    // 13 août 2026, 18:05Z = 14:05 à Toronto.
    expect(formatSlotLabel(new Date("2026-08-13T18:05:00.000Z"), TZ)).toBe("jeudi 14 h 05");
  });

  it("traverse le passage à l'heure d'hiver (fin du DST, 1er nov. 2026) sans glisser de jour", () => {
    // Vendredi 30 oct. 2026, encore en EDT (UTC-4) : 14:00 local = 18:00Z.
    expect(formatSlotLabel(new Date("2026-10-30T18:00:00.000Z"), TZ)).toBe("vendredi 14 h");
    // Lundi 2 nov. 2026, déjà en EST (UTC-5) : 14:00 local = 19:00Z.
    // Même libellé « 14 h » qu'avant le changement d'heure, à partir d'un
    // décalage UTC DIFFÉRENT — la conversion se fait bien via le fuseau
    // cible, pas via un décalage fixe codé en dur.
    expect(formatSlotLabel(new Date("2026-11-02T19:00:00.000Z"), TZ)).toBe("lundi 14 h");
  });

  it("traverse le passage à l'heure d'été (début du DST, 8 mars 2026) sans glisser de jour", () => {
    // Lundi 2 mars 2026, encore en EST (UTC-5) : 14:00 local = 19:00Z.
    expect(formatSlotLabel(new Date("2026-03-02T19:00:00.000Z"), TZ)).toBe("lundi 14 h");
    // Lundi 9 mars 2026, déjà en EDT (UTC-4) : 14:00 local = 18:00Z.
    expect(formatSlotLabel(new Date("2026-03-09T18:00:00.000Z"), TZ)).toBe("lundi 14 h");
  });

  it("noms de jour stables et en minuscules pour toute la semaine (locale fr)", () => {
    // Lundi 10 août 2026 → dimanche 16 août 2026, tous à 10:00Z.
    const expected = [
      "lundi",
      "mardi",
      "mercredi",
      "jeudi",
      "vendredi",
      "samedi",
      "dimanche",
    ];
    const labels = Array.from({ length: 7 }, (_, i) =>
      formatSlotLabel(new Date(Date.UTC(2026, 7, 10 + i, 10, 0, 0)), TZ),
    );
    labels.forEach((label, i) => {
      expect(label.startsWith(expected[i])).toBe(true);
      expect(label).toBe(label.toLowerCase());
    });
  });

  it("respecte un autre fuseau horaire que Toronto", () => {
    // 13 août 2026, 18:00Z = 20:00 à Paris (CEST, UTC+2) — même instant que
    // le premier test, libellé différent selon le fuseau demandé.
    expect(formatSlotLabel(new Date("2026-08-13T18:00:00.000Z"), "Europe/Paris")).toBe("jeudi 20 h");
  });
});

describe("nextBusinessDays", () => {
  it("saute la fin de semaine à partir d'un vendredi", () => {
    // 14 août 2026 = vendredi.
    expect(nextBusinessDays("2026-08-14", 3)).toEqual(["2026-08-14", "2026-08-17", "2026-08-18"]);
  });

  it("part du prochain jour ouvrable quand fromIso tombe un samedi", () => {
    // 15 août 2026 = samedi.
    expect(nextBusinessDays("2026-08-15", 2)).toEqual(["2026-08-17", "2026-08-18"]);
  });

  it("part du prochain jour ouvrable quand fromIso tombe un dimanche", () => {
    // 16 août 2026 = dimanche.
    expect(nextBusinessDays("2026-08-16", 1)).toEqual(["2026-08-17"]);
  });

  it("accepte un ISO complet (pas seulement une date nue)", () => {
    expect(nextBusinessDays("2026-08-14T23:59:00.000Z", 1)).toEqual(["2026-08-14"]);
  });

  it("renvoie un tableau vide pour n <= 0 ou une date invalide", () => {
    expect(nextBusinessDays("2026-08-14", 0)).toEqual([]);
    expect(nextBusinessDays("2026-08-14", -1)).toEqual([]);
    expect(nextBusinessDays("n'importe quoi", 3)).toEqual([]);
  });
});
