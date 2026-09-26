/**
 * Unitaire — recherche de clients : l'EXTRAIT (§5.3).
 *
 * Ce que ces tests protègent : l'identifiant d'un collègue mentionné ne sort
 * jamais dans un extrait ; l'en-tête d'une note IA n'est ni montré ni cherché ;
 * un extrait montré à qui n'a pas la case `contact` masque courriels et
 * numéros ; la fenêtre montre le passage qui explique la fiche, sans couper un
 * emoji ni une mention, et les intervalles tombent sur les bonnes lettres.
 */
import { describe, expect, it } from "vitest";
import { planSearch } from "@/lib/clients-search/plan";
import { contactKind, parseSearchQuery } from "@/lib/clients-search/query";
import { emptyMasks } from "@/lib/clients-search/score";
import {
  buildSnippet,
  coveredBits,
  highlightRanges,
  normalizeStoredBody,
  pickSnippetSource,
  REDACTED,
  redactContact,
  SNIPPET_SNAP,
  SNIPPET_WIDTH,
  type SnippetCandidate,
} from "@/lib/clients-search/snippet";

const UUID = "cafe0000-beef-4bad-8dad-0123456789ab";

/** Les motifs de surlignage d'un champ pour une requête. */
const patternsFor = (q: string, field: "comment" | "name" | "notes" = "comment") =>
  planSearch(parseSearchQuery(q), { mode: "all" }).highlight[field];

const marked = (text: string, ranges: [number, number][]) => ranges.map(([s, e]) => text.slice(s, e));

describe("normalizeStoredBody", () => {
  it("une mention devient @Nom et aucun uuid ne survit", () => {
    const n = normalizeStoredBody(`Rappeler avec @[Marie Tremblay](${UUID}) demain`);
    expect(n.text).toBe("Rappeler avec @Marie Tremblay demain");
    expect(n.text).not.toMatch(/cafe|[0-9a-f]{8}-/i);
    expect(marked(n.text, n.mentions)).toEqual(["@Marie Tremblay"]);
    expect(n.origin).toBe("human");
  });

  it("en-tête de note d'appel IA retiré (fr et en) → origine ai", () => {
    const fr = normalizeStoredBody(
      "🤖 Notes d'appel (IA) — appel sortant du 3 septembre 2026, 14 h 05 (4 min 12 s)\n\nLe client veut une piscine.",
    );
    expect(fr).toEqual({ text: "Le client veut une piscine.", origin: "ai", mentions: [] });
    const en = normalizeStoredBody("🤖 AI call notes — outbound call, September 3, 2026, 2:05 PM (4 min 12 s)\n\nWants a pool.");
    expect(en).toEqual({ text: "Wants a pool.", origin: "ai", mentions: [] });
  });

  it("en-tête de l'assistant SMS retiré → origine ai", () => {
    expect(normalizeStoredBody("🤖 Assistant « Léa » : Rappeler demain matin")).toEqual({
      text: "Rappeler demain matin",
      origin: "ai",
      mentions: [],
    });
  });

  it("un corps qui commence par 🤖 sans en-tête connu reste ai, texte intact", () => {
    expect(normalizeStoredBody("🤖 autre chose")).toMatchObject({ text: "🤖 autre chose", origin: "ai" });
  });

  it("journal de rendez-vous → origine booking, espaces resserrés", () => {
    const n = normalizeStoredBody("Rendez-vous fixé — Visio, jeudi 3 septembre\n\nProjet : Acheter\nBudget :  650 000 $");
    expect(n.origin).toBe("booking");
    expect(n.text).toBe("Rendez-vous fixé — Visio, jeudi 3 septembre Projet : Acheter Budget : 650 000 $");
    expect(normalizeStoredBody("Rendez-vous annulé — Visio").origin).toBe("booking");
  });
});

