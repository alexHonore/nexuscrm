/**
 * Diagnostic d'un fichier d'import — module PUR (ni Next, ni base, ni zod).
 *
 * Un import qui échoue disait « ce fichier n'est pas un export valide » et
 * s'arrêtait là. Sur un document de quatre cents lignes rédigé à la main,
 * c'est une impasse : rien ne dit quel champ, ni pourquoi, ni où regarder.
 *
 * Ce module transforme les objections du schéma en trois choses qu'on peut
 * suivre : le CHEMIN dans le document, la LIGNE dans le fichier téléversé, et
 * une CATÉGORIE traduisible (il manque / mauvais type / valeur refusée…). Le
 * texte affiché vit dans `messages/<locale>/*.json` — ici, rien que des codes
 * et des données.
 */

// ── Ce qu'on rend ────────────────────────────────────────────────────────────

/**
 * Les catégories d'échec, choisies pour ce qu'elles font FAIRE au lecteur :
 * ajouter un champ, corriger un type, choisir dans une liste, raccourcir.
 */
export const IMPORT_ISSUE_CODES = [
  "missing",
  "wrong_type",
  "not_allowed",
  "too_small",
  "too_big",
  "wrong_format",
  "other",
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

export interface ImportIssue {
  /** Chemin lisible dans le document : « assistant.goal.primary.type ». */
  path: string;
  /** Le même, en segments — sert à retrouver la position dans le texte. */
  segments: (string | number)[];
  code: ImportIssueCode;
  /** Le message du schéma, gardé comme repli et pour les cas « other ». */
  raw: string;
  /** Ce que le schéma attendait, quand il sait le dire. */
  expected?: string;
  /** Le TYPE trouvé à la place (« string » là où un tableau était attendu). */
  received?: string;
  /**
   * La VALEUR trouvée dans le document, telle quelle.
   *
   * Distincte du type : « type tableau attendu, chaîne trouvée » et « le
   * fichier dit "get_slots,stop" » répondent à deux questions différentes, et
   * écraser l'une avec l'autre produisait « tableau attendu, get_slots,stop
   * trouvé » — une phrase qui ne veut rien dire.
   */
  value?: string;
  /** Les valeurs permises — c'est ce qui rend une erreur d'énumération réparable. */
  options?: string[];
  /**
   * La borne franchie. « Valeur trop grande » n'apprend rien ; « maximum : 5 »
   * se corrige sans ouvrir la documentation.
   */
  limit?: number;
  /** Ligne (1-based) dans le fichier téléversé, quand le texte est connu. */
  line?: number;
  column?: number;
  /** Le champ tel que la référence le nomme, dans la langue de l'écran. */
  field?: { label: string; what?: string };
}

/** Une objection de schéma, réduite à ce dont on a besoin (pas de zod ici). */
export interface RawSchemaIssue {
  path: (string | number | symbol)[];
  message: string;
  code?: string;
  expected?: string;
  values?: unknown[];
  options?: unknown[];
  minimum?: number | bigint;
  maximum?: number | bigint;
  origin?: string;
}

// ── Chemins ──────────────────────────────────────────────────────────────────

/**
 * « guardrails[0].kind » plutôt que « guardrails.0.kind » : c'est la forme
 * qu'on relit dans un éditeur de JSON, et celle que la documentation emploie.
 */
/**
 * Le document lui-même, quand l'objection ne porte sur aucun champ.
 *
 * `$` et non « (racine) » : ce chemin s'affiche tel quel dans l'interface, et
 * un mot français au milieu d'un écran anglais était une fuite de langue. `$`
 * est la racine en JSONPath — il ne se traduit pas, et le panneau lui substitue
 * un libellé lisible.
 */
export const ROOT_PATH = "$";

export function formatPath(segments: (string | number)[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? segment : `.${segment}`;
  }
  return out === "" ? ROOT_PATH : out;
}

// ── Normalisation ────────────────────────────────────────────────────────────

function asStrings(values: unknown[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  return values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
}

/**
 * Le mot « received » de zod dit « undefined » pour un champ absent — vrai,
 * mais ce n'est pas ce que la personne a devant les yeux : elle n'a rien
 * écrit du tout. « Il manque » et « mauvais type » se réparent différemment,
 * d'où deux catégories.
 */
function classify(issue: RawSchemaIssue): ImportIssueCode {
  const received = receivedOf(issue);
  if (issue.code === "invalid_type") {
    // `null` n'est PAS « absent » : la clé est là, on la voit dans le fichier.
    // Les confondre donnait une ligne qui se contredisait elle-même — « ce
    // champ est absent » juste au-dessus de « trouvé dans le fichier : null ».
    return received === "undefined" ? "missing" : "wrong_type";
  }
  if (issue.code === "invalid_value" || issue.code === "invalid_enum_value") return "not_allowed";
  // Une union discriminée (le déclencheur d'une campagne) tombait dans
  // « other », et « other » affiche le message brut de zod — en anglais, au
  // milieu d'un panneau français.
  if (issue.code === "invalid_union") return "not_allowed";
  if (issue.code === "invalid_format" || issue.code === "invalid_string") return "wrong_format";
  if (issue.code === "too_small") return "too_small";
  if (issue.code === "too_big") return "too_big";
  if (issue.code === "unrecognized_keys") return "not_allowed";
  return "other";
}

/** Les bornes arrivent parfois en `bigint` : on ne rend que ce qui s'affiche. */
function numberOr(value: number | bigint | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

/** zod 4 ne met plus « received » dans l'objet : il est dans le message. */
function receivedOf(issue: RawSchemaIssue): string | undefined {
  const match = /received (\w+)/.exec(issue.message);
  return match?.[1];
}

export function normalizeIssues(issues: readonly RawSchemaIssue[]): ImportIssue[] {
  return issues.map((issue) => {
    const segments = issue.path.filter(
      (s): s is string | number => typeof s === "string" || typeof s === "number",
    );
    const options = asStrings(issue.values ?? issue.options);
    return {
      path: formatPath(segments),
      segments,
      code: classify(issue),
      raw: issue.message,
      expected: issue.expected,
      received: receivedOf(issue),
      // Une seule valeur permise n'est pas un choix : c'est un littéral
      // (« format »), et on le dit comme tel plutôt qu'en liste d'une option.
      options: options && options.length > 1 ? options : undefined,
      limit: numberOr(issue.maximum) ?? numberOr(issue.minimum),
      ...(options && options.length === 1 ? { expected: options[0] } : {}),
    };
  });
}

// ── Position dans le fichier ─────────────────────────────────────────────────

export interface JsonPosition {
  line: number;
  column: number;
}

/**
 * Où se trouve chaque chemin dans le TEXTE du fichier.
 *
 * Un chemin (« assistant.goal.primary.type ») ne sert que si on peut aller le
 * corriger ; sur quatre cents lignes, il faut le numéro de ligne. On repère
 * donc la position de la CLÉ, pas celle de la valeur : c'est la clé qu'on
 * cherche des yeux, et pour un champ manquant c'est la seule chose qui existe
 * (on rend alors la position de l'objet parent).
 *
 * Le scanner est TOTAL : sur une entrée inattendue il s'arrête et rend ce
 * qu'il a. Un diagnostic incomplet reste utile ; une exception dans le code
 * qui explique une erreur ne l'est pas.
 */
export interface JsonScan {
  positions: Map<string, JsonPosition>;
  /**
   * Faux quand le scan s'est arrêté avant la fin (document énorme, imbrication
   * absurde). Ce qui suit n'a PAS été relevé — et « pas relevé » ne doit
   * surtout pas se confondre avec « absent du fichier ».
   */
  complete: boolean;
}

/** Les échappements JSON, décodés : la CLÉ doit être celle que zod nomme. */
const STRING_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Un document légitime tient en une dizaine de niveaux ; 200 est déjà absurde. */
const MAX_DEPTH = 200;
const MAX_NODES = 500_000;

export function scanJson(text: string): JsonScan {
  const out = new Map<string, JsonPosition>();
  let i = 0;
  let complete = true;

  /**
   * Les débuts de ligne, relevés UNE fois.
   *
   * Recompter depuis le début à chaque clé coûtait le carré de la taille du
   * fichier : sur un export de quelques mégaoctets, l'onglet se figeait le
   * temps d'expliquer une virgule mal placée. Ici : un passage linéaire, puis
   * une recherche dichotomique par position.
   */
  const lineStarts: number[] = [0];
  for (let k = 0; k < text.length; k += 1) if (text[k] === "\n") lineStarts.push(k + 1);

  const positionAt = (offset: number): JsonPosition => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };

  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };

  /** Lit une chaîne JSON à partir du guillemet ouvrant. */
  const readString = (): string | null => {
    if (text[i] !== '"') return null;
    i += 1;
    let value = "";
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === "u") {
          const code = Number.parseInt(text.slice(i + 2, i + 6), 16);
          // Une clé écrite « assist\u0061nt » EST « assistant » pour zod : sans
          // la décoder, son chemin devenait introuvable et l'objection héritait
          // de la ligne d'un voisin.
          value += Number.isNaN(code) ? text.slice(i, i + 6) : String.fromCharCode(code);
          i += 6;
        } else {
          value += STRING_ESCAPES[next] ?? next;
          i += 2;
        }
        continue;
      }
      if (ch === '"') {
        i += 1;
        return value;
      }
      value += ch;
      i += 1;
    }
    return null;
  };

  /** Avale une valeur scalaire (nombre, booléen, null) sans l'interpréter. */
  const skipScalar = () => {
    while (i < text.length && !/[,}\]\s]/.test(text[i])) i += 1;
  };

  let guard = 0;
  const parseValue = (segments: (string | number)[], depth: number): boolean => {
    // Deux freins pour deux dangers : le NOMBRE de nœuds (un fichier immense)
    // et la PROFONDEUR — « [[[[…6000…]]]] » faisait déborder la pile et lever
    // le diagnostic lui-même, ce qui est le comble.
    guard += 1;
    if (guard > MAX_NODES || depth > MAX_DEPTH) {
      complete = false;
      return false;
    }

    skipWs();
    const ch = text[i];

    if (ch === "{") {
      i += 1;
      for (;;) {
        skipWs();
        if (text[i] === "}") {
          i += 1;
          return true;
        }
        const keyOffset = i;
        const key = readString();
        if (key === null) return false;
        const child = [...segments, key];
        out.set(formatPath(child), positionAt(keyOffset));
        skipWs();
        if (text[i] !== ":") return false;
        i += 1;
        if (!parseValue(child, depth + 1)) return false;
        skipWs();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return true;
        }
        return false;
      }
    }

    if (ch === "[") {
      i += 1;
      let index = 0;
      for (;;) {
        skipWs();
        if (text[i] === "]") {
          i += 1;
          return true;
        }
        const child = [...segments, index];
        // Un élément de tableau n'a pas de clé : on pointe la valeur.
        out.set(formatPath(child), positionAt(i));
        if (!parseValue(child, depth + 1)) return false;
        index += 1;
        skipWs();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return true;
        }
        return false;
      }
    }

    if (ch === '"') return readString() !== null;
    if (i >= text.length) return false;
    skipScalar();
    return true;
  };

  skipWs();
  out.set(ROOT_PATH, positionAt(i));
  parseValue([], 0);
  return { positions: out, complete };
}

