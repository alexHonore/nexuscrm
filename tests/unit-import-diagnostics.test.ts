/**
 * Unitaire — le diagnostic d'un fichier d'import.
 *
 * Ce que ces tests protègent : un fichier refusé doit dire OÙ et POURQUOI.
 * Le chemin sans la ligne n'aide pas sur quatre cents lignes, et la ligne sans
 * la catégorie ne dit pas quoi corriger.
 */
import { describe, expect, it } from "vitest";
import {
  describeJsonSyntaxError,
  formatPath,
  jsonPositions,
  locateIssues,
  normalizeIssues,
  ROOT_PATH,
  scanJson,
} from "@/lib/import-diagnostics";

const FILE = `{
  "format": "nexus.assistant/v1",
  "assistant": {
    "name": "Acheteurs",
    "goal": {
      "primary": { "type": "meeting" },
      "fallbacks": [
        { "type": "phone_call" },
        { "type": "collect_email" }
      ]
    }
  }
}`;

describe("chemins", () => {
  it("écrit un index de tableau comme on le lit dans un éditeur", () => {
    expect(formatPath(["assistant", "goal", "primary", "type"])).toBe("assistant.goal.primary.type");
    expect(formatPath(["guardrails", 0, "kind"])).toBe("guardrails[0].kind");
    // La racine ne se traduit pas : elle s'affiche telle quelle, et un mot
    // français dans une interface anglaise serait une fuite de langue.
    expect(formatPath([])).toBe(ROOT_PATH);
    expect(ROOT_PATH).toBe("$");
  });
});

describe("positions dans le fichier", () => {
  const at = jsonPositions(FILE);

  it("pointe la CLÉ, parce que c'est elle qu'on cherche des yeux", () => {
    expect(at.get("format")).toEqual({ line: 2, column: 3 });
    expect(at.get("assistant.name")).toEqual({ line: 4, column: 5 });
    expect(at.get("assistant.goal.primary.type")).toEqual({ line: 6, column: 20 });
  });

  it("descend dans les tableaux, élément par élément", () => {
    expect(at.get("assistant.goal.fallbacks[0]")?.line).toBe(8);
    expect(at.get("assistant.goal.fallbacks[1]")?.line).toBe(9);
    expect(at.get("assistant.goal.fallbacks[1].type")?.line).toBe(9);
  });

  it("ne se laisse pas piéger par une accolade DANS une chaîne", () => {
    const tricky = '{\n  "a": "un } et un \\" guillemet",\n  "b": 1\n}';
    expect(jsonPositions(tricky).get("b")).toEqual({ line: 3, column: 3 });
  });

  it("rend ce qu'il a plutôt que de lever, sur un texte tronqué", () => {
    const positions = jsonPositions('{ "a": { "b": ');
    expect(positions.get("a")).toBeDefined();
    expect(() => jsonPositions("")).not.toThrow();
    expect(() => jsonPositions("]]]")).not.toThrow();
  });
});

describe("robustesse du scanner", () => {
  it("une imbrication absurde ne fait PAS déborder la pile", () => {
    // Le diagnostic qui explose en expliquant une erreur est le comble.
    const deep = "[".repeat(6000) + "1" + "]".repeat(6000);
    expect(() => scanJson(deep)).not.toThrow();
    expect(scanJson(deep).complete).toBe(false);
  });

  it("un scan tronqué ne fait PAS deviner une ligne au hasard", () => {
    const deep = `{"a": ${"[".repeat(6000)}1${"]".repeat(6000)}, "b": 2}`;
    const [issue] = locateIssues(
      normalizeIssues([{ path: ["b"], code: "invalid_type", message: "expected string, received number" }]),
      deep,
    );
    // « b » n'a jamais été relevé : mieux vaut aucune ligne qu'une fausse.
    expect(issue.line).toBeUndefined();
  });

  it("une clé échappée est retrouvée sous le nom que zod emploie", () => {
    const text = '{\n  "format": "x",\n  "assist\\u0061nt": { "name": 3 }\n}';
    const at = jsonPositions(text);
    expect(at.get("assistant")).toEqual({ line: 3, column: 3 });
    expect(at.get("assistant.name")?.line).toBe(3);
  });
});

describe("normalisation des objections", () => {
  it("« il manque » et « mauvais type » ne se réparent pas pareil", () => {
    const [missing, wrong] = normalizeIssues([
      { path: ["exportedAt"], code: "invalid_type", expected: "string", message: "Invalid input: expected string, received undefined" },
      { path: ["assistant", "tools"], code: "invalid_type", expected: "array", message: "Invalid input: expected array, received string" },
    ]);
    expect(missing.code).toBe("missing");
    expect(wrong.code).toBe("wrong_type");
    expect(wrong.expected).toBe("array");
    expect(wrong.received).toBe("string");
    expect(wrong.path).toBe("assistant.tools");
  });

  it("un champ mis à `null` n'est PAS « absent » — il est dans le fichier", () => {
    // Sinon la même ligne disait « ce champ est absent : ajoutez-le » et
    // « trouvé dans le fichier : null ».
    const [issue] = normalizeIssues([
      {
        path: ["assistant", "identity"],
        code: "invalid_type",
        expected: "object",
        message: "Invalid input: expected object, received null",
      },
    ]);
    expect(issue.code).toBe("wrong_type");
    expect(issue.received).toBe("null");
  });

  it("une union refusée n'est pas un fourre-tout : elle se traduit", () => {
    const [issue] = normalizeIssues([
      { path: ["campaign", "trigger"], code: "invalid_union", message: "Invalid input" },
    ]);
    expect(issue.code).toBe("not_allowed");
  });

  it("une valeur refusée porte la LISTE des valeurs permises", () => {
    const [issue] = normalizeIssues([
      {
        path: ["assistant", "goal", "primary", "type"],
        code: "invalid_value",
        values: ["video_meeting", "phone_call", "qualify_only"],
        message: 'Invalid option: expected one of "video_meeting"|"phone_call"|"qualify_only"',
      },
    ]);
    expect(issue.code).toBe("not_allowed");
    expect(issue.options).toEqual(["video_meeting", "phone_call", "qualify_only"]);
  });

  it("une seule valeur permise est un littéral, pas un choix", () => {
    // « format » n'offre rien à choisir : la dire en liste d'une option
    // laisserait croire qu'il y en a d'autres.
    const [issue] = normalizeIssues([
      { path: ["format"], code: "invalid_value", values: ["nexus.assistant/v1"], message: "Invalid input" },
    ]);
    expect(issue.options).toBeUndefined();
    expect(issue.expected).toBe("nexus.assistant/v1");
  });
});

