/**
 * Unitaire — recherche de clients : le PLAN (§2.4).
 *
 * Ce que ces tests protègent : la matrice nature × champ, l'intersection avec
 * les opérateurs et le mode, et les bits qui en sortent. Le builder SQL ne
 * redérive rien : si un terme de coordonnées perdait son bit dans
 * `contactBits`, une fiche au téléphone masqué redeviendrait trouvable par
 * son numéro.
 */
import { describe, expect, it } from "vitest";
import { GROUP_COLUMNS, planSearch, regexStrings, searchMetaBase } from "@/lib/clients-search/plan";
import { parseSearchQuery } from "@/lib/clients-search/query";
import { BONUS } from "@/lib/clients-search/score";
import { MASK_COLUMNS, type MaskColumn, type SearchMode, type SearchPlan } from "@/lib/clients-search/types";

const plan = (q: string, mode: SearchMode = "all", fuzzy = false) => planSearch(parseSearchQuery(q), { mode, fuzzy });

/** Les colonnes d'un terme, triées pour comparer sans dépendre de l'ordre. */
const cols = (p: SearchPlan, term = 0) => [...p.terms[term].columns].sort();
const sorted = (xs: MaskColumn[]) => [...xs].sort();

const HISTORY: MaskColumn[] = ["com_m", "fup_m", "call_m", "sms_m"];

