/**
 * Unitaire — recherche de clients : ce que la personne a tapé, en termes (§2.2).
 *
 * Ce que ces tests protègent : un numéro tapé avec ses parenthèses reste UN
 * numéro, « ville: laval » cherche la ville, un mot vide ne vide pas la
 * recherche, et un terme de coordonnées (courriel, 7 chiffres et plus) est
 * reconnu comme tel — c'est lui qui ne touche jamais une fiche dont la case
 * `contact` est fermée.
 */
import { describe, expect, it } from "vitest";
import { contactKind, parseSearchQuery, tokenizeSearch } from "@/lib/clients-search/query";
import { foldSearch } from "@/lib/clients-search/fold";

const values = (q: string) => parseSearchQuery(q).positive.map((t) => t.value);

describe("foldSearch — un seul pliage partout", () => {
  it("retire accents et ligatures, met en minuscules", () => {
    expect(foldSearch("Hélène CÔTÉ")).toBe("helene cote");
    expect(foldSearch("Cœur ŒUVRE Æsop Straße")).toBe("coeur oeuvre aesop strasse");
  });
});

describe("parseSearchQuery — normalisation", () => {
  it("passe en NFKC (pleine chasse, ligature fi)", () => {
    expect(values("ｔｒｅｍｂｌａｙ")).toEqual(["tremblay"]);
    expect(values("ﬁlion")).toEqual(["filion"]);
  });

  it("coupe à 200 caractères après trim", () => {
    const q = parseSearchQuery(`   ${"a".repeat(150)} ${"b".repeat(150)}   `);
    expect(q.source).toHaveLength(200);
  });

  it("une requête vide donne zéro terme", () => {
    const q = parseSearchQuery("   ");
    expect(q.positive).toEqual([]);
    expect(q.onlyExclusions).toBe(false);
  });
});

describe("parseSearchQuery — la requête entière est un numéro", () => {
  it.each([
    ["(418) 476-1542", "4184761542"],
    ["418.476.1542", "4184761542"],
    ["+1 418 476 1542", "4184761542"],
    ["14184761542", "4184761542"],
    ["4761542", "4761542"],
    ["514", "514"],
  ])("%s → un seul terme digits %s", (q, digits) => {
    const p = parseSearchQuery(q);
    expect(p.positive).toHaveLength(1);
    expect(p.positive[0]).toMatchObject({ kind: "digits", value: digits, negated: false, text: q });
    expect(p.sequence).toEqual([]);
  });

  it("« 12 » (moins de 3 chiffres) reste du texte", () => {
    expect(parseSearchQuery("12").positive[0]).toMatchObject({ kind: "text", value: "12" });
  });

  it("12 chiffres commençant par 1 : pas de retrait (seulement 11)", () => {
    expect(values("123456789012")).toEqual(["123456789012"]);
  });
});

describe("parseSearchQuery — jetons", () => {
  it("fusionne les morceaux d'un numéro à côté d'un nom", () => {
    const p = parseSearchQuery("tremblay 476-1542");
    expect(p.positive.map((t) => [t.kind, t.value])).toEqual([
      ["text", "tremblay"],
      ["digits", "4761542"],
    ]);
    const q = parseSearchQuery("tremblay (418) 476-1542");
    expect(q.positive[1]).toMatchObject({ kind: "digits", value: "4184761542", raw: "(418) 476-1542" });
  });

  it("ne fusionne pas moins de 3 chiffres", () => {
    expect(parseSearchQuery("maison 3.5").positive.map((t) => [t.kind, t.value])).toEqual([
      ["text", "maison"],
      ["text", "3.5"],
    ]);
  });

  it("courriel : en minuscules, NON plié", () => {
    const p = parseSearchQuery("tremblay Hélène.Roy@Gmail.com");
    expect(p.positive[1]).toMatchObject({ kind: "email", value: "hélène.roy@gmail.com", text: "Hélène.Roy@Gmail.com" });
  });

  it("code postal en un ou deux jetons", () => {
    for (const q of ["G1V 4M3", "g1v4m3", "G1V-4M3"]) {
      expect(parseSearchQuery(`maison ${q}`).positive[1]).toMatchObject({ kind: "postal", value: "g1v4m3" });
    }
    expect(parseSearchQuery("G1V 4M3 tremblay").positive.map((t) => t.kind)).toEqual(["postal", "text"]);
  });

  it("expression entre guillemets droits, anglais ou français", () => {
    for (const q of ['"trois rivières"', "“trois rivières”", "« trois rivières »"]) {
      const p = parseSearchQuery(`${q} condo`);
      expect(p.positive[0]).toMatchObject({ kind: "phrase", value: "trois rivieres", quoted: true, raw: q });
      expect(p.positive[1]).toMatchObject({ kind: "text", value: "condo" });
    }
  });

  it("un seul mot entre guillemets reste un texte (mais échappe aux mots vides)", () => {
    const p = parseSearchQuery('"de" tremblay');
    expect(p.positive.map((t) => [t.kind, t.value, t.quoted])).toEqual([
      ["text", "de", true],
      ["text", "tremblay", false],
    ]);
  });

  it("une expression non fermée court jusqu'au bout", () => {
    expect(parseSearchQuery('"trois riv').positive[0]).toMatchObject({ kind: "phrase", value: "trois riv" });
  });

  it("-mot exclut ; un « - » seul n'est rien", () => {
    const p = parseSearchQuery("condo -rosemont - laval");
    expect(p.positive.map((t) => t.value)).toEqual(["condo", "laval"]);
    expect(p.negative).toMatchObject([{ value: "rosemont", negated: true, raw: "-rosemont" }]);
  });

  it("-« expression » exclut une expression", () => {
    expect(parseSearchQuery('condo -"vieux port"').negative[0]).toMatchObject({ kind: "phrase", value: "vieux port" });
  });

  it("seulement des exclusions : onlyExclusions", () => {
    const p = parseSearchQuery("-condo -laval");
    expect(p.positive).toEqual([]);
    expect(p.negative).toHaveLength(2);
    expect(p.onlyExclusions).toBe(true);
  });
});

