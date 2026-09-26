/**
 * Unitaire — recherche de clients : les aides de la palette ⌘K (§6.1).
 *
 * Ce que ces tests protègent : l'état de la palette vit dans la chaîne `q`
 * (une puce de portée réécrit `dans:…` sans toucher au reste, guillemets
 * compris) ; « rien trouvé » propose les bonnes sorties, dans le bon ordre ;
 * l'historique ne garde que des requêtes, sans doublon, au plus 8.
 */
import { describe, expect, it } from "vitest";
import { applyScopeToken, noResultSuggestions, pushRecent, RECENT_MAX } from "@/lib/clients-search/palette";
import { parseSearchQuery } from "@/lib/clients-search/query";

describe("applyScopeToken", () => {
  it("ajoute le jeton à la fin, dans la langue de l'interface", () => {
    expect(applyScopeToken("tremblay", "notes", "fr")).toBe("tremblay dans:notes");
    expect(applyScopeToken("tremblay", "notes", "en")).toBe("tremblay in:notes");
    expect(applyScopeToken("tremblay", "profile", "fr")).toBe("tremblay dans:lieu");
    expect(applyScopeToken("tremblay", "contact", "en-CA")).toBe("tremblay in:contact");
    expect(applyScopeToken("  ", "notes", "fr")).toBe("dans:notes");
  });

  it("chaque jeton produit est relu comme la bonne portée", () => {
    for (const locale of ["fr", "en"]) {
      for (const scope of ["contact", "profile", "notes"] as const) {
        expect(parseSearchQuery(applyScopeToken("x y", scope, locale)).scope).toBe(scope);
      }
    }
  });

  it("remplace le jeton existant SUR PLACE", () => {
    expect(applyScopeToken("tremblay dans:notes", "profile", "fr")).toBe("tremblay dans:lieu");
    expect(applyScopeToken("dans:notes tremblay", "contact", "fr")).toBe("dans:contact tremblay");
    expect(applyScopeToken("tremblay in:notes", "contact", "fr")).toBe("tremblay dans:contact");
  });

  it("remplace la forme à valeur séparée (« dans: notes »)", () => {
    expect(applyScopeToken("tremblay dans: notes laval", "contact", "fr")).toBe("tremblay dans:contact laval");
  });

  it("plusieurs jetons : le dernier est remplacé, les autres disparaissent", () => {
    expect(applyScopeToken("dans:notes a in:contact b", "profile", "en")).toBe("a in:place b");
    expect(applyScopeToken("dans:notes a in:contact b", null, "en")).toBe("a b");
  });

  it("retire le jeton (null) — y compris une portée invalide", () => {
    expect(applyScopeToken("tremblay dans:notes", null, "fr")).toBe("tremblay");
    expect(applyScopeToken("dans:notes tremblay laval", null, "fr")).toBe("tremblay laval");
    expect(applyScopeToken("tremblay dans:partout", null, "fr")).toBe("tremblay");
    expect(applyScopeToken("tremblay", null, "fr")).toBe("tremblay");
  });

  it("ne touche pas aux guillemets (ni à l'intérieur)", () => {
    expect(applyScopeToken('"trois  rivières" dans:notes', null, "fr")).toBe('"trois  rivières"');
    expect(applyScopeToken('« dans:notes »  -"vieux port"', "notes", "fr")).toBe('« dans:notes »  -"vieux port" dans:notes');
    expect(applyScopeToken('ville:"trois rivières" in:notes', "profile", "fr")).toBe('ville:"trois rivières" dans:lieu');
  });
});

describe("noResultSuggestions", () => {
  const kinds = (q: string) => noResultSuggestions(parseSearchQuery(q)).map((s) => s.kind);

  it("portée posée → « Chercher partout » d'abord, sans la portée", () => {
    const s = noResultSuggestions(parseSearchQuery("piscine dans:notes"));
    expect(s[0]).toEqual({ kind: "everywhere", query: "piscine" });
  });

  it("2 termes ou plus → « Chercher seulement » pour les 3 premiers, tels que tapés", () => {
    const s = noResultSuggestions(parseSearchQuery('tremblay ville:laval "vieux port" condo'));
    expect(s.filter((x) => x.kind === "only")).toEqual([
      { kind: "only", term: "tremblay", query: "tremblay" },
      { kind: "only", term: "laval", query: "ville:laval" },
      { kind: "only", term: "vieux port", query: '"vieux port"' },
    ]);
  });

  it("un seul terme → pas de « Chercher seulement »", () => {
    expect(kinds("tremblay")).toEqual([]);
  });

  it("exclusions → « Retirer les exclusions »", () => {
    const s = noResultSuggestions(parseSearchQuery("condo -rosemont -\"vieux port\" laval"));
    expect(s.find((x) => x.kind === "withoutExclusions")).toEqual({ kind: "withoutExclusions", query: "condo laval" });
  });

  it("chiffres ou courriel → aide coordonnées ; mots courts → aide mots courts", () => {
    expect(kinds("5145551234")).toEqual(["contactHint"]);
    expect(kinds("jean@x.com")).toEqual(["contactHint"]);
    expect(kinds("\"418-555-2222\"")).toEqual(["contactHint"]);
    expect(kinds("\"jean@x.com\"")).toEqual(["contactHint"]);
    expect(kinds("ab")).toEqual(["shortHint"]);
  });

  it("l'ordre complet", () => {
    expect(kinds("tremblay 514 -condo dans:notes")).toEqual([
      "everywhere",
      "only",
      "only",
      "withoutExclusions",
      "contactHint",
    ]);
    expect(kinds("ab cd -xy dans:lieu")).toEqual(["everywhere", "only", "only", "withoutExclusions", "shortHint"]);
  });
});

describe("pushRecent", () => {
  it("la plus récente en tête", () => {
    expect(pushRecent(["laval"], "tremblay")).toEqual(["tremblay", "laval"]);
  });

  it("sans doublon au pliage près — la graphie la plus récente gagne", () => {
    expect(pushRecent(["Hélène", "laval"], "helene")).toEqual(["helene", "laval"]);
    expect(pushRecent(["jean  tremblay"], "Jean Tremblay ")).toEqual(["Jean Tremblay"]);
  });

  it("au plus 8", () => {
    const list = Array.from({ length: 8 }, (_, k) => `q${k}`);
    const next = pushRecent(list, "neuf");
    expect(next).toHaveLength(RECENT_MAX);
    expect(next[0]).toBe("neuf");
    expect(next).not.toContain("q7");
  });

  it("une requête vide ne change rien (et nettoie les entrées vides)", () => {
    expect(pushRecent(["a", " ", "b"], "   ")).toEqual(["a", "b"]);
  });
});
