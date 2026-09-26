/**
 * Unitaire — recherche de clients : le STATEMENT (§3.3), rendu sans base.
 *
 * Ce que ces tests protègent : le texte tapé ne devient JAMAIS du SQL (tout
 * motif est un paramètre lié), aucune source interdite n'est lue, et une CTE
 * d'historique n'existe que si la case qui l'ouvre existe quelque part. Un
 * `cm` généré pour un regard sans `history` serait une fuite même si toutes
 * les lignes étaient ensuite masquées : ce qu'on ne lit pas ne fuit pas.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { planSearch, regexStrings } from "@/lib/clients-search/plan";
import { parseSearchQuery } from "@/lib/clients-search/query";
import { LEVELS } from "@/lib/clients-search/score";
import { MASK_COLUMNS, type SearchMode } from "@/lib/clients-search/types";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

const { buildSearchStatement, historyCtes } = await import("@/lib/clients-search-server/statement");
const { clients } = await import("@/db/schema");

type Scope = { kind: "all" } | { kind: "none" } | { kind: "some"; pool: boolean; ids: string[] };
const ALL: Scope = { kind: "all" };
const NONE: Scope = { kind: "none" };
const SOME: Scope = { kind: "some", pool: true, ids: ["11111111-1111-4111-8111-111111111111"] };

const dialect = new PgDialect();

function render(
  q: string,
  opts: {
    mode?: SearchMode;
    fuzzy?: boolean;
    contact?: Scope;
    history?: Scope;
    thread?: Scope;
    deep?: boolean;
    limit?: number;
    offset?: number;
    sort?: "relevance" | "activity" | "name" | "city";
    dir?: "asc" | "desc";
    /** `null` = aucun filtre ni visibilité (l'administrateur, sans filtre). */
    where?: null;
  } = {},
) {
  const mode = opts.mode ?? "all";
  const plan = planSearch(parseSearchQuery(q), { mode, fuzzy: opts.fuzzy });
  const history = opts.history ?? (mode === "all" ? ALL : NONE);
  const stmt = buildSearchStatement({
    plan,
    where: opts.where === null ? undefined : sql`${clients.categoryId} = ${7}`,
    contact: opts.contact ?? ALL,
    history,
    thread: opts.thread ?? history,
    deep: opts.deep ?? true,
    sort: opts.sort ?? "relevance",
    dir: opts.dir ?? "desc",
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
    now: new Date("2026-09-26T12:00:00.000Z"),
  });
  return { plan, ...dialect.sqlToQuery(stmt) };
}

const CTE = (name: string) => new RegExp(`\\b${name} as \\(`);

const QUERIES = [
  "zorglub",
  "Hélène Côté",
  '"trois rivieres" -laval',
  "50% a_b",
  "o'brien",
  "(418) 476-1542",
  "tremblay 514",
  "jean@exemple.com",
  "G1V 4M3",
  "note:piscine ville:lévis",
  "dans:notes cabanon",
  "st-foy",
  "trembly",
];

describe("le texte tapé n'est jamais du SQL", () => {
  it.each(QUERIES)("%s", (q) => {
    for (const fuzzy of [false, true]) {
      const { plan, sql: text, params } = render(q, { fuzzy });
      // Chaque motif, chaque valeur : dans les paramètres, jamais dans le texte.
      for (const p of regexStrings(plan)) {
        expect(params, p).toContain(p);
        expect(text.includes(p), p).toBe(false);
      }
      for (const t of plan.terms) {
        expect(text.toLowerCase().includes(t.value.toLowerCase()), t.value).toBe(false);
        for (const c of t.columns) {
          for (const e of plan.columns[c].entries.filter((x) => x.term === t.index)) {
            const v = e.op === "regex" || e.op === "like" ? e.pattern : e.value;
            expect(params, `${c} ${v}`).toContain(v);
          }
        }
      }
    }
  });

  it("aucun `<<` : les masques se construisent par multiplication", () => {
    for (const q of QUERIES) expect(render(q).sql).not.toContain("<<");
  });

  it("limit et offset sont des paramètres", () => {
    const { sql: text, params } = render("zorglub", { limit: 37, offset: 12345 });
    expect(params).toContain(37);
    expect(params).toContain(12345);
    expect(text).not.toContain("12345");
    expect(text).toMatch(/limit \$\d+::int offset \$\d+::int/);
  });

  it("les seuils de fraîcheur sont liés en timestamptz", () => {
    const { sql: text, params } = render("piscine");
    expect(params).toContain("2026-08-27T12:00:00.000Z");
    expect(params).toContain("2026-03-30T12:00:00.000Z");
    expect(text).toMatch(/hist_at >= \$\d+::timestamptz/);
  });
});