describe("bornes", () => {
  it("« trop grand » porte la borne franchie, seule chose qui se corrige", () => {
    const [big, small] = normalizeIssues([
      { path: ["assistant", "approach", "persistence"], code: "too_big", maximum: 5, origin: "number", message: "Too big" },
      { path: ["assistant", "knowledge", "claims", 0], code: "too_small", minimum: 1, origin: "string", message: "Too small" },
    ]);
    expect(big.code).toBe("too_big");
    expect(big.limit).toBe(5);
    expect(small.code).toBe("too_small");
    expect(small.limit).toBe(1);
  });

  it("une borne en bigint reste affichable", () => {
    const [issue] = normalizeIssues([
      { path: ["x"], code: "too_big", maximum: BigInt("9007199254740993"), message: "Too big" },
    ]);
    expect(typeof issue.limit).toBe("number");
  });
});

describe("localisation", () => {
  it("chaque objection reçoit sa ligne", () => {
    const located = locateIssues(
      normalizeIssues([
        { path: ["assistant", "goal", "primary", "type"], code: "invalid_value", values: ["video_meeting"], message: "x" },
      ]),
      FILE,
    );
    expect(located[0].line).toBe(6);
  });

  it("un champ ABSENT pointe le parent : c'est là qu'il faut l'écrire", () => {
    const located = locateIssues(
      normalizeIssues([
        { path: ["assistant", "identity"], code: "invalid_type", expected: "object", message: "Invalid input: expected object, received undefined" },
      ]),
      FILE,
    );
    expect(located[0].code).toBe("missing");
    expect(located[0].line).toBe(3); // la ligne de « assistant »
  });

  it("une objection à la racine ne reste pas sans repère", () => {
    const located = locateIssues(
      normalizeIssues([{ path: [], code: "invalid_type", expected: "object", message: "expected object, received string" }]),
      FILE,
    );
    expect(located[0].line).toBe(1);
  });
});

describe("erreur de syntaxe", () => {
  it("rend la ligne, la colonne et la ligne fautive", () => {
    const broken = '{\n  "a": 1,\n  "b": 2,,\n}';
    let problem;
    try {
      JSON.parse(broken);
    } catch (err) {
      problem = describeJsonSyntaxError(broken, err);
    }
    expect(problem?.line).toBe(3);
    expect(problem?.excerpt).toContain('"b": 2,,');
  });



  it("préfère « line L column C » quand le moteur le donne", () => {
    const broken = '{\n  "a": 1\n  "b": 2\n}';
    let problem;
    try {
      JSON.parse(broken);
    } catch (err) {
      problem = describeJsonSyntaxError(broken, err);
    }
    expect(problem?.line).toBe(3);
  });

  it("retrouve la position quand V8 n'en donne AUCUNE, juste un extrait", () => {
    // La virgule en trop dans un tableau et le guillemet simple produisent
    // « Unexpected token …, "…extrait…" is not valid JSON », sans position.
    // C'est justement ce qu'on écrit à la main.
    for (const broken of [
      '{\n  "format": "nexus.assistant/v1",\n  "tools": [\n    "book_meeting",\n  ]\n}',
      '{\n  "a": 1,\n  "ton": \'chaleureux\'\n}',
    ]) {
      let problem;
      try {
        JSON.parse(broken);
      } catch (err) {
        problem = describeJsonSyntaxError(broken, err);
      }
      expect(problem?.raw, broken).not.toMatch(/position \d/);
      expect(problem?.line, `${broken}\n→ ${JSON.stringify(problem)}`).toBeGreaterThan(1);
    }
  });

  it("SE TAIT plutôt que d'annoncer « ligne 1 » quand il ne sait pas", () => {
    // Une position inventée envoie chercher au mauvais endroit ; l'absence de
    // position laisse au moins lire le message d'origine.
    const problem = describeJsonSyntaxError('{\n  "a": 1\n}', new Error("boom"));
    expect(problem.line).toBeUndefined();
    expect(problem.column).toBeUndefined();
    expect(problem.raw).toBe("boom");
  });

  it("l'extrait garde son indentation, pour que la colonne tombe juste", () => {
    const broken = '{\n  "a": 1,\n  "b": 2,,\n}';
    let problem;
    try {
      JSON.parse(broken);
    } catch (err) {
      problem = describeJsonSyntaxError(broken, err);
    }
    // Colonne comptée depuis le début de la ligne : l'extrait doit donc
    // commencer au début de la ligne, indentation comprise.
    expect(problem?.excerpt.startsWith("  ")).toBe(true);
    expect(problem!.excerpt.length).toBeGreaterThanOrEqual(problem!.column!);
  });
});
