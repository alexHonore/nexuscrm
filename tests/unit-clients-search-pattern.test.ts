/**
 * Unitaire — recherche de clients : les MOTIFS (§2.3).
 *
 * Ce que ces tests protègent : la même chaîne filtre en SQL (`~*`) et surligne
 * en JS (`new RegExp(p, "iu")`). Ici, le côté JS de la matrice : « helene »
 * trouve « Hélène », « st » ne trouve pas « Christine », « 50% » ne trouve pas
 * tout le monde, et une faute de frappe d'une lettre retrouve « Tremblay ». Le
 * côté Postgres de la même matrice vit dans le test d'intégration de parité.
 */
import { describe, expect, it } from "vitest";
import { foldSearch } from "@/lib/clients-search/fold";
import {
  anyOf,
  digitsPattern,
  emailPattern,
  escapeLike,
  escapeRegex,
  exactNamePattern,
  fuzzyEligible,
  fuzzyPattern,
  phraseNamePattern,
  postalPattern,
  startNamePattern,
  textLevels,
  type TextLevels,
} from "@/lib/clients-search/pattern";

const hit = (pattern: string, text: string) => new RegExp(pattern, "iu").test(text);

/** Les niveaux d'un terme TAPÉ (plié comme le fait `parseSearchQuery`). */
function levels(typed: string, kind: "text" | "phrase" = "text"): TextLevels {
  const lv = textLevels(foldSearch(typed), kind);
  if (!lv) throw new Error(`aucun motif pour ${typed}`);
  return lv;
}

const allLevels = (lv: TextLevels) => [lv.infix, lv.wordStart, lv.whole, lv.text];

describe("chaque motif compile en « iu » et ne trouve jamais la chaîne vide", () => {
  const typed = [
    "tremblay",
    "Hélène",
    "l'île",
    "st",
    "ste-foy",
    "saintefoy",
    "a.b",
    "50%",
    "a_b",
    "a(b",
    "x[y",
    "}{",
    "a|b",
    "c$",
    "^x",
    "a/b",
    "a\\b",
    "é*+?",
    "cœur",
    "ørsted",
    "ab",
    "😀x",
  ];
  it.each(typed)("texte %s", (t) => {
    const lv = textLevels(foldSearch(t));
    expect(lv).not.toBeNull();
    for (const p of allLevels(lv!)) {
      expect(() => new RegExp(p, "iu")).not.toThrow();
      expect(hit(p, "")).toBe(false);
    }
  });

  it("expressions, chiffres, courriel, postal, bonus de nom, flou, alternance", () => {
    const patterns = [
      levels("trois rivières", "phrase").infix,
      levels("rue st-denis", "phrase").whole,
      digitsPattern("4184761542"),
      emailPattern("jean.o'brien+test@x-y.com"),
      postalPattern("g1v4m3"),
      exactNamePattern(["jean", "tremblay", "st"])!,
      exactNamePattern(["a", "b", "c", "d"])!,
      phraseNamePattern(["jean", "tremblay"])!,
      startNamePattern("jean")!,
      fuzzyPattern("tremblay")!.pattern,
      fuzzyPattern("tremblay")!.prefilter,
      anyOf(["a", "b(c)"])!,
    ];
    for (const p of patterns) {
      expect(() => new RegExp(p, "iu")).not.toThrow();
      expect(hit(p, "")).toBe(false);
    }
  });

  it("un texte sans morceau n'a pas de motif", () => {
    expect(textLevels("-")).toBeNull();
    expect(textLevels("'’.")).toBeNull();
  });
});

