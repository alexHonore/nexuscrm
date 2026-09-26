/**
 * Unitaire — recherche de clients : le CLASSEMENT (§4).
 *
 * Ce que ces tests protègent : les invariants qui rendent l'ordre prévisible
 * (un nom bat toujours un mot trouvé seulement dans l'historique ; un numéro
 * exact bat un nom), la règle « l'historique ne rapporte fraîcheur et
 * profondeur que s'il porte la fiche », et le fait que le barème en DONNÉES
 * (`scoreSpec`, dont le SQL est généré) donne le même entier que `scoreFeatures`.
 */
import { describe, expect, it } from "vitest";
import { planSearch } from "@/lib/clients-search/plan";
import { parseSearchQuery } from "@/lib/clients-search/query";
import {
  BONUS,
  emptyMasks,
  featuresFromRow,
  LEVELS,
  matchReasons,
  recencyCutoffs,
  scoreFeatures,
} from "@/lib/clients-search/score";
import {
  MASK_COLUMNS,
  type MaskColumn,
  type MatchFeatures,
  type MatchField,
  type ScoreSpec,
} from "@/lib/clients-search/types";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function features(termCount: number, masks: Partial<Record<MaskColumn, number>>, extra: Partial<MatchFeatures> = {}): MatchFeatures {
  return {
    termCount,
    masks: { ...emptyMasks(), ...masks },
    nameExact: false,
    namePhrase: false,
    nameStart: false,
    sameRecord: false,
    sameAddress: false,
    histAt: null,
    histN: 0,
    ...extra,
  };
}

const score = (f: MatchFeatures) => scoreFeatures(f, NOW).total;
const points = (column: MaskColumn) => LEVELS.find((r) => r.column === column)!.points;

describe("LEVELS", () => {
  it("une ligne par colonne-masque, aucune en double", () => {
    expect(LEVELS.map((r) => r.column).sort()).toEqual([...MASK_COLUMNS].sort());
  });

  it("I1 — dans chaque champ : entier > début > infixe > flou", () => {
    const order: Partial<Record<MatchField, MaskColumn[]>> = {
      name: ["name_x", "name_w", "name_i", "name_f"],
      city: ["city_x", "city_w", "city_i", "city_f"],
      // Le début du numéro (indicatif régional, seulement parmi d'autres
      // termes) est la preuve la plus faible : toute une région le partage.
      phone: ["ph_x", "ph_s", "ph_i", "ph_p"],
      email: ["em_x", "em_p", "em_i", "em_t"],
      address: ["addr_pc", "addr_m"],
    };
    for (const cols of Object.values(order)) {
      const pts = cols!.map(points);
      for (let k = 1; k < pts.length; k++) expect(pts[k - 1]).toBeGreaterThan(pts[k]);
    }
  });

  it("I3 — un numéro ou un courriel exact vaut au moins un nom entier", () => {
    expect(points("ph_x")).toBeGreaterThanOrEqual(points("name_x"));
    expect(points("em_x")).toBeGreaterThanOrEqual(points("name_x"));
  });
});