describe("sources interdites", () => {
  it.each(QUERIES)("%s ne lit ni meta, ni qualification, ni transcriptions, ni rendez-vous, ni numéros d'appel", (q) => {
    const { sql: text } = render(q, { fuzzy: true });
    for (const banned of ["meta", "qualification", "call_transcripts", "appointments", "client_phone", "from_number", "to_number", "audit_logs", "notifications"]) {
      expect(text, banned).not.toMatch(new RegExp(`\\b${banned}\\b`));
    }
  });

  it("les colonnes typées (`\"clients\".…`) ne vivent que dans `vis`", () => {
    const { sql: text } = render("tremblay piscine", { contact: SOME, history: SOME });
    const visStart = text.indexOf("vis as materialized (");
    // La CTE suivante (historique ou `hit`) ferme `vis`.
    const visEnd = Math.min(...["cm as (", "hit as ("].map((n) => text.indexOf(n)).filter((i) => i > visStart));
    const typed = [...text.matchAll(/"clients"\./g)].map((m) => m.index ?? 0);
    expect(typed.length).toBeGreaterThan(0);
    for (const at of typed) {
      expect(at).toBeGreaterThan(visStart);
      expect(at).toBeLessThan(visEnd);
    }
  });
});

describe("les CTE d'historique suivent les cases", () => {
  it("history = none → ni cm, ni fu, ni ca, ni sm", () => {
    const { sql: text } = render("piscine", { history: NONE, thread: NONE });
    for (const cte of ["cm", "fu", "ca", "sm"]) expect(text).not.toMatch(CTE(cte));
    expect(text).toMatch(/false history_ok/);
  });

  it("sans conversations.view (thread = none) → pas de sm, le reste oui", () => {
    const { sql: text } = render("piscine", { history: ALL, thread: NONE });
    for (const cte of ["cm", "fu", "ca"]) expect(text).toMatch(CTE(cte));
    expect(text).not.toMatch(CTE("sm"));
    expect(text).not.toMatch(/\bmessages\b/);
    expect(text).toMatch(/false thread_ok/);
  });

  it("tout ouvert → les quatre ; SMS : entrants et écrits à la main seulement", () => {
    const { sql: text } = render("piscine");
    for (const cte of ["cm", "fu", "ca", "sm"]) expect(text).toMatch(CTE(cte));
    expect(text).toContain("(s.direction = 'in' or s.source = 'human')");
  });

  it("identity → aucune CTE d'historique, facettes nulles", () => {
    const { sql: text } = render("piscine", { mode: "identity", history: NONE, thread: NONE });
    for (const cte of ["cm", "fu", "ca", "sm"]) expect(text).not.toMatch(CTE(cte));
    expect(text).toContain("null::int n_all");
    expect(text).not.toMatch(/\bcomments\b/);
  });

  it("repli « fiche seule » (deep = false) → aucune CTE d'historique", () => {
    const { sql: text } = render("piscine", { deep: false });
    for (const cte of ["cm", "fu", "ca", "sm"]) expect(text).not.toMatch(CTE(cte));
  });

  it("un terme court (≤ 2 lettres) ne génère aucune CTE d'historique", () => {
    const { sql: text } = render("bo");
    for (const cte of ["cm", "fu", "ca", "sm"]) expect(text).not.toMatch(CTE(cte));
  });

  it("opérateur commentaire: → seulement cm", () => {
    const { sql: text } = render("commentaire:piscine");
    expect(text).toMatch(CTE("cm"));
    for (const cte of ["fu", "ca", "sm"]) expect(text).not.toMatch(CTE(cte));
  });

  // Le fil SMS s'ouvre sous la case `history` (la portée `thread` EST la
  // portée `history`, plus un droit). Quand `sm` est la seule CTE, la page
  // doit quand même rendre `history_ok` : sinon la seconde garde (`mapRow`)
  // jette la raison et l'extrait d'une fiche que le SMS a bel et bien trouvée.
  it.each(["sms:veranda", "texto:veranda"])("%s → seulement sm, et `history_ok` reste la vraie case", (q) => {
    const { sql: text } = render(q, { history: SOME, thread: SOME });
    expect(text).toMatch(CTE("sm"));
    for (const cte of ["cm", "fu", "ca"]) expect(text).not.toMatch(CTE(cte));
    expect(text).not.toMatch(/false history_ok/);
    expect(text).not.toMatch(/false thread_ok/);
  });

  it("historyCtes dit la même chose", () => {
    const plan = planSearch(parseSearchQuery("piscine"), { mode: "all" });
    expect(historyCtes({ plan, history: ALL, thread: ALL, deep: true })).toEqual(["com_m", "fup_m", "call_m", "sms_m"]);
    expect(historyCtes({ plan, history: ALL, thread: NONE, deep: true })).toEqual(["com_m", "fup_m", "call_m"]);
    expect(historyCtes({ plan, history: NONE, thread: NONE, deep: true })).toEqual([]);
    expect(historyCtes({ plan, history: ALL, thread: ALL, deep: false })).toEqual([]);
  });

  it("coordonnées fermées partout → colonnes téléphone et courriel constantes, sans paramètre", () => {
    const { sql: text, params } = render("4184761542", { contact: NONE });
    for (const c of ["ph_x", "ph_s", "ph_i", "ph_p", "em_x", "em_p", "em_i", "em_t"]) {
      expect(text).toMatch(new RegExp(`\\b0 ${c}\\b`));
    }
    expect(params).not.toContain("%4184761542%");
    expect(text).toMatch(/false contact_ok/);
    expect(render("tremblay 514", { contact: NONE }).params).not.toContain("+1514%");
  });
});