describe("matrice §2.4 — mode all", () => {
  it("texte de 3 lettres et plus", () => {
    expect(cols(plan("tremblay"))).toEqual(
      sorted([
        "name_i", "name_w", "name_x", "city_i", "city_w", "city_x",
        "addr_m", "notes_m", "proj_m", "em_t", ...HISTORY,
      ]),
    );
  });

  it("…plus name_f / city_f en relance floue", () => {
    expect(cols(plan("trembly", "all", true))).toEqual(
      sorted([
        "name_i", "name_w", "name_x", "name_f", "city_i", "city_w", "city_x", "city_f",
        "addr_m", "notes_m", "proj_m", "em_t", ...HISTORY,
      ]),
    );
  });

  it("expression : comme le texte long, sans em_t (elle contient une espace)", () => {
    expect(cols(plan('"trois rivieres"'))).toEqual(
      sorted([
        "name_i", "name_w", "name_x", "city_i", "city_w", "city_x",
        "addr_m", "notes_m", "proj_m", ...HISTORY,
      ]),
    );
  });

  it("texte de 1–2 lettres : début de mot / mot entier, jamais les notes ni l'historique", () => {
    const p = plan("ab");
    expect(cols(p)).toEqual(sorted(["name_w", "name_x", "city_w", "city_x", "addr_m", "proj_m"]));
    expect(p.columns.addr_m.entries[0]).toMatchObject({ op: "regex", pattern: p.columns.name_w.entries[0].op === "regex" ? p.columns.name_w.entries[0].pattern : "" });
    expect(p.deepBits).toBe(0);
    expect(p.shortOnly).toBe(true);
  });

  it("chiffres : nom (motif chiffres), adresse, notes, projet, téléphone, historique", () => {
    expect(cols(plan("514"))).toEqual(sorted(["name_i", "addr_m", "notes_m", "proj_m", "ph_i", ...HISTORY]));
    expect(cols(plan("4761542"))).toEqual(
      sorted(["name_i", "addr_m", "notes_m", "proj_m", "ph_s", "ph_i", ...HISTORY]),
    );
    expect(cols(plan("4184761542"))).toEqual(
      sorted(["name_i", "addr_m", "notes_m", "proj_m", "ph_x", "ph_i", ...HISTORY]),
    );
  });

  it("chiffres : les tests du téléphone", () => {
    const p = plan("4761542");
    expect(p.columns.ph_s.entries).toEqual([{ op: "right-eq", value: "4761542", length: 7, bit: 1, term: 0 }]);
    expect(p.columns.ph_i.entries).toEqual([{ op: "like", pattern: "%4761542%", bit: 1, term: 0 }]);
    expect(p.columns.ph_x.entries).toEqual([]);
    const x = plan("(418) 476-1542");
    expect(x.columns.ph_x.entries).toEqual([{ op: "right-eq", value: "4184761542", length: 10, bit: 1, term: 0 }]);
    expect(x.columns.ph_s.entries).toEqual([]);
    expect(plan("3361234567890").columns.ph_x.entries[0]).toMatchObject({ op: "right-eq", length: 13 });
  });

  it("3–6 chiffres PARMI d'autres termes : ni l'infixe du numéro, mais son début (indicatif) et sa fin", () => {
    // « 412 rue tremblay » : 412 est un numéro civique, pas « un numéro qui
    // contient 412 quelque part » (1 numéro sur 125).
    const civic = plan("412 rue tremblay");
    expect(cols(civic)).toEqual(sorted(["name_i", "addr_m", "notes_m", "proj_m", "ph_p", ...HISTORY]));
    expect(civic.columns.ph_p.entries).toEqual([{ op: "like", pattern: "+1412%", bit: 1, term: 0 }]);
    expect(civic.columns.ph_i.entries).toEqual([]);
    // « marc 514 » : l'indicatif régional.
    expect(plan("marc 514").columns.ph_p.entries).toEqual([{ op: "like", pattern: "+1514%", bit: 2, term: 1 }]);
    // « tremblay 5551 » : la fin du numéro reste le test fort.
    const ending = plan("tremblay 5551");
    expect(cols(ending, 1)).toEqual(sorted(["name_i", "addr_m", "notes_m", "proj_m", "ph_s", "ph_p", ...HISTORY]));
    expect(ending.columns.ph_s.entries).toEqual([{ op: "right-eq", value: "5551", length: 4, bit: 2, term: 1 }]);
    // « tremblay 418 555 » : indicatif + central, le DÉBUT du numéro.
    expect(plan("tremblay 418 555").columns.ph_p.entries[0]).toMatchObject({ pattern: "+1418555%" });
  });

  it("…seul, ou avec tel:, ou de 7 chiffres et plus : l'infixe reste", () => {
    expect(plan("418").columns.ph_i.entries).toEqual([{ op: "like", pattern: "%418%", bit: 1, term: 0 }]);
    expect(plan("418").columns.ph_p.entries).toEqual([]);
    // Une exclusion ne compte pas : « 412 -condo » a UN terme.
    expect(cols(plan("412 -condo"))).toContain("ph_i");
    expect(cols(plan("tremblay tel:412"), 1)).toEqual(["ph_i"]);
    expect(cols(plan("tremblay 4761542"), 1)).toEqual(
      sorted(["name_i", "addr_m", "notes_m", "proj_m", "ph_s", "ph_i", ...HISTORY]),
    );
    // Une exclusion garde sa colonne la plus large.
    expect(cols(plan("tremblay -412"), 1)).toContain("ph_i");
    // Le mode identity suit la même règle (dialogue de campagne).
    expect(cols(plan("marc 514", "identity"), 1)).toEqual(sorted(["name_i", "ph_p"]));
  });

  it("courriel : notes, les trois tests du champ courriel, historique", () => {
    const p = plan("jean_t@x.com");
    expect(cols(p)).toEqual(sorted(["notes_m", "em_x", "em_p", "em_i", ...HISTORY]));
    expect(p.columns.em_x.entries).toEqual([{ op: "eq", value: "jean_t@x.com", bit: 1, term: 0 }]);
    expect(p.columns.em_p.entries[0]).toMatchObject({ op: "like", pattern: "jean\\_t@x.com%" });
    expect(p.columns.em_i.entries[0]).toMatchObject({ op: "like", pattern: "%jean\\_t@x.com%" });
    expect(p.columns.notes_m.entries[0]).toMatchObject({ op: "regex", pattern: "jean_t@x\\.com" });
  });

  it("code postal : addr_pc, notes, historique", () => {
    expect(cols(plan("G1V 4M3"))).toEqual(sorted(["addr_pc", "notes_m", ...HISTORY]));
  });

  it("em_t : LIKE échappé sur le texte plié", () => {
    expect(plan("50%_x").columns.em_t.entries[0]).toMatchObject({ op: "like", pattern: "%50\\%\\_x%" });
  });
});