describe("redactContact", () => {
  it("masque courriels et suites de 7 chiffres ou plus, garde la ponctuation autour", () => {
    expect(redactContact("Courriel : (jean.roy@x.com), tél. 418 476-1542 ou +1 (418) 476-1542.")).toBe(
      `Courriel : (${REDACTED}), tél. ${REDACTED} ou ${REDACTED}.`,
    );
  });

  it("garde les nombres courts (prix, heures, 6 chiffres)", () => {
    expect(redactContact("Budget 650 000 $, à 14 h 05, code 123456")).toBe("Budget 650 000 $, à 14 h 05, code 123456");
  });

  it("garde les mentions alignées", () => {
    const n = normalizeStoredBody(`Tél 514 555 1234 puis @[Marie Roy](${UUID}) rappelle`);
    const r = redactContact(n);
    expect(r.text).toBe(`Tél ${REDACTED} puis @Marie Roy rappelle`);
    expect(marked(r.text, r.mentions)).toEqual(["@Marie Roy"]);
  });

  it("ce que l'extrait masque, un terme ne le cherche pas sur une fiche aux coordonnées fermées", () => {
    // Même texte tapé entre guillemets : `contactKind` doit le reconnaître,
    // sinon la recherche trouverait ce que l'extrait cache (« ••• »).
    for (const s of [
      "colette@exemple.com",
      "Courriel : yves.perso@mail.com",
      "418 555 3333",
      "418-555-2222",
      "418.555.2222",
      "+1 (418) 476-1542",
      "rappeler au 4185552222 demain",
      "1 250 000 $",
    ]) {
      expect(redactContact(s), s).toContain(REDACTED);
      const q = parseSearchQuery(`"${s}"`);
      const term = q.positive[0];
      expect(contactKind(term), s).toBe(true);
    }
  });
});

describe("highlightRanges", () => {
  it("les mêmes motifs que le SQL, sur le texte d'origine accentué", () => {
    const text = "Madame Hélène Côté, Trois-Rivières";
    const ranges = highlightRanges(text, patternsFor("helene cote rivieres", "name"));
    expect(marked(text, ranges)).toEqual(["Hélène", "Côté", "Rivières"]);
  });

  it("fusionne les intervalles qui se chevauchent ou se touchent", () => {
    expect(highlightRanges("abcdef", ["abc", "bcd", "ef"])).toEqual([[0, 6]]);
    expect(highlightRanges("abc xyz", ["ab", "bc", "yz"])).toEqual([
      [0, 3],
      [5, 7],
    ]);
  });

  it("texte vide ou motif invalide : rien", () => {
    expect(highlightRanges("", ["a"])).toEqual([]);
    expect(highlightRanges("abc", ["(?<"])).toEqual([]);
  });
});