describe("invariants du score", () => {
  it("I2 — un infixe de nom bat le meilleur terme trouvé seulement dans l'historique", () => {
    const name = features(1, { name_i: 1 });
    const bestHistory = features(1, { com_m: 1 }, { histAt: NOW, histN: 50 });
    expect(score(bestHistory)).toBe(22 + 10 + 6);
    expect(score(name)).toBeGreaterThan(score(bestHistory));
  });

  it("I2 — deux infixes de nom battent les deux termes dans un même commentaire", () => {
    const names = features(2, { name_i: 3 });
    const comment = features(2, { com_m: 3 }, { sameRecord: true, histAt: NOW, histN: 50 });
    expect(score(names)).toBe(90);
    expect(score(comment)).toBe(22 + 22 + 20 + 10 + 6);
    expect(score(names)).toBeGreaterThan(score(comment));
  });

  it("I4 — un nom exact bat tout nom non exact à couverture égale", () => {
    for (const col of ["name_x", "name_w", "name_i"] as const) {
      const exact = features(1, { [col]: 1 }, { nameExact: true });
      for (const phrase of [false, true]) {
        for (const start of [false, true]) {
          const other = features(1, { name_x: 1, name_w: 1, name_i: 1 }, { namePhrase: phrase, nameStart: start });
          expect(score(exact) - points(col)).toBeGreaterThan(score(other) - points("name_x"));
        }
      }
    }
    expect(BONUS.nameExact).toBeGreaterThan(BONUS.namePhrase + BONUS.nameStart);
  });

  it("I5 — les parts s'additionnent au total (échantillon déterministe)", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 500; round++) {
      const k = 1 + rand(5);
      const masks: Partial<Record<MaskColumn, number>> = {};
      for (const c of MASK_COLUMNS) masks[c] = rand(3) === 0 ? rand(1 << k) : 0;
      const f = features(k, masks, {
        nameExact: rand(2) === 1,
        namePhrase: rand(2) === 1,
        nameStart: rand(2) === 1,
        sameRecord: rand(2) === 1,
        sameAddress: rand(2) === 1,
        histAt: rand(4) === 0 ? null : daysAgo(rand(400)),
        histN: rand(8),
      });
      const { total, parts } = scoreFeatures(f, NOW);
      expect(parts.reduce((s, p) => s + p.points, 0)).toBe(total);
      expect(parts.every((p) => p.points > 0)).toBe(true);
    }
  });

  describe("I6 — l'adresse qui contient TOUT, numéro civique compris", () => {
    /** k termes tous dans l'adresse (le premier est le numéro civique), bonus posé. */
    const resident = (k: number) => features(k, { addr_m: (1 << k) - 1 }, { sameAddress: true });

    it("bat les mêmes termes éparpillés : nom + indicatif régional + le reste dans l'adresse", () => {
      // « 418 rue tremblay » à Québec : chaque Tremblay au 418 qui habite « rue … ».
      for (let k = 2; k <= 5; k++) {
        const rest = ((1 << k) - 1) & ~0b11;
        const scattered = features(k, { ph_p: 1, name_x: 2, addr_m: rest });
        expect(score(resident(k)), `k=${k}`).toBeGreaterThan(score(scattered));
      }
    });

    it("bat un nom qui habite au même numéro, ailleurs (« Tremblay, 412 rue Laurier »)", () => {
      for (let k = 2; k <= 5; k++) {
        const elsewhere = features(k, { name_x: 2, addr_m: ((1 << k) - 1) & ~2 });
        expect(score(resident(k)), `k=${k}`).toBeGreaterThan(score(elsewhere));
      }
    });

    it("mais un nom et la FIN de son numéro (« tremblay 5551 ») passent devant le « 5551 rue Tremblay »", () => {
      const nameAndEnding = features(2, { name_x: 1, ph_s: 2 });
      expect(score(nameAndEnding)).toBeGreaterThan(score(resident(2)));
    });

    it("et un nom exact garde son rang : le bonus d'adresse reste sous celui du nom exact", () => {
      expect(BONUS.sameAddress).toBeLessThan(BONUS.nameExact);
      // À couverture égale (mêmes masques), les deux fiches ont le même bonus d'adresse : I4 tient.
      const exact = features(2, { name_x: 3, addr_m: 3 }, { nameExact: true, sameAddress: true });
      const other = features(2, { name_x: 3, addr_m: 3 }, { namePhrase: true, nameStart: true, sameAddress: true });
      expect(score(exact)).toBeGreaterThan(score(other));
    });

    it("jamais avec un seul terme", () => {
      expect(score(features(1, { addr_m: 1 }, { sameAddress: true }))).toBe(points("addr_m"));
    });
  });

  it("chaque terme compte une fois, dans son meilleur champ", () => {
    const f = features(1, { name_x: 1, name_w: 1, name_i: 1, com_m: 1, notes_m: 1 });
    expect(score(f)).toBe(100);
  });

  it("les bits au-delà de k (et les exclusions) ne comptent jamais", () => {
    expect(score(features(1, { name_x: 1 | 2 | 256 }))).toBe(100);
  });
});