describe("matrice §2.4 — mode identity (dialogue de campagne)", () => {
  it("nom, ville, téléphone, courriel seulement", () => {
    expect(cols(plan("tremblay", "identity"))).toEqual(
      sorted(["name_i", "name_w", "name_x", "city_i", "city_w", "city_x", "em_t"]),
    );
    expect(cols(plan("4761542", "identity"))).toEqual(sorted(["name_i", "ph_s", "ph_i"]));
    expect(cols(plan("jean@x.com", "identity"))).toEqual(sorted(["em_x", "em_p", "em_i"]));
  });

  it("un code postal n'a rien à chercher : mis de côté", () => {
    const p = plan("G1V 4M3", "identity");
    expect(p.terms).toEqual([]);
    expect(p.ignored).toEqual(["G1V 4M3"]);
  });

  it("jamais d'historique, jamais de flou, jamais de portée", () => {
    const p = plan("trembly dans:notes", "identity", true);
    expect(p.deepBits).toBe(0);
    expect(p.deepAny).toBeNull();
    expect(p.fuzzy).toBe(false);
    expect(p.fuzzyEligible).toBe(false);
    expect(p.columns.name_f.entries).toEqual([]);
    expect(p.scope).toBeNull();
    expect(p.scopeColumns).toBeNull();
  });
});

describe("opérateurs : intersection avec la matrice", () => {
  it("ville:laval → la ville seule", () => {
    expect(cols(plan("ville:laval"))).toEqual(sorted(["city_i", "city_w", "city_x"]));
  });

  it("tel:514 → le téléphone seul", () => {
    expect(cols(plan("tel:514"))).toEqual(["ph_i"]);
  });

  it("nom:514 → le motif chiffres sur le nom seul", () => {
    expect(cols(plan("nom:514"))).toEqual(["name_i"]);
  });

  it("courriel:gmail → em_t seul", () => {
    expect(cols(plan("courriel:gmail"))).toEqual(["em_t"]);
  });

  it("note:piscine → notes de la fiche et tout l'historique", () => {
    expect(cols(plan("note:piscine"))).toEqual(sorted(["notes_m", ...HISTORY]));
  });

  it("commentaire: / sms: → une seule source d'historique", () => {
    expect(cols(plan("commentaire:piscine"))).toEqual(["com_m"]);
    expect(cols(plan("texto:piscine"))).toEqual(["sms_m"]);
  });

  it("intersection vide → mis de côté, sans consommer de bit", () => {
    const p = plan("tel:tremblay laval note:ab");
    expect(p.ignored).toEqual(["tel:tremblay", "note:ab"]);
    expect(p.positive.map((t) => [t.value, t.bit])).toEqual([["laval", 1]]);
    expect(p.req).toBe(1);
  });

  it("note:piscine en identity → rien à chercher", () => {
    const p = plan("note:piscine", "identity");
    expect(p.termCount).toBe(0);
    expect(p.ignored).toEqual(["note:piscine"]);
  });
});