describe("parseSearchQuery — opérateurs", () => {
  it.each([
    ["nom", ["name"]],
    ["name", ["name"]],
    ["tel", ["phone"]],
    ["tél", ["phone"]],
    ["telephone", ["phone"]],
    ["Téléphone", ["phone"]],
    ["phone", ["phone"]],
    ["courriel", ["email"]],
    ["email", ["email"]],
    ["mail", ["email"]],
    ["ville", ["city"]],
    ["city", ["city"]],
    ["adresse", ["address"]],
    ["address", ["address"]],
    ["projet", ["project"]],
    ["project", ["project"]],
    ["budget", ["project"]],
    ["note", ["notes", "comment", "followup", "call", "sms"]],
    ["notes", ["notes", "comment", "followup", "call", "sms"]],
    ["commentaire", ["comment"]],
    ["comment", ["comment"]],
    ["com", ["comment"]],
    ["sms", ["sms"]],
    ["texto", ["sms"]],
  ])("%s: → %j", (op, fields) => {
    const p = parseSearchQuery(`${op}:piscine`);
    expect(p.positive[0]).toMatchObject({ value: "piscine", fields });
  });

  it("« ville: laval » : la valeur vide prend le jeton suivant", () => {
    const p = parseSearchQuery("ville: laval condo");
    expect(p.positive.map((t) => [t.value, t.fields])).toEqual([
      ["laval", ["city"]],
      ["condo", null],
    ]);
    expect(p.positive[0].raw).toBe("ville: laval");
  });

  it("opérateur + expression, opérateur + exclusion", () => {
    expect(parseSearchQuery('ville:"trois rivières"').positive[0]).toMatchObject({
      kind: "phrase",
      value: "trois rivieres",
      fields: ["city"],
    });
    expect(parseSearchQuery("condo -ville:laval").negative[0]).toMatchObject({ value: "laval", fields: ["city"] });
  });

  it("tel: avec un numéro en plusieurs morceaux", () => {
    expect(parseSearchQuery("tremblay tel:418 476 1542").positive[1]).toMatchObject({
      kind: "digits",
      value: "4184761542",
      fields: ["phone"],
    });
  });

  it("un opérateur sans valeur au bout est mis de côté", () => {
    const p = parseSearchQuery("tremblay ville:");
    expect(p.positive.map((t) => t.value)).toEqual(["tremblay"]);
    expect(p.ignored).toEqual(["ville:"]);
  });

  it("un x:y inconnu (14:05) reste du texte", () => {
    expect(parseSearchQuery("rappel 14:05").positive[1]).toMatchObject({ kind: "text", value: "14:05", fields: null });
  });

  it.each([
    ["dans:notes", "notes"],
    ["dans:commentaires", "notes"],
    ["in:history", "notes"],
    ["dans:contact", "contact"],
    ["in:coord", "contact"],
    ["dans:coordonnées", "contact"],
    ["dans:profil", "profile"],
    ["dans:lieu", "profile"],
    ["in:place", "profile"],
    ["dans: notes", "notes"],
  ])("portée %s → %s", (token, scope) => {
    const p = parseSearchQuery(`piscine ${token}`);
    expect(p.scope).toBe(scope);
    expect(p.positive.map((t) => t.value)).toEqual(["piscine"]);
  });

  it("la dernière portée gagne ; une portée invalide est mise de côté", () => {
    expect(parseSearchQuery("x dans:notes piscine in:contact").scope).toBe("contact");
    const p = parseSearchQuery("piscine dans:partout");
    expect(p.scope).toBeNull();
    expect(p.ignored).toEqual(["dans:partout"]);
  });

  it("tokenizeSearch garde les positions exactes", () => {
    const src = 'a -b ville: "c d" dans:notes';
    const tokens = tokenizeSearch(src);
    expect(tokens.map((t) => src.slice(t.start, t.end))).toEqual(["a", "-b", 'ville: "c d"', "dans:notes"]);
  });
});