describe("matrice de pliage (§7.1)", () => {
  it("Hélène / HELENE / helene", () => {
    for (const typed of ["HELENE", "helene", "Hélène", "hélene"]) {
      const lv = levels(typed);
      for (const stored of ["Hélène", "HÉLÈNE", "helene", "Marie-Hélène Roy"]) {
        expect(hit(lv.infix, stored), `${typed} → ${stored}`).toBe(true);
      }
    }
  });

  it("Côté / cote, dans les deux sens", () => {
    expect(hit(levels("cote").whole, "Côté")).toBe(true);
    expect(hit(levels("côté").whole, "Cote")).toBe(true);
    expect(hit(levels("COTE").whole, "CÔTÉ")).toBe(true);
  });

  it("Cœur / coeur, dans les deux sens", () => {
    expect(hit(levels("coeur").whole, "Cœur")).toBe(true);
    expect(hit(levels("coeur").whole, "CŒUR")).toBe(true);
    expect(hit(levels("cœur").whole, "coeur")).toBe(true);
    expect(hit(levels("cœur").whole, "Cœur")).toBe(true);
  });

  it("le digramme garde ses accents : Noël, Raphaël", () => {
    expect(hit(levels("noel").whole, "Noël")).toBe(true);
    expect(hit(levels("raphael").whole, "Raphaël")).toBe(true);
    expect(hit(levels("aesop").whole, "Æsop")).toBe(true);
  });

  it("L’Île-Perrot / « l'ile » / « l ile »", () => {
    const stored = "L’Île-Perrot";
    expect(hit(levels("l'ile").infix, stored)).toBe(true);
    expect(hit(levels("l’île").wordStart, stored)).toBe(true);
    expect(hit(levels("l ile", "phrase").infix, stored)).toBe(true);
    expect(hit(levels("ile").infix, stored)).toBe(true);
    expect(hit(levels("ile-perrot").whole, stored)).toBe(true);
  });

  it("Trois-Rivières / « trois rivieres » / « rivi »", () => {
    const stored = "Trois-Rivières";
    expect(hit(levels("trois rivieres", "phrase").whole, stored)).toBe(true);
    expect(hit(levels("trois-rivieres").whole, stored)).toBe(true);
    expect(hit(levels("rivi").infix, stored)).toBe(true);
    expect(hit(levels("rivi").wordStart, stored)).toBe(true);
    expect(hit(levels("rivi").whole, stored)).toBe(false);
  });

  it("Sainte-Foy / « st-foy » / « ste foy » / « saintefoy »", () => {
    for (const stored of ["Sainte-Foy", "Ste-Foy", "STE FOY", "Ste. Foy"]) {
      expect(hit(levels("st-foy").whole, stored), `st-foy → ${stored}`).toBe(true);
      expect(hit(levels("ste foy", "phrase").whole, stored), `"ste foy" → ${stored}`).toBe(true);
      expect(hit(levels("saintefoy").infix, stored), `saintefoy → ${stored}`).toBe(true);
    }
    expect(hit(levels("saintefoy").infix, "saintefoy")).toBe(true);
    expect(hit(levels("saintjean").infix, "St-Jean-sur-Richelieu")).toBe(true);
    // « ste » est féminin : il ne prend pas « Saint-Jean ».
    expect(hit(levels("ste-jean").infix, "Saint-Jean")).toBe(false);
    expect(hit(levels("st-jean").infix, "Saint-Jean")).toBe(true);
  });

  it("« st » ne trouve jamais Christine (ni Stéphane), à aucun niveau", () => {
    const lv = levels("st");
    for (const p of allLevels(lv)) {
      expect(hit(p, "Christine")).toBe(false);
      expect(hit(p, "Stéphane")).toBe(false);
      expect(hit(p, "Ouest")).toBe(false);
      expect(hit(p, "St-Hubert")).toBe(true);
      expect(hit(p, "Saint-Hubert")).toBe(true);
      expect(hit(p, "Ste-Julie")).toBe(true);
    }
  });

  it("« marc » : mot entier dans Marc-André, début de mot dans Marcel", () => {
    const lv = levels("marc");
    expect(hit(lv.whole, "Marc-André Roy")).toBe(true);
    expect(hit(lv.whole, "Marcel Roy")).toBe(false);
    expect(hit(lv.wordStart, "Marcel Roy")).toBe(true);
    expect(hit(lv.wordStart, "Lamarche")).toBe(false);
    expect(hit(lv.infix, "Lamarche")).toBe(true);
  });

  it("une frontière de mot respecte les lettres accentuées (É n'est pas un séparateur)", () => {
    expect(hit(levels("lise").wordStart, "Élise")).toBe(false);
    expect(hit(levels("elise").wordStart, "Élise")).toBe(true);
    expect(hit(levels("mile").whole, "Émile")).toBe(false);
  });

  it("niveau texte : infixe dès 3 caractères, début de mot en dessous", () => {
    expect(levels("rem").text).toBe(levels("rem").infix);
    expect(levels("re").text).toBe(levels("re").wordStart);
    expect(hit(levels("re").text, "Tremblay")).toBe(false);
    expect(hit(levels("re").text, "Renée")).toBe(true);
  });
});