describe("bits", () => {
  it("une exclusion ne garde que la colonne la plus large de chaque champ", () => {
    expect(cols(plan("maison -tremblay"), 1)).toEqual(
      sorted(["name_i", "city_i", "addr_m", "notes_m", "proj_m", "em_t", ...HISTORY]),
    );
    expect(cols(plan("maison -4184761542"), 1)).toEqual(
      sorted(["name_i", "addr_m", "notes_m", "proj_m", "ph_i", ...HISTORY]),
    );
    expect(cols(plan("maison -jean@x.com"), 1)).toEqual(sorted(["notes_m", "em_i", ...HISTORY]));
    expect(cols(plan("maison -ab"), 1)).toEqual(sorted(["name_w", "city_w", "addr_m", "proj_m"]));
  });

  it("REQ, NEG, contactBits, NONCONTACT, deepBits", () => {
    const p = plan("tremblay 5145551234 -condo -jean@x.com");
    expect(p.positive.map((t) => t.bit)).toEqual([1, 2]);
    expect(p.negative.map((t) => t.bit)).toEqual([256, 512]);
    expect(p.termCount).toBe(2);
    expect(p.req).toBe(3);
    expect(p.neg).toBe(256 | 512);
    expect(p.contactBits).toBe(2 | 512);
    expect(p.nonContact).toBe(0x7ff & ~(2 | 512));
    expect(p.deepBits).toBe(1 | 2 | 256 | 512);
    expect(p.positiveBits).toEqual([1, 2]);
    expect(p.terms.map((t) => t.index)).toEqual([0, 1, 2, 3]);
  });

  it("un courriel ou un numéro ENTRE GUILLEMETS est un terme de coordonnées (bit coupé par cb)", () => {
    const p = plan('piscine "418 555 3333" -"yves.perso@mail.com"');
    expect(p.terms.map((t) => [t.kind, t.contactKind])).toEqual([
      ["text", false],
      ["phrase", true],
      ["text", true],
    ]);
    expect(p.contactBits).toBe(2 | 256);
    expect(p.nonContact & (2 | 256)).toBe(0);
    expect(p.highlight.notes.map((h) => h.contactKind)).toEqual([false, true]);
  });

  it("chaque entrée porte le bit et l'index de SON terme", () => {
    const p = plan("tremblay laval -condo");
    for (const c of MASK_COLUMNS) {
      for (const e of p.columns[c].entries) {
        expect(p.terms[e.term].bit).toBe(e.bit);
        expect(p.terms[e.term].columns).toContain(c);
      }
    }
  });

  it("5 termes : REQ = 31", () => {
    expect(plan("alpha bravo charlie delta echo").req).toBe(31);
  });

  it("un terme court n'allume pas deepBits, un long oui", () => {
    expect(plan("ab tremblay").deepBits).toBe(2);
  });

  it("aucun terme positif : termCount 0, onlyExclusions", () => {
    const p = plan("-condo");
    expect(p.termCount).toBe(0);
    expect(p.req).toBe(0);
    expect(p.onlyExclusions).toBe(true);
  });
});

describe("colonnes : préfiltres et alternances", () => {
  it("any = alternance des motifs regex ; null pour LIKE / égalité / colonne vide", () => {
    const p = plan("tremblay laval");
    const [a, b] = p.columns.name_i.entries;
    expect(p.columns.name_i.any).toBe(
      `(?:${a.op === "regex" ? a.pattern : ""})|(?:${b.op === "regex" ? b.pattern : ""})`,
    );
    expect(p.columns.em_t.any).toBeNull();
    expect(p.columns.ph_i.any).toBeNull();
    expect(p.columns.addr_pc.any).toBeNull();
  });

  it("une seule entrée : any est le motif lui-même", () => {
    const p = plan("tremblay");
    const e = p.columns.com_m.entries[0];
    expect(p.columns.com_m.any).toBe(e.op === "regex" ? e.pattern : "");
  });

  it("colonne floue : l'alternance de ses PRÉFILTRES", () => {
    const p = plan("trembly lavall", "all", true);
    const prefilters = p.columns.name_f.entries.map((e) => (e.op === "regex" ? e.prefilter : null));
    expect(prefilters.every((x) => x !== null)).toBe(true);
    expect(p.columns.name_f.any).toBe(prefilters.map((x) => `(?:${x})`).join("|"));
  });

  it("deepAny couvre l'historique, exclusions comprises", () => {
    const p = plan("piscine -condo");
    const re = new RegExp(p.deepAny!, "iu");
    expect(re.test("veut une piscine")).toBe(true);
    expect(re.test("pas de condo")).toBe(true);
    expect(re.test("rien")).toBe(false);
  });

  it("gardes et sources des colonnes", () => {
    const p = plan("tremblay");
    expect(p.columns.name_i).toMatchObject({ field: "name", gate: "visible", sources: ["name_t"] });
    expect(p.columns.ph_x).toMatchObject({ field: "phone", gate: "contact", sources: ["phone_t", "phone2_t"] });
    expect(p.columns.em_t).toMatchObject({ gate: "contact", sources: ["email_t"] });
    expect(p.columns.com_m).toMatchObject({ field: "comment", gate: "history", sources: [] });
    expect(p.columns.sms_m).toMatchObject({ gate: "thread" });
  });
});