describe("l'historique porte-t-il la fiche ?", () => {
  it("un terme trouvé seulement dans l'historique : fraîcheur et profondeur comptent", () => {
    const f = features(2, { name_x: 1, com_m: 2 }, { histAt: daysAgo(3), histN: 3 });
    expect(score(f)).toBe(100 + 22 + 10 + 4);
  });

  it("tous les termes aussi sur la fiche : ni fraîcheur ni profondeur", () => {
    const f = features(2, { name_x: 1, notes_m: 2, com_m: 3 }, { histAt: daysAgo(3), histN: 9 });
    expect(score(f)).toBe(100 + 25);
  });

  it.each([
    [3, 10],
    [29, 10],
    [31, 4],
    [179, 4],
    [181, 0],
  ])("fraîcheur : il y a %i jours → +%i", (days, bonus) => {
    const f = features(1, { com_m: 1 }, { histAt: daysAgo(days), histN: 1 });
    expect(score(f)).toBe(22 + bonus);
  });

  it("fraîcheur : une date ISO vaut une Date ; sans date, rien", () => {
    expect(score(features(1, { com_m: 1 }, { histAt: daysAgo(3).toISOString(), histN: 1 }))).toBe(32);
    expect(score(features(1, { com_m: 1 }, { histAt: null, histN: 1 }))).toBe(22);
  });

  it.each([
    [0, 0],
    [1, 0],
    [2, 2],
    [3, 4],
    [4, 6],
    [40, 6],
  ])("profondeur : %i traces → +%i", (n, bonus) => {
    expect(score(features(1, { fup_m: 1 }, { histN: n }))).toBe(18 + bonus);
  });

  it("recencyCutoffs : 30 et 180 jours de 24 h", () => {
    expect(recencyCutoffs(NOW).map((d) => d.toISOString())).toEqual([
      "2026-08-27T12:00:00.000Z",
      "2026-03-30T12:00:00.000Z",
    ]);
  });
});

describe("ordre de référence", () => {
  it("nom exact > début du nom > infixe du nom > ville > commentaire seul", () => {
    const exact = features(1, { name_x: 1, name_w: 1, name_i: 1 }, { nameExact: true, nameStart: true });
    const start = features(1, { name_w: 1, name_i: 1 }, { nameStart: true });
    const infix = features(1, { name_i: 1 });
    const city = features(1, { city_x: 1, city_w: 1, city_i: 1 });
    const comment = features(1, { com_m: 1 }, { histAt: NOW, histN: 20 });
    const ranked = [exact, start, infix, city, comment].map(score);
    expect(ranked).toEqual([...ranked].sort((a, b) => b - a));
    expect(new Set(ranked).size).toBe(ranked.length);
  });
});

describe("matchReasons", () => {
  it("le niveau gagnant de chaque terme, regroupé par champ, points décroissants", () => {
    const f = features(3, { name_x: 1, name_w: 1, name_i: 1 | 4, com_m: 2, notes_m: 2 });
    expect(matchReasons(f)).toEqual([
      { field: "name", level: "whole", terms: [0, 2] },
      { field: "notes", level: "match", terms: [1] },
    ]);
  });

  it("un numéro exact passe devant le nom", () => {
    const f = features(2, { name_i: 1, ph_x: 2, ph_i: 2 });
    expect(matchReasons(f)).toEqual([
      { field: "phone", level: "exact", terms: [1] },
      { field: "name", level: "infix", terms: [0] },
    ]);
  });

  it("un terme sans aucune colonne n'a pas de raison", () => {
    expect(matchReasons(features(2, { city_f: 2 }))).toEqual([{ field: "city", level: "fuzzy", terms: [1] }]);
  });
});

/**
 * Interprète le barème en données EXACTEMENT comme le SQL généré le ferait —
 * si `scoreSpec` et `scoreFeatures` divergent, le SQL divergera aussi.
 */