describe("buildSnippet", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, k) => `mot${k}`).join(" ");

  it("un texte court est rendu entier", () => {
    const s = buildSnippet("Veut une piscine creusée.", patternsFor("piscine"));
    expect(s).toEqual({ text: "Veut une piscine creusée.", ranges: [[9, 16]], clippedStart: false, clippedEnd: false });
  });

  it("la fenêtre la plus dense gagne (termes DISTINCTS)", () => {
    const text = `${filler(10)} piscine ${filler(40)} garage et piscine ensemble ${filler(40)}`;
    const s = buildSnippet(text, patternsFor("piscine garage"));
    expect(marked(s.text, s.ranges)).toEqual(["garage", "piscine"]);
    expect(s.clippedStart).toBe(true);
    expect(s.clippedEnd).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(SNIPPET_WIDTH + 2 * SNIPPET_SNAP);
  });

  it("commence ~50 caractères avant le terme, recalé sur une espace", () => {
    const text = `${filler(60)} piscine ${filler(60)}`;
    const s = buildSnippet(text, patternsFor("piscine"));
    const at = s.text.indexOf("piscine");
    expect(at).toBeGreaterThan(30);
    expect(at).toBeLessThan(70);
    // Coupé sur une frontière de mot, des deux côtés.
    expect(text).toContain(` ${s.text} `);
  });

  it("ne coupe jamais une paire de substitution", () => {
    const emoji = "😀";
    const text = `${emoji.repeat(120)} piscine ${emoji.repeat(120)}`;
    const s = buildSnippet(text, patternsFor("piscine"));
    expect(s.text).not.toMatch(/^[\uDC00-\uDFFF]/);
    expect(s.text).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(marked(s.text, s.ranges)).toEqual(["piscine"]);
  });

  it("ne coupe jamais une mention @Nom", () => {
    const name = "Marie Josée Tremblay Laflamme de la Chevrotière Beauchemin Desrosiers Saint Onge";
    const body = `${filler(8)} @[${name}](${UUID}) piscine ${filler(60)}`;
    const n = normalizeStoredBody(body);
    // Sans protection, la fenêtre (~50 caractères avant « piscine ») commencerait DANS la mention…
    const naive = buildSnippet(n.text, patternsFor("piscine"));
    expect(naive.text.startsWith(`@${name}`)).toBe(false);
    expect(`@${name}`.includes(naive.text.split(" piscine")[0])).toBe(true);
    // …avec elle, la coupe sort de la mention : elle est entière.
    const s = buildSnippet(n.text, patternsFor("piscine"), { atomic: n.mentions });
    expect(s.text.startsWith(`@${name} piscine`)).toBe(true);
    expect(s.clippedStart).toBe(true);
    expect(marked(s.text, s.ranges)).toEqual(["piscine"]);
  });

  it("les intervalles tombent sur les lettres accentuées", () => {
    const text = `${filler(50)} Rencontre à Sainte-Foy avec Hélène ${filler(50)}`;
    const s = buildSnippet(text, patternsFor("st-foy helene"));
    expect(marked(s.text, s.ranges)).toEqual(["Sainte-Foy", "Hélène"]);
  });

  it("sans aucun terme trouvé : le début, sans intervalle", () => {
    const text = filler(80);
    const s = buildSnippet(text, patternsFor("piscine"));
    expect(s.ranges).toEqual([]);
    expect(s.clippedStart).toBe(false);
    expect(s.clippedEnd).toBe(true);
    expect(text.startsWith(s.text)).toBe(true);
    expect(s.text.length).toBeGreaterThan(SNIPPET_WIDTH - SNIPPET_SNAP - 1);
    expect(s.text.length).toBeLessThanOrEqual(SNIPPET_WIDTH + SNIPPET_SNAP);
  });

  it("un terme coupé par le bord est surligné jusqu'au bord", () => {
    const text = `${"x".repeat(300)}piscine`;
    const s = buildSnippet(text, ["x{3}piscine"]);
    expect(s.ranges[s.ranges.length - 1][1]).toBe(s.text.length);
  });
});

describe("pickSnippetSource", () => {
  const cand = (field: SnippetCandidate["field"], mask: number, at: string | null = null, text = "…") => ({
    field,
    mask,
    text,
    at,
  });

  it("d'abord les termes que la ligne ne montre pas encore", () => {
    const best = pickSnippetSource([cand("notes", 1 | 2), cand("comment", 4)], { req: 7, covered: 1 | 2 });
    expect(best?.field).toBe("comment");
  });

  it("puis le nombre de termes, puis les points du champ, puis la fraîcheur", () => {
    expect(pickSnippetSource([cand("comment", 2), cand("call", 2 | 4)], { req: 7, covered: 1 })?.field).toBe("call");
    expect(pickSnippetSource([cand("sms", 2), cand("notes", 2)], { req: 3, covered: 1 })?.field).toBe("notes");
    const recent = pickSnippetSource(
      [cand("comment", 2, "2026-01-01T00:00:00.000Z"), cand("comment", 2, "2026-09-01T00:00:00.000Z")],
      { req: 3, covered: 0 },
    );
    expect(recent?.at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("ignore les exclusions, les masques vides et les textes absents", () => {
    expect(pickSnippetSource([cand("comment", 256), cand("notes", 2, null, "")], { req: 3, covered: 0 })).toBeNull();
  });

  it("null quand la ligne dit déjà tout", () => {
    expect(pickSnippetSource([cand("comment", 1)], { req: 1, covered: 1 })).toBeNull();
  });

  it("coveredBits : nom, ville, et téléphone seulement si la case contact est ouverte", () => {
    const masks = { ...emptyMasks(), name_i: 1, city_x: 2, ph_s: 4, em_x: 8 };
    expect(coveredBits(masks, true)).toBe(7);
    expect(coveredBits(masks, false)).toBe(3);
    // L'indicatif (« marc 514 ») est montré par le numéro de la ligne, comme sa fin.
    expect(coveredBits({ ...emptyMasks(), name_x: 1, ph_p: 2 }, true)).toBe(3);
    expect(coveredBits({ ...emptyMasks(), name_x: 1, ph_p: 2 }, false)).toBe(1);
  });
});