describe("flou", () => {
  it("les 3 premiers termes éligibles seulement", () => {
    const p = plan("alphaa bravoo charlie deltaa echooo", "all", true);
    const fuzzyTerms = p.positive.filter((t) => t.columns.includes("name_f")).map((t) => t.value);
    expect(fuzzyTerms).toEqual(["alphaa", "bravoo", "charlie"]);
    expect(p.fuzzyEligible).toBe(true);
  });

  it("la relance garde EXACTEMENT les mêmes termes et bits (seuls name_f / city_f s'ajoutent)", () => {
    const strict = plan("trembly levis -condo");
    const retry = plan("trembly levis -condo", "all", true);
    expect(retry.terms.map((t) => [t.value, t.bit])).toEqual(strict.terms.map((t) => [t.value, t.bit]));
    expect([retry.req, retry.neg, retry.contactBits, retry.deepBits]).toEqual([
      strict.req,
      strict.neg,
      strict.contactBits,
      strict.deepBits,
    ]);
    for (const c of MASK_COLUMNS) {
      if (c === "name_f" || c === "city_f") continue;
      expect(retry.columns[c].entries).toEqual(strict.columns[c].entries);
    }
    expect(retry.columns.name_f.entries.map((e) => e.bit)).toEqual([1, 2]);
  });

  it("fuzzyEligible sans remplir les colonnes quand fuzzy=false", () => {
    const p = plan("trembly");
    expect(p.fuzzyEligible).toBe(true);
    expect(p.columns.name_f.entries).toEqual([]);
  });

  it("pas éligible : trop court, chiffres, opérateur hors nom/ville, expression", () => {
    expect(plan("trem").fuzzyEligible).toBe(false);
    expect(plan("4761542").fuzzyEligible).toBe(false);
    expect(plan("note:piscinne").fuzzyEligible).toBe(false);
    expect(plan('"trois rivieres"').fuzzyEligible).toBe(false);
    expect(plan("ville:lavall", "all", true).terms[0].columns).toEqual(
      expect.arrayContaining(["city_f"]),
    );
    expect(plan("ville:lavall", "all", true).terms[0].columns).not.toContain("name_f");
  });
});

describe("portée", () => {
  it("dans:notes → les colonnes de la famille notes", () => {
    const p = plan("piscine dans:notes");
    expect(p.scope).toBe("notes");
    expect(p.scopeColumns).toEqual(["notes_m", "com_m", "fup_m", "call_m", "sms_m"]);
  });

  it("les trois familles couvrent chaque colonne une fois", () => {
    const all = [...GROUP_COLUMNS.contact, ...GROUP_COLUMNS.profile, ...GROUP_COLUMNS.notes];
    expect(sorted(all)).toEqual(sorted([...MASK_COLUMNS]));
    expect(GROUP_COLUMNS.contact).toEqual(
      ["name_x", "name_w", "name_i", "name_f", "ph_x", "ph_s", "ph_i", "ph_p", "em_x", "em_p", "em_i", "em_t"],
    );
    expect(GROUP_COLUMNS.profile).toEqual(["city_x", "city_w", "city_i", "city_f", "addr_pc", "addr_m", "proj_m"]);
  });
});

describe("bonus de nom", () => {
  const hit = (p: string | null, s: string) => p !== null && new RegExp(p, "iu").test(s);

  it("exact, expression et début à partir de la séquence", () => {
    const p = plan("jean tremblay");
    expect(hit(p.exactName, "Tremblay, Jean")).toBe(true);
    expect(hit(p.phraseName, "Marie Jean Tremblay")).toBe(true);
    expect(hit(p.startName, "Jean-Marc Tremblay")).toBe(true);
    expect(hit(p.startName, "Tremblay Jean")).toBe(false);
  });

  it("les mots vides de la séquence comptent pour l'exact", () => {
    const p = plan("marie de la chevrotiere");
    expect(hit(p.exactName, "Marie de la Chevrotière")).toBe(true);
    expect(p.positive.map((t) => t.value)).toEqual(["marie", "chevrotiere"]);
  });

  it("pas de séquence (numéro, opérateurs) → aucun bonus", () => {
    const p = plan("4184761542");
    expect([p.exactName, p.phraseName, p.startName]).toEqual([null, null, null]);
    const q = plan("ville:laval");
    expect([q.exactName, q.phraseName, q.startName]).toEqual([null, null, null]);
  });

  it("start : le premier terme texte qui touche le nom", () => {
    const p = plan("5145551234 jean");
    expect(hit(p.startName, "Jean Roy")).toBe(true);
    expect(p.phraseName).toBeNull();
  });
});

