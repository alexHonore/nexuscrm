/**
 * Tests unitaires — budget de segments (src/lib/sms/budget.ts).
 *
 * La régression que ce fichier ferme : un réglage « économique » qui coûte
 * PLUS cher. Deux pièges concrets, tous les deux déjà possibles avec une
 * implémentation naïve — remplacer « … » par « ... » sur un texte qui reste
 * accentué RALLONGE le message (une unité UTF-16 contre trois), et retirer
 * les accents d'un texte qui tenait déjà dans son segment abîme l'orthographe
 * sans rien économiser. Ici, une retouche n'est gardée que si elle fait
 * tomber un segment.
 *
 * Le reste pin la coupe : jamais au milieu d'un mot, jamais au milieu d'une
 * paire de substitution, et toujours dans le budget demandé.
 *
 * Logique pure : aucune base de données, aucun réseau, aucun mock.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEGMENT_BUDGET,
  applyEconomy,
  applySegmentBudget,
  charBudgetFor,
  normalizeTypography,
  segmentBudgetSettingsSchema,
  toGsm7,
  trimToSegments,
  type SegmentBudget,
} from "@/lib/sms/budget";
import { analyzeSms, capacityFor, segmentsForChars } from "@/lib/sms/segments";

const budget = (over: Partial<SegmentBudget> = {}): SegmentBudget => ({
  ...DEFAULT_SEGMENT_BUDGET,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// Le défaut ne change RIEN
// ═══════════════════════════════════════════════════════════════════════════

describe("budget par défaut", () => {
  it("une fiche enregistrée avant ce réglage rend le budget inerte", () => {
    // `approach` est du jsonb relu à chaque lecture : le défaut posé dans le
    // schéma est celui que TOUTE la flotte adopte. Il doit être le
    // comportement d'avant, au caractère près.
    expect(segmentBudgetSettingsSchema.parse({})).toEqual(DEFAULT_SEGMENT_BUDGET);
    expect(DEFAULT_SEGMENT_BUDGET.maxSegments).toBeNull();
    expect(DEFAULT_SEGMENT_BUDGET.economy).toBe("off");
  });

  it("sans plafond, le texte part exactement tel quel", () => {
    const body = "Bonjour ! C'est Alex — êtes-vous toujours intéressé ? 👍";
    const outcome = applySegmentBudget(body, DEFAULT_SEGMENT_BUDGET);
    expect(outcome.body).toBe(body);
    expect(outcome.applied).toEqual([]);
    expect(outcome.overflow).toBe(false);
  });

  it("sans plafond, aucun budget de caractères n'est annoncé au modèle", () => {
    expect(charBudgetFor(DEFAULT_SEGMENT_BUDGET)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Le nombre écrit dans le prompt
// ═══════════════════════════════════════════════════════════════════════════

describe("charBudgetFor", () => {
  it.each([
    [1, 70],
    [2, 134],
    [3, 201],
    [4, 268],
  ])("%i segment(s) sans économie d'accents → %i caractères", (maxSegments, chars) => {
    // Le français accentué est UCS-2 : présumer le GSM-7 donnerait un budget
    // deux fois trop généreux, que le premier « ç » ferait exploser.
    expect(charBudgetFor(budget({ maxSegments }))).toBe(chars);
  });

  it.each([
    [1, 160],
    [2, 306],
  ])("%i segment(s) en mode sans accents → %i caractères", (maxSegments, chars) => {
    expect(charBudgetFor(budget({ maxSegments, economy: "ascii" }))).toBe(chars);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Économie de caractères
// ═══════════════════════════════════════════════════════════════════════════

describe("normalizeTypography", () => {
  it("redresse apostrophes, guillemets, tirets et points de suspension", () => {
    expect(normalizeTypography("l’offre « ferme » — oui…")).toBe(`l'offre " ferme " - oui...`);
  });

  it("ne touche pas aux lettres accentuées : elles n'ont pas d'équivalent fidèle", () => {
    expect(normalizeTypography("peut-être ça")).toBe("peut-être ça");
  });
});

describe("toGsm7", () => {
  it("retire les accents que la table GSM n'a pas, garde ceux qu'elle a", () => {
    // à è é ù ì ò sont DANS la table GSM : les retirer serait une perte
    // gratuite. ê â ç minuscule n'y sont pas.
    expect(toGsm7("ça déjà être où août")).toBe("ca déjà etre où aout");
  });

  it("épelle « œ », que la décomposition Unicode ne sait pas séparer", () => {
    expect(toGsm7("un vœu")).toBe("un voeu");
  });

  it("supprime un émoji sans laisser de double espace ni de demi-caractère", () => {
    const out = toGsm7("super 👍 merci");
    expect(out).toBe("super merci");
    expect(analyzeSms(out).encoding).toBe("GSM-7");
  });

  it("rend un texte qui tient VRAIMENT dans la table GSM", () => {
    expect(analyzeSms(toGsm7("Bonjour ! C’est Alex — êtes-vous prêt ? 🙂")).encoding).toBe("GSM-7");
  });
});

describe("applyEconomy — une retouche n'est gardée que si elle PAIE", () => {
  it("ne remplace pas « … » par « ... » quand le texte reste accentué", () => {
    // Le piège : en UCS-2 « … » vaut une unité et « ... » en vaut trois. Le
    // « nettoyage » rallongerait le message qu'il prétend raccourcir.
    const body = `Peut-être… je vérifie mon agenda et je vous reviens là-dessus, promis ${"a".repeat(50)}`;
    expect(analyzeSms(body).encoding).toBe("UCS-2");
    expect(applyEconomy(body, "typography").body).toBe(body);
    expect(applyEconomy(body, "typography").step).toBeNull();
  });

  it("redresse la ponctuation quand ça fait basculer le message en GSM-7", () => {
    const body = `C${"’"}est noté, je vous rappelle demain matin ${"a".repeat(90)}`;
    expect(analyzeSms(body).segments).toBeGreaterThan(1);
    const out = applyEconomy(body, "typography");
    expect(out.step).toBe("typography");
    expect(analyzeSms(out.body).encoding).toBe("GSM-7");
    expect(analyzeSms(out.body).segments).toBe(1);
  });

  it("garde les accents d'un message court qui tenait déjà", () => {
    // Retirer les accents ici n'économiserait aucun segment : ce serait un
    // sacrifice d'orthographe gratuit.
    const body = "ça vous irait mardi ?";
    expect(analyzeSms(body).segments).toBe(1);
    expect(applyEconomy(body, "ascii")).toEqual({ body, step: null });
  });

  it("retire les accents quand ils coûtent vraiment un segment", () => {
    const body = `ça vous irait mardi après-midi ? ${"a".repeat(100)}`;
    expect(analyzeSms(body).segments).toBe(2);
    const out = applyEconomy(body, "ascii");
    expect(out.step).toBe("ascii");
    expect(analyzeSms(out.body).segments).toBe(1);
  });

  it("« off » ne touche à rien, jamais", () => {
    const body = "l’offre… ça";
    expect(applyEconomy(body, "off")).toEqual({ body, step: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// La coupe
// ═══════════════════════════════════════════════════════════════════════════

describe("trimToSegments", () => {
  it("un message déjà dans son budget revient intact", () => {
    const body = "Parfait, je vous envoie la confirmation.";
    expect(trimToSegments(body, 2)).toBe(body);
  });

  it("coupe sur une fin de phrase quand il y en a une assez loin", () => {
    const body =
      "Bonjour Marie, ici Alex de Groupe Nexus. Je vous rappelle au sujet de votre projet. " +
      "Auriez-vous une trentaine de minutes cette semaine pour en parler tranquillement ?";
    const out = trimToSegments(body, 1);
    expect(out.endsWith(".")).toBe(true);
    expect(analyzeSms(out).segments).toBeLessThanOrEqual(1);
  });

  it("ne coupe JAMAIS au milieu d'un mot quand une frontière existe", () => {
    const body = `${"mot ".repeat(80)}fin`;
    const out = trimToSegments(body, 1);
    expect(out.endsWith("mot")).toBe(true);
    expect(analyzeSms(out).segments).toBeLessThanOrEqual(1);
  });

  it("ne coupe pas une paire de substitution en deux", () => {
    const out = trimToSegments("👍".repeat(60), 1);
    // 35 émojis = 70 unités = un segment ; le 36e ferait deux.
    expect([...out].length).toBe(35);
    expect(out.includes("�")).toBe(false);
    expect(analyzeSms(out).segments).toBe(1);
  });

  it.each([1, 2, 3])("tient toujours dans %i segment(s)", (max) => {
    const body =
      "Bonjour ! Ici Alex-Honoré, courtier immobilier à Québec. Vous avez rempli une demande " +
      "d'évaluation la semaine dernière — est-ce toujours d'actualité pour vous ? Je peux " +
      "passer jeudi après-midi ou vendredi matin, ça vous irait ?";
    expect(analyzeSms(trimToSegments(body, max)).segments).toBeLessThanOrEqual(max);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// La fonction que le moteur appelle
// ═══════════════════════════════════════════════════════════════════════════

describe("applySegmentBudget", () => {
  it("signale le dépassement sans jamais couper de lui-même", () => {
    // La coupe appartient au moteur, qui doit d'abord pouvoir demander une
    // réécriture : ici, on constate et on ne touche pas au texte.
    const body = "ça vous irait mardi ? ".repeat(10);
    const outcome = applySegmentBudget(body, budget({ maxSegments: 2 }));
    expect(outcome.overflow).toBe(true);
    expect(outcome.body).toBe(body);
    expect(outcome.after.segments).toBe(outcome.before.segments);
  });

  it("l'économie peut suffire à rentrer dans le budget", () => {
    const body = `ça vous irait mardi après-midi ? ${"a".repeat(100)}`;
    const outcome = applySegmentBudget(body, budget({ maxSegments: 1, economy: "ascii" }));
    expect(outcome.applied).toEqual(["ascii"]);
    expect(outcome.before.segments).toBe(2);
    expect(outcome.after.segments).toBe(1);
    expect(outcome.overflow).toBe(false);
  });

  it("un plafond absent ne déclare jamais de dépassement, si long soit le message", () => {
    const outcome = applySegmentBudget("ô".repeat(500), DEFAULT_SEGMENT_BUDGET);
    expect(outcome.overflow).toBe(false);
    expect(outcome.after.segments).toBeGreaterThan(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Réciprocité avec l'analyseur — un seul GSM 03.38 dans ce dépôt
// ═══════════════════════════════════════════════════════════════════════════

describe("capacityFor / segmentsForChars", () => {
  it("la capacité annoncée est celle qu'un message de cette taille consomme", () => {
    for (const segments of [1, 2, 3, 4]) {
      const gsm = capacityFor("GSM-7", segments);
      expect(analyzeSms("a".repeat(gsm)).segments).toBe(segments);
      expect(analyzeSms("a".repeat(gsm + 1)).segments).toBe(segments + 1);
      const ucs2 = capacityFor("UCS-2", segments);
      expect(analyzeSms("ô".repeat(ucs2)).segments).toBe(segments);
      expect(analyzeSms("ô".repeat(ucs2 + 1)).segments).toBe(segments + 1);
    }
  });

  it("300 caractères coûtent 2 segments sans accents et 5 avec", () => {
    // Le chiffre qui justifie tout ce module : la longueur maximale par
    // défaut (300) n'est pas un budget.
    expect(segmentsForChars(300, "GSM-7")).toBe(2);
    expect(segmentsForChars(300, "UCS-2")).toBe(5);
  });
});