function scoreFromSpec(spec: ScoreSpec, f: MatchFeatures, now: Date): number {
  let total = 0;
  for (const t of spec.terms) {
    total += Math.max(0, ...t.columns.map((c) => ((f.masks[c.column] & t.bit) !== 0 ? c.points : 0)));
  }
  if (spec.nameExact !== null && f.nameExact) total += spec.nameExact;
  if (spec.namePhrase !== null && f.namePhrase) total += spec.namePhrase;
  if (spec.nameStart !== null && f.nameStart) total += spec.nameStart;
  if (spec.sameRecord !== null && f.sameRecord) total += spec.sameRecord;
  if (spec.sameAddress !== null && f.sameAddress) total += spec.sameAddress;
  const fiche = MASK_COLUMNS.filter((c) => !["com_m", "fup_m", "call_m", "sms_m"].includes(c)).reduce(
    (m, c) => m | f.masks[c],
    0,
  );
  const hist = f.masks.com_m | f.masks.fup_m | f.masks.call_m | f.masks.sms_m;
  if ((hist & spec.history.req & ~fiche) !== 0) {
    const at = f.histAt === null ? null : new Date(f.histAt).getTime();
    if (at !== null) {
      const tier = spec.history.recency.find((r) => at >= now.getTime() - r.days * 86_400_000);
      total += tier?.points ?? 0;
    }
    total += Math.min(spec.history.depthMax, spec.history.depthPer * Math.max(0, f.histN - 1));
  }
  return total;
}

describe("parité barème en données ↔ scoreFeatures", () => {
  it("même entier sur des lignes réalistes (masques restreints aux colonnes du plan)", () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const queries = [
      "jean tremblay",
      "piscine 5145551234",
      "marc -condo",
      "g1v 4m3 laval",
      "jean@x.com roy",
      "ab",
      "412 rue tremblay",
      "tremblay 5551",
    ];
    for (const q of queries) {
      const plan = planSearch(parseSearchQuery(q), { mode: "all", fuzzy: true });
      for (let round = 0; round < 200; round++) {
        const masks: Partial<Record<MaskColumn, number>> = {};
        for (const c of MASK_COLUMNS) {
          const bits = plan.columns[c].entries.map((e) => e.bit);
          masks[c] = bits.filter(() => rand(3) === 0).reduce((m, b) => m | b, 0);
        }
        const f = features(plan.termCount, masks, {
          nameExact: plan.exactName !== null && rand(3) === 0,
          namePhrase: plan.phraseName !== null && rand(3) === 0,
          nameStart: plan.startName !== null && rand(3) === 0,
          sameRecord: plan.termCount >= 2 && rand(3) === 0,
          // Le drapeau SQL n'existe que si le barème a le bonus (sinon `false` constant).
          sameAddress: plan.score.sameAddress !== null && rand(3) === 0,
          histAt: rand(5) === 0 ? null : daysAgo(rand(300)),
          histN: rand(6),
        });
        expect(scoreFromSpec(plan.score, f, NOW), q).toBe(scoreFeatures(f, NOW).total);
      }
    }
  });
});

describe("featuresFromRow", () => {
  it("relit les colonnes du statement (entiers en chaîne compris)", () => {
    const f = featuresFromRow(
      {
        name_x: "1",
        com_m: 2,
        ph_p: "2",
        name_exact: true,
        same_record: false,
        same_address: true,
        hist_at: "2026-09-01T00:00:00.000Z",
        hist_n: "3",
      },
      2,
    );
    expect(f.masks.name_x).toBe(1);
    expect(f.masks.com_m).toBe(2);
    expect(f.masks.ph_p).toBe(2);
    expect(f.masks.ph_x).toBe(0);
    expect(f).toMatchObject({ termCount: 2, nameExact: true, sameRecord: false, sameAddress: true, histN: 3 });
    expect(f.histAt).toBe("2026-09-01T00:00:00.000Z");
  });
});