describe("le texte de l'utilisateur reste littéral", () => {
  it("métacaractères échappés", () => {
    expect(escapeRegex("^$\\.*+?()[]{}|/")).toBe("\\^\\$\\\\\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\/");
    expect(escapeRegex("%_-'@#")).toBe("%_-'@#");
  });

  it("« a.b » : le point est un séparateur, pas un joker", () => {
    const lv = levels("a.b");
    expect(hit(lv.infix, "a.b")).toBe(true);
    expect(hit(lv.infix, "a b")).toBe(true);
    expect(hit(lv.infix, "axb")).toBe(false);
  });

  it("« 50% » et « a_b » : % et _ sont des caractères ordinaires", () => {
    expect(hit(levels("50%").infix, "50% comptant")).toBe(true);
    expect(hit(levels("50%").infix, "500 comptant")).toBe(false);
    expect(hit(levels("a_b").infix, "a_b")).toBe(true);
    expect(hit(levels("a_b").infix, "axb")).toBe(false);
  });

  it("« ( » et « [ » littéraux", () => {
    expect(hit(levels("a(b").infix, "a(b")).toBe(true);
    expect(hit(levels("a(b").infix, "ab")).toBe(false);
    expect(hit(levels("x[y").infix, "x[y")).toBe(true);
    expect(hit(levels("a*").infix, "aaa")).toBe(false);
    expect(hit(levels("a*").infix, "a*")).toBe(true);
  });

  it("escapeLike échappe \\, % et _", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});

describe("chiffres, courriel, code postal", () => {
  it("chiffres dans un texte libre : « 650 000 $ »", () => {
    const p = digitsPattern("650000");
    expect(hit(p, "Budget : 650 000 $")).toBe(true);
    expect(hit(p, "Budget : 650\u00A0000 $")).toBe(true);
    expect(hit(p, "Budget : 650\u202F000 $")).toBe(true);
    expect(hit(p, "650000")).toBe(true);
    expect(hit(p, "65 0 0 00")).toBe(true);
    expect(hit(p, "650 / 000")).toBe(false);
  });

  it("chiffres d'un numéro écrit à la main", () => {
    const p = digitsPattern("4184761542");
    expect(hit(p, "rappeler au (418) 476-1542 svp")).toBe(true);
    expect(hit(p, "418.476.1542")).toBe(true);
  });

  it("un nombre court (3–6 chiffres) est un NOMBRE entier : 412 ne trouve ni 6412 ni 4127", () => {
    const p = digitsPattern("412");
    for (const s of ["412 rue Tremblay", "412B rue Tremblay", "app. 3, 412 rue X", "(412)", "Budget 412 000 $"]) {
      expect(hit(p, s), s).toBe(true);
    }
    for (const s of ["6412 rue Bédard", "4127 boul. Laurier", "+18198084127", "G1V4120"]) {
      expect(hit(p, s), s).toBe(false);
    }
    expect(hit(digitsPattern("6412"), "6412 rue Bédard")).toBe(true);
    expect(hit(digitsPattern("6412"), "16412 rue Bédard")).toBe(false);
    // Les séparateurs d'un nombre restent tolérés à l'intérieur.
    expect(hit(digitsPattern("650000"), "Budget : 650 000 $")).toBe(true);
    expect(hit(digitsPattern("650000"), "Budget : 1 650 000 $")).toBe(true);
  });

  it("un numéro (7 chiffres et plus) finit où le nombre écrit finit, mais peut être la FIN d'un plus long", () => {
    const p = digitsPattern("4184761542");
    expect(hit(p, "+14184761542")).toBe(true);
    expect(hit(p, "1 418 476-1542")).toBe(true);
    expect(hit(p, "41847615420")).toBe(false);
    // 7 chiffres : la fin d'un numéro complet écrit sans séparateur (comme `ph_s`).
    expect(hit(digitsPattern("4761542"), "rappeler au 4184761542")).toBe(true);
    expect(hit(digitsPattern("4761542"), "47615429")).toBe(false);
  });

  it("courriel littéral", () => {
    const p = emailPattern("jean.roy@x.com");
    expect(hit(p, "Courriel : Jean.Roy@X.com")).toBe(true);
    expect(hit(p, "jeanxroy@x.com")).toBe(false);
  });

  it("code postal avec ou sans espace", () => {
    const p = postalPattern("g1v4m3");
    for (const s of ["G1V 4M3", "g1v4m3", "G1V-4M3", "Québec (Québec) G1V\u00A04M3"]) expect(hit(p, s), s).toBe(true);
    expect(hit(p, "G1V 4M4")).toBe(false);
  });
});

describe("bonus de nom", () => {
  it("exact : toutes les permutations (3 éléments au plus)", () => {
    const p = exactNamePattern(["jean", "tremblay"])!;
    expect(hit(p, "Jean Tremblay")).toBe(true);
    expect(hit(p, "  TREMBLAY, Jean. ")).toBe(true);
    expect(hit(p, "Jean-Marc Tremblay")).toBe(false);
    expect(hit(p, "Jean Tremblay fils")).toBe(false);
  });

  it("exact au-delà de 3 éléments : l'ordre tapé seulement", () => {
    const p = exactNamePattern(["marie", "de", "la", "chevrotiere"])!;
    expect(hit(p, "Marie de La Chevrotière")).toBe(true);
    expect(hit(p, "De La Chevrotière Marie")).toBe(false);
  });

  it("expression : la séquence dans l'ordre, à un début de mot", () => {
    const p = phraseNamePattern(["jean", "tremblay"])!;
    expect(hit(p, "Marie Jean Tremblay")).toBe(true);
    expect(hit(p, "Tremblay Jean")).toBe(false);
    expect(phraseNamePattern(["jean"])).toBeNull();
  });

  it("début : le nom commence par le terme", () => {
    const p = startNamePattern("jean")!;
    expect(hit(p, "Jean-Marc Tremblay")).toBe(true);
    expect(hit(p, "Marc Jean")).toBe(false);
  });
});

describe("flou (relance faute de frappe)", () => {
  it.each(["trembly", "tremblai", "rtemblay", "tremblayy", "trenblay"])("%s retrouve Tremblay", (typed) => {
    const fz = fuzzyPattern(foldSearch(typed))!;
    expect(fz).not.toBeNull();
    expect(hit(fz.pattern, "Jean Tremblay")).toBe(true);
    expect(hit(fz.prefilter, "Jean Tremblay")).toBe(true);
  });

  it("à un début de mot seulement, et pas à deux fautes", () => {
    const fz = fuzzyPattern("trembly")!;
    expect(hit(fz.pattern, "Xtremblay")).toBe(false);
    expect(hit(fz.pattern, "Trenbli")).toBe(false);
  });

  it("ni sous 5 ni au-dessus de 12 caractères, ni plusieurs morceaux", () => {
    expect(fuzzyPattern("trem")).toBeNull();
    expect(fuzzyPattern("abcdefghijklm")).toBeNull();
    expect(fuzzyPattern("abcdefghijkl")).not.toBeNull();
    expect(fuzzyEligible("jean-marc")).toBe(false);
    expect(fuzzyEligible("l'ile-perrot")).toBe(false);
  });

  it("propriété : le préfiltre est TOUJOURS impliqué par le motif", () => {
    // Générateur déterministe (pas de hasard non reproductible).
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const alphabet = "abceinoruyltsméè-' ";
    const words = ["tremblay", "gagnon", "bouchard", "lavoie", "fortin", "gauthier", "morin", "pelletier", "cote", "helene"];
    for (let round = 0; round < 1500; round++) {
      const w = words[rand(words.length)] + (rand(3) === 0 ? "e" : "");
      const fz = fuzzyPattern(w);
      if (!fz) continue;
      // Une variante à 0, 1 ou 2 modifications, entourée de bruit.
      let s = w;
      const edits = rand(3);
      for (let e = 0; e < edits; e++) {
        const i = rand(s.length + 1);
        const c = alphabet[rand(alphabet.length)];
        const op = rand(4);
        if (op === 0) s = s.slice(0, i) + c + s.slice(i + 1);
        else if (op === 1) s = s.slice(0, i) + c + s.slice(i);
        else if (op === 2) s = s.slice(0, i) + s.slice(i + 1);
        else if (i + 1 < s.length) s = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
      }
      const text = `${alphabet[rand(alphabet.length)]}${rand(2) ? " " : ""}${s.toUpperCase()} ${alphabet[rand(alphabet.length)]}`;
      if (hit(fz.pattern, text)) expect(hit(fz.prefilter, text), `${w} ⊃ ${text}`).toBe(true);
    }
  });
});

describe("anyOf", () => {
  it("alternance groupée, sans doublon ; un seul → lui-même ; vide → null", () => {
    expect(anyOf(["a", "b", "a"])).toBe("(?:a)|(?:b)");
    expect(anyOf(["a|b", "a|b"])).toBe("a|b");
    expect(anyOf([])).toBeNull();
  });
});