describe("parseSearchQuery — tri des termes", () => {
  it("mots vides mis de côté tant qu'il reste un autre terme", () => {
    const p = parseSearchQuery("maison de la tremblay");
    expect(p.positive.map((t) => t.value)).toEqual(["maison", "tremblay"]);
    expect(p.ignored).toEqual(["de", "la"]);
  });

  it("que des mots vides : on les garde", () => {
    expect(values("de la")).toEqual(["de", "la"]);
  });

  it("une lettre seule : mise de côté, sauf si c'est le seul terme", () => {
    const p = parseSearchQuery("j tremblay");
    expect(p.positive.map((t) => t.value)).toEqual(["tremblay"]);
    expect(p.ignored).toEqual(["j"]);
    expect(values("j")).toEqual(["j"]);
  });

  it("doublons retirés (au pliage près)", () => {
    expect(values("Laval laval LÂVAL")).toEqual(["laval"]);
    // Même valeur mais opérateur différent : deux termes.
    expect(values("laval ville:laval")).toEqual(["laval", "laval"]);
  });

  it("plafonds : 5 termes, 3 exclusions — le reste mis de côté", () => {
    const p = parseSearchQuery("alpha bravo charlie delta echo foxtrot -aa -bb -cc -dd");
    expect(p.positive.map((t) => t.value)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
    expect(p.negative.map((t) => t.value)).toEqual(["aa", "bb", "cc"]);
    expect(p.ignored).toEqual(["foxtrot", "-dd"]);
  });

  it("shortOnly : tous les termes font 1–2 lettres", () => {
    expect(parseSearchQuery("ab cd").shortOnly).toBe(true);
    expect(parseSearchQuery("ab tremblay").shortOnly).toBe(false);
    expect(parseSearchQuery("514").shortOnly).toBe(false);
  });

  it("contactKind : courriel, ou 7 chiffres et plus", () => {
    const kinds = (q: string) => parseSearchQuery(q).positive.map(contactKind);
    expect(kinds("jean@x.com")).toEqual([true]);
    expect(kinds("4761542")).toEqual([true]);
    expect(kinds("476154")).toEqual([false]);
    expect(kinds("tremblay")).toEqual([false]);
  });

  it("séquence : le texte libre positif, mots vides et lettres comprises, sans opérateur ni exclusion", () => {
    const p = parseSearchQuery("Marie de la -chevrotière nom:roy J Trois-Rivières");
    expect(p.sequence).toEqual(["marie", "de", "la", "j", "trois-rivieres"]);
  });

  it("ponctuation des bords retirée, séparateurs internes gardés", () => {
    expect(values("(L’Île-Perrot), jean-marc.")).toEqual(["l’ile-perrot", "jean-marc"]);
  });
});

describe("parseSearchQuery — numéro ou courriel collé avec sa ponctuation (copier-coller)", () => {
  const kinds = (q: string) => parseSearchQuery(q).positive.map((t) => [t.kind, t.value]);

  it.each([
    ["418-542-8728,"],
    ["4185428728,"],
    ["(418) 542-8728;"],
    ["+1 418 542 8728,"],
    ["418-542-8728:"],
    ["<418-542-8728>"],
    ["418-542-8728."],
  ])("« %s » reste UN numéro", (q) => {
    const p = parseSearchQuery(q);
    expect(kinds(q)).toEqual([["digits", "4185428728"]]);
    // Le texte montré perd la ponctuation collée, pas les parenthèses du numéro.
    expect(p.positive[0].text).not.toMatch(/[,;:<>]/);
  });

  it("à côté d'un nom, le numéro garde sa nature", () => {
    expect(kinds("tremblay 418-542-8728,")).toEqual([
      ["text", "tremblay"],
      ["digits", "4185428728"],
    ]);
    expect(kinds("tremblay (418) 542-8728;")).toEqual([
      ["text", "tremblay"],
      ["digits", "4185428728"],
    ]);
  });

  it("« 412, rue Tremblay » : le numéro civique reste un nombre, comme « 412 rue Tremblay »", () => {
    expect(kinds("412, rue Tremblay")).toEqual(kinds("412 rue Tremblay"));
    expect(kinds("412, rue Tremblay")[0]).toEqual(["digits", "412"]);
  });

  it("un courriel entre chevrons (« Nom <x@y.ca> ») reste un courriel", () => {
    expect(kinds("<line.martel52@gmail.com>")).toEqual([["email", "line.martel52@gmail.com"]]);
    expect(kinds("Line Martel <line.martel52@gmail.com>")).toEqual([
      ["text", "line"],
      ["text", "martel"],
      ["email", "line.martel52@gmail.com"],
    ]);
    expect(kinds("line.martel52@gmail.com,")).toEqual([["email", "line.martel52@gmail.com"]]);
  });

  it("« @Josée » cherche la mention (texte), « @gmail.com » reste un bout de courriel", () => {
    expect(kinds("@Josée")).toEqual([["text", "josee"]]);
    expect(kinds("@josée roy")).toEqual([["text", "josee"], ["text", "roy"]]);
    expect(kinds("@gmail.com")).toEqual([["email", "@gmail.com"]]);
    expect(kinds("josee@")).toEqual([["email", "josee@"]]);
    expect(kinds("\"@Josée\"")).toEqual([["text", "@josee"]]);
  });
});

describe("parseSearchQuery — caractères de contrôle", () => {
  it("un octet NUL (ou un autre contrôle) ne survit jamais : Postgres refuse 0x00 dans un paramètre", () => {
    expect(parseSearchQuery("\u0000").positive).toEqual([]);
    const p = parseSearchQuery("abc\u0000def");
    expect(p.positive.map((t) => t.value)).toEqual(["abc", "def"]);
    for (const q of ["abc\u0000def", "\u0001tremblay\u007f", "418\u0000 476 1542", "\u001b[31mroy"]) {
      const parsed = parseSearchQuery(q);
      const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
      expect(parsed.source, q).not.toMatch(control);
      for (const t of [...parsed.positive, ...parsed.negative]) {
        expect(t.value, q).not.toMatch(control);
        expect(t.raw, q).not.toMatch(control);
      }
    }
  });
});

describe("parseSearchQuery — « op: -valeur » reste une exclusion", () => {
  it.each([
    ["ville: -laval", "laval", ["city"]],
    ["ville:-laval", "laval", ["city"]],
    ["condo ville: -laval", "laval", ["city"]],
  ])("%s → exclut la ville", (q, value, fields) => {
    const p = parseSearchQuery(q);
    expect(p.negative).toMatchObject([{ value, fields, negated: true }]);
    expect(p.positive.map((t) => t.value)).not.toContain(value);
    expect(p.positive.some((t) => t.value.startsWith("-"))).toBe(false);
  });

  it("tel: -514 → exclut les numéros, ne les exige pas", () => {
    for (const q of ["tremblay tel: -514", "tremblay tel:-514"]) {
      const p = parseSearchQuery(q);
      expect(p.negative, q).toMatchObject([{ kind: "digits", value: "514", fields: ["phone"], negated: true }]);
      expect(p.positive.map((t) => t.value), q).toEqual(["tremblay"]);
    }
  });

  it("le jeton absorbé garde sa tranche exacte (réécriture de la requête)", () => {
    const src = "condo ville: -laval";
    const p = parseSearchQuery(src);
    expect(p.negative[0].raw).toBe("ville: -laval");
    expect(src.slice(...p.negative[0].span)).toBe("ville: -laval");
  });
});

describe("contactKind — sur le CONTENU, guillemets ou pas", () => {
  const kindOf = (q: string) => {
    const t = [...parseSearchQuery(q).positive, ...parseSearchQuery(q).negative][0];
    return contactKind(t);
  };

  it.each([
    '"colette@exemple.com"',
    'note:"colette@exemple.com"',
    '"418-555-2222"',
    '"418.555.2222"',
    '"418 555 3333"',
    '"yves.perso@mail.com"',
    '"rappeler au 418 555 3333 demain"',
    '-"418 555 3333"',
  ])("%s est un terme de coordonnées", (q) => {
    expect(kindOf(q)).toBe(true);
  });

  it.each(['"rue tremblay"', '"412 rue tremblay"', '"555-222"', '"@josee"', '"colette@"'])(
    "%s ne l'est pas",
    (q) => {
      expect(kindOf(q)).toBe(false);
    },
  );
});