describe("surlignage", () => {
  it("le motif le plus large par champ, pour chaque terme positif", () => {
    const p = plan("marc 514 -condo");
    expect(p.highlight.name.map((h) => h.term)).toEqual([0, 1]);
    const infix = p.columns.name_i.entries.find((e) => e.term === 0);
    expect(p.highlight.name[0].pattern).toBe(infix?.op === "regex" ? infix.pattern : "");
    expect(p.highlight.city.map((h) => h.term)).toEqual([0]);
    expect(p.highlight.phone).toEqual([]);
    expect(p.highlight.email).toEqual([]);
    expect(p.highlight.comment.map((h) => h.term)).toEqual([0, 1]);
  });

  it("marque les termes de coordonnées", () => {
    const p = plan("roy 5145551234");
    expect(p.highlight.notes.map((h) => h.contactKind)).toEqual([false, true]);
  });

  it("ajoute le motif flou en relance", () => {
    const p = plan("trembly", "all", true);
    expect(p.highlight.name).toHaveLength(2);
    expect(new RegExp(p.highlight.name[1].pattern, "iu").test("Tremblay")).toBe(true);
  });
});

describe("cache d'expressions de Postgres (32 par session)", () => {
  it.each([
    "alphaa bravoo charlie deltaa echooo -foxtrot -golfff -hotell",
    "tremblay 5145551234 jean@x.com g1v 4m3 laval -condo -piscine -garage",
    '"trois rivieres" st-foy saintefoy marie-josee ab -cd -ef -gh',
  ])("%s : au plus 32 chaînes distinctes, relance floue comprise", (q) => {
    for (const fuzzy of [false, true]) {
      expect(regexStrings(plan(q, "all", fuzzy)).length).toBeLessThanOrEqual(32);
    }
  });
});

describe("barème et méta", () => {
  it("scoreSpec : les colonnes possibles de chaque terme, points décroissants", () => {
    const p = plan("jean 5145551234");
    expect(p.score.terms.map((t) => t.bit)).toEqual([1, 2]);
    expect(p.score.terms[0].columns[0]).toEqual({ column: "name_x", points: 100 });
    expect(p.score.terms[1].columns[0]).toEqual({ column: "ph_x", points: 130 });
    const pts = p.score.terms[0].columns.map((c) => c.points);
    expect(pts).toEqual([...pts].sort((a, b) => b - a));
    expect(p.score.sameRecord).toBe(20);
    expect(plan("jean").score.sameRecord).toBeNull();
    expect(p.score.history.req).toBe(3);
  });

  it("scoreSpec.sameAddress : seulement avec 2 termes et plus, dont un numéro civique qui lit l'adresse", () => {
    expect(plan("412 rue tremblay").score.sameAddress).toBe(BONUS.sameAddress);
    expect(plan("tremblay 12 rue").score.sameAddress).toBe(BONUS.sameAddress);
    // Pas de numéro : « tremblay laval » cherche une personne à Laval, pas le boulevard Tremblay.
    expect(plan("tremblay laval").score.sameAddress).toBeNull();
    // Un seul terme, un numéro de téléphone, un numéro qui ne lit pas l'adresse.
    expect(plan("412").score.sameAddress).toBeNull();
    expect(plan("tremblay 4184761542").score.sameAddress).toBeNull();
    expect(plan("tremblay tel:412").score.sameAddress).toBeNull();
    expect(plan("412 tremblay", "identity").score.sameAddress).toBeNull();
    // L'exclusion d'un numéro n'en fait pas une adresse.
    expect(plan("rue tremblay -412").score.sameAddress).toBeNull();
  });

  it("searchMetaBase", () => {
    const p = plan("jean ville:laval -condo dans:notes xyz:1 de");
    expect(searchMetaBase(p)).toEqual({
      terms: [
        { text: "jean", kind: "text", fields: null, negated: false },
        { text: "laval", kind: "text", fields: ["city"], negated: false },
        { text: "xyz:1", kind: "text", fields: null, negated: false },
        { text: "condo", kind: "text", fields: null, negated: true },
      ],
      ignored: ["de"],
      scope: "notes",
      match: "all",
      shortOnly: false,
      onlyExclusions: false,
    });
  });
});