/** Les positions seules — le cas courant, et ce que lisent les tests. */
export function jsonPositions(text: string): Map<string, JsonPosition> {
  return scanJson(text).positions;
}

/**
 * Attache à chaque objection l'endroit où aller la corriger.
 *
 * Un champ ABSENT n'a évidemment pas de position : on remonte alors au parent
 * le plus proche qui existe, parce que c'est là qu'il faut écrire la ligne
 * manquante.
 */
export function locateIssues(issues: ImportIssue[], text: string): ImportIssue[] {
  const { positions, complete } = scanJson(text);
  return issues.map((issue) => {
    const exact = positions.get(issue.path);
    if (exact) return { ...issue, line: exact.line, column: exact.column };
    // Scan tronqué : ce chemin n'a peut-être jamais été relevé. Remonter au
    // parent renverrait vers une ligne sans rapport, des milliers de lignes
    // plus haut — pire que pas de ligne du tout.
    if (!complete) return issue;
    for (let depth = issue.segments.length - 1; depth >= 0; depth -= 1) {
      const at = positions.get(formatPath(issue.segments.slice(0, depth)));
      if (at) return { ...issue, line: at.line, column: at.column };
    }
    return issue;
  });
}

// ── Erreur de syntaxe ────────────────────────────────────────────────────────