// Le nettoyage d'un commentaire (en-tête IA, mentions) coûtait plus cher que la
// recherche elle-même : il tournait sur CHAQUE commentaire de la table, fiches
// invisibles comprises, avec un groupe de capture (le chemin lent des regex de
// Postgres). Mesuré : ×2,4 à ×5 sur une recherche profonde (revue F4).
describe("commentaires : le nettoyage ne tourne que là où il peut changer le résultat", () => {
  const cteOf = (text: string, name: string) => {
    const start = text.search(CTE(name));
    expect(start, name).toBeGreaterThanOrEqual(0);
    const next = text.slice(start + 1).search(/\b(?:cm|fu|ca|sm|hit) as \(/);
    return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  };

  it("aucun groupe de capture : une mention se réécrit par `replace` puis une regex sans `\\1`", () => {
    const { sql: text } = render("piscine");
    expect(text).not.toMatch(/\\1/);
    expect(cteOf(text, "cm")).toContain("replace(");
  });

  it("le texte BRUT filtre d'abord ; seul un commentaire à mention passe sans lui ; le nettoyé tranche ensuite", () => {
    const { plan, sql: text, params } = render("piscine");
    const cm = cteOf(text, "cm");
    const raw = cm.match(/where strpos\(c\.body, '@\['\) > 0 or c\.body ~\* \$(\d+)/);
    expect(raw, cm).not.toBeNull();
    expect(params[Number(raw![1]) - 1]).toBe(plan.columns.com_m.any);
    const clean = cm.match(/where not c\.dirty or c\.h ~\* \$(\d+)/);
    expect(clean, cm).not.toBeNull();
    expect(params[Number(clean![1]) - 1]).toBe(plan.columns.com_m.any);
    // Le nettoyage (regexp_replace) vit APRÈS le préfiltre brut : dans la
    // sous-requête que ce préfiltre filtre.
    const cleanupAt = cm.indexOf("regexp_replace(");
    expect(cleanupAt).toBeGreaterThan(0);
    expect(cm.indexOf("where strpos(c.body, '@[')")).toBeGreaterThan(cleanupAt);
  });

  it("un seul terme : le masque d'une trace est son bit (le filtre l'a déjà prouvé), pas une regex de plus", () => {
    const one = cteOf(render("piscine").sql, "cm");
    expect(one).toMatch(/select c\.id, c\.client_id, c\.at, 1 m\b/);
    const two = cteOf(render("piscine garage").sql, "cm");
    expect(two).not.toMatch(/c\.at, 1 m\b/);
    expect(two).toMatch(/c\.h ~\* \$\d+\)::int \* 1\)/);
  });

  it("portée partielle (ou filtres) : les fiches VISIBLES d'abord, derrière une barrière ; tout voir sans filtre : pas de détour", () => {
    for (const [name, ok] of [["cm", "history_ok"], ["fu", "history_ok"], ["ca", "history_ok"], ["sm", "thread_ok"]] as const) {
      const some = cteOf(render("piscine", { history: SOME, thread: SOME }).sql, name);
      expect(some, name).toMatch(new RegExp(`in \\(select v\\.id from vis v where v\\.${ok}\\) offset 0\\)`));
      // Tout ouvert mais des filtres (catégorie…) : `vis` est déjà petite.
      const filtered = cteOf(render("piscine").sql, name);
      expect(filtered, name).toMatch(/in \(select v\.id from vis v where/);
      const everything = cteOf(render("piscine", { where: null }).sql, name);
      expect(everything, name).not.toMatch(/in \(select v\.id from vis v/);
    }
  });
});

describe("bonus « toute l'adresse » (numéro civique compris)", () => {
  it("le drapeau lit l'adresse ET la ville, coupés ; il entre au score et remonte à la page", () => {
    const { sql: text } = render("412 rue tremblay");
    expect(text).toMatch(
      /\(\(\(f\.city_x \| f\.city_w \| f\.city_i \| f\.city_f \| f\.addr_pc \| f\.addr_m\) & 7\) = 7\) same_address/,
    );
    expect(text).toMatch(/case when s\.same_address then 120 else 0 end/);
    expect(text).toContain("pg.same_address");
  });

  it("sans numéro civique (ou avec un seul terme) : constante `false`, aucun point", () => {
    for (const q of ["tremblay laval", "412", "tremblay 4184761542"]) {
      const { sql: text } = render(q);
      expect(text, q).toMatch(/false same_address/);
      expect(text, q).not.toMatch(/s\.same_address then/);
      expect(text, q).toContain("pg.same_address");
    }
  });
});

describe("chaque colonne du barème est rendue quand son terme y a droit", () => {
  it.each(["tremblay", "trembly", "4761542", "4184761542", "jean@x.com", "g1v 4m3", '"trois rivieres"', "ab"])("%s", (q) => {
    for (const fuzzy of [false, true]) {
      const { plan, sql: text } = render(q, { fuzzy });
      for (const row of LEVELS) {
        const col = plan.columns[row.column];
        const constant = new RegExp(`\\b0 ${row.column}\\b`);
        if (col.entries.length > 0) expect(text, `${q} ${row.column}`).not.toMatch(constant);
        else expect(text, `${q} ${row.column}`).toMatch(constant);
      }
      // Et chaque colonne est relue jusqu'à la page.
      for (const c of MASK_COLUMNS) expect(text).toContain(`pg.${c}`);
    }
  });
});

describe("tri", () => {
  it("pertinence, activité, colonne — toujours `id` en dernier", () => {
    expect(render("x1x", { sort: "relevance" }).sql).toMatch(/order by p\.score desc, p\.act desc, p\.id asc$/);
    expect(render("x1x", { sort: "activity" }).sql).toMatch(/order by p\.act desc, p\.id asc$/);
    expect(render("x1x", { sort: "name", dir: "asc" }).sql).toMatch(/order by p\.s_name asc, p\.id asc$/);
    expect(render("x1x", { sort: "city", dir: "desc" }).sql).toMatch(/order by p\.s_city desc nulls last, p\.id asc$/);
  });
});

it("aucun terme positif → aucune requête à écrire", () => {
  const plan = planSearch(parseSearchQuery("-rosemont"), { mode: "all" });
  expect(() =>
    buildSearchStatement({
      plan,
      where: undefined,
      contact: ALL,
      history: ALL,
      thread: ALL,
      deep: true,
      sort: "relevance",
      dir: "desc",
      limit: 10,
      offset: 0,
      now: new Date(),
    }),
  ).toThrow();
});