export interface JsonSyntaxProblem {
  /** Absents quand le moteur n'a pas su dire OÙ — mieux vaut se taire. */
  line?: number;
  column?: number;
  /** La ligne fautive, telle quelle (indentation comprise). */
  excerpt: string;
  raw: string;
}

/**
 * Un JSON qui ne se lit même pas : virgule en trop, guillemet oublié.
 *
 * `JSON.parse` donne un décalage dans son message ; seul, il n'aide pas — on
 * le rend en ligne/colonne avec la ligne fautive, ce qu'un éditeur affiche.
 */
/**
 * Où V8 dit que ça coince — il le dit de trois façons, ou pas du tout.
 *
 *  1. « … at position 21 (line 3 column 10) » : la réponse, telle quelle.
 *  2. « … at position 13 » : un décalage, qu'on convertit.
 *  3. « Unexpected token \']\', ..."  "a",\n  ]\n}" is not valid JSON » : AUCUNE
 *     position — et c'est la forme que produisent justement la virgule en trop
 *     et le guillemet simple, les deux fautes les plus courantes à la main. On
 *     retrouve alors l'extrait cité dans le texte.
 *
 * Quand rien ne marche, on ne rend PAS de position : annoncer « ligne 1 »
 * envoie chercher au mauvais endroit, ce qui est pire que ne rien dire.
 */
function locateSyntaxError(text: string, raw: string): number | null {
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(raw);
  if (lineColumn) {
    const lines = text.split("\n");
    const line = Number(lineColumn[1]);
    if (line >= 1 && line <= lines.length) {
      const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
      return start + Number(lineColumn[2]) - 1;
    }
  }

  const position = /position (\d+)/.exec(raw);
  if (position) return Math.min(Number(position[1]), Math.max(text.length - 1, 0));

  // « Unexpected token ']', ..."…extrait…"... is not valid JSON » : pas de
  // position du tout. L'extrait est cité TEL QUEL (vrais retours à la ligne,
  // guillemets non échappés), donc on le retrouve dans le texte — puis on vise
  // le jeton nommé À L'INTÉRIEUR, qui est le caractère exactement fautif.
  const quoted = /"([\s\S]*)"(?:\.\.\.)? is not valid JSON/.exec(raw);
  if (!quoted) return null;

  const snippet = quoted[1].replace(/^\.\.\./, "");
  if (snippet.length < 2) return null;
  const start = text.indexOf(snippet);
  if (start === -1) return null;

  const token = /Unexpected token .(.)./.exec(raw)?.[1];
  const inside = token ? snippet.indexOf(token) : -1;
  return start + (inside >= 0 ? inside : 0);
}

export function describeJsonSyntaxError(text: string, error: unknown): JsonSyntaxProblem {
  const raw = error instanceof Error ? error.message : String(error);
  const offset = locateSyntaxError(text, raw);
  if (offset === null) return { excerpt: "", raw };

  const lineStart = text.lastIndexOf("\n", Math.max(offset - 1, 0)) + 1;
  const lineEnd = text.indexOf("\n", lineStart);
  return {
    line: text.slice(0, lineStart).split("\n").length,
    column: offset - lineStart + 1,
    // PAS de `trim()` : la colonne se compte depuis le début de la ligne, et
    // rogner l'indentation ferait pointer le curseur à côté.
    excerpt: text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).slice(0, 200),
    raw,
  };
}

// ── Enrichissement ───────────────────────────────────────────────────────────

/** Ce que la référence sait dire d'un champ, dans la langue de l'écran. */
export interface FieldGloss {
  label: string;
  what?: string;
}

/**
 * Nomme les champs fautifs.
 *
 * « assistant.approach.persistence » ne dit rien à qui n'a pas écrit le
 * schéma ; « Persistance » et sa phrase d'explication, si. Le registre est
 * injecté plutôt qu'importé : ce module reste pur, et l'appelant décide s'il
 * regarde la référence des assistants ou celle des campagnes.
 */
export function glossIssues(
  issues: ImportIssue[],
  lookup: (path: string) => FieldGloss | undefined,
): ImportIssue[] {
  return issues.map((issue) => {
    // Un chemin concret (« goal.fallbacks[0].type ») partage la fiche du
    // gabarit (« goal.fallbacks[].type ») : les documenter un par un
    // n'apprendrait rien de plus.
    const field = lookup(issue.path) ?? lookup(issue.path.replace(/\[\d+\]/g, "[]"));
    return field ? { ...issue, field } : issue;
  });
}

/** Une valeur, réduite à ce qui tient sur une ligne. */
function preview(value: unknown): string {
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 60)}…` : value;
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * Ce que le fichier disait VRAIMENT à cet endroit.
 *
 * Le schéma dit « valeur refusée » sans jamais montrer la valeur : sur un
 * format qui ne correspond pas, savoir que le fichier annonce
 * « nexus.assistant/v2 » règle la question tout de suite.
 */
export function withReceivedValues(issues: ImportIssue[], document: unknown): ImportIssue[] {
  return issues.map((issue) => {
    let node: unknown = document;
    for (const segment of issue.segments) {
      if (node === null || typeof node !== "object") return issue;
      // Lecture par index/clé PROPRE : un document malicieux ne doit pas faire
      // remonter « constructor » ou « __proto__ » dans un message d'erreur.
      if (!Object.hasOwn(node as object, segment)) return issue;
      node = (node as Record<string | number, unknown>)[segment];
    }
    if (node === undefined) return issue;
    return { ...issue, value: preview(node) };
  });
}
