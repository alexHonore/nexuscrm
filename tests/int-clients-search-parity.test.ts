/**
 * Intégration — recherche de clients : PARITÉ des motifs entre Postgres et JS.
 *
 * La même chaîne filtre en SQL (`texte ~* motif`) et surligne en JS
 * (`new RegExp(motif, "iu")`). Si les deux moteurs divergeaient, une fiche
 * remonterait sans que rien n'y soit surligné — ou l'inverse. On vérifie donc,
 * pour chaque cas de la matrice §7.1 : Postgres (collation de la base), puis
 * Postgres en `COLLATE "C"` (celle d'une base de production inconnue), puis
 * JS — les trois doivent rendre la valeur attendue.
 *
 * Aucune table : seulement des `select $1 ~* $2`. Et, en bonus, l'expression
 * SQL qui nettoie un commentaire (`COMMENT_TEXT`) contre `normalizeStoredBody`.
 */
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDb, sqlRaw, testDb } from "./helpers/db";
import { foldSearch } from "@/lib/clients-search/fold";
import {
  digitsPattern,
  emailPattern,
  exactNamePattern,
  fuzzyPattern,
  phraseNamePattern,
  postalPattern,
  startNamePattern,
  textLevels,
  type TextLevels,
} from "@/lib/clients-search/pattern";
import { normalizeStoredBody } from "@/lib/clients-search/snippet";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

const { COMMENT_TEXT } = await import("@/lib/clients-search-server/statement");

afterAll(async () => {
  await closeDb();
});

function levels(typed: string, kind: "text" | "phrase" = "text"): TextLevels {
  const lv = textLevels(foldSearch(typed), kind);
  if (!lv) throw new Error(`aucun motif pour ${typed}`);
  return lv;
}

type Case = { label: string; pattern: string; text: string; expected: boolean };
const cases: Case[] = [];
const add = (label: string, pattern: string, text: string, expected: boolean) =>
  cases.push({ label, pattern, text, expected });

// ── La matrice §7.1 ──────────────────────────────────────────────────────────
for (const typed of ["HELENE", "helene", "Hélène", "hélene"]) {
  for (const stored of ["Hélène", "HÉLÈNE", "helene", "Marie-Hélène Roy"]) {
    add(`${typed} → ${stored}`, levels(typed).infix, stored, true);
  }
}
add("cote → Côté", levels("cote").whole, "Côté", true);
add("côté → Cote", levels("côté").whole, "Cote", true);
add("COTE → CÔTÉ", levels("COTE").whole, "CÔTÉ", true);
add("coeur → Cœur", levels("coeur").whole, "Cœur", true);
add("coeur → CŒUR", levels("coeur").whole, "CŒUR", true);
add("cœur → coeur", levels("cœur").whole, "coeur", true);
add("noel → Noël", levels("noel").whole, "Noël", true);
add("raphael → Raphaël", levels("raphael").whole, "Raphaël", true);
add("l'ile → L’Île-Perrot", levels("l'ile").infix, "L’Île-Perrot", true);
add("l’île (début) → L’Île-Perrot", levels("l’île").wordStart, "L’Île-Perrot", true);
add("« l ile » → L’Île-Perrot", levels("l ile", "phrase").infix, "L’Île-Perrot", true);
add("ile-perrot (entier) → L’Île-Perrot", levels("ile-perrot").whole, "L’Île-Perrot", true);
add("« trois rivieres » → Trois-Rivières", levels("trois rivieres", "phrase").whole, "Trois-Rivières", true);
add("trois-rivieres → Trois-Rivières", levels("trois-rivieres").whole, "Trois-Rivières", true);
add("rivi (infixe) → Trois-Rivières", levels("rivi").infix, "Trois-Rivières", true);
add("rivi (début) → Trois-Rivières", levels("rivi").wordStart, "Trois-Rivières", true);
add("rivi (entier) ↛ Trois-Rivières", levels("rivi").whole, "Trois-Rivières", false);
for (const stored of ["Sainte-Foy", "Ste-Foy", "STE FOY", "Ste. Foy"]) {
  add(`st-foy → ${stored}`, levels("st-foy").whole, stored, true);
  add(`« ste foy » → ${stored}`, levels("ste foy", "phrase").whole, stored, true);
  add(`saintefoy → ${stored}`, levels("saintefoy").infix, stored, true);
}
add("ste-jean ↛ Saint-Jean", levels("ste-jean").infix, "Saint-Jean", false);
add("st-jean → Saint-Jean", levels("st-jean").infix, "Saint-Jean", true);
{
  const lv = levels("st");
  for (const [name, p] of Object.entries({ infix: lv.infix, wordStart: lv.wordStart, whole: lv.whole })) {
    add(`st (${name}) ↛ Christine`, p, "Christine", false);
    add(`st (${name}) ↛ Stéphane`, p, "Stéphane", false);
    add(`st (${name}) → St-Hubert`, p, "St-Hubert", true);
    add(`st (${name}) → Saint-Hubert`, p, "Saint-Hubert", true);
  }
}
add("marc (entier) → Marc-André", levels("marc").whole, "Marc-André Roy", true);
add("marc (entier) ↛ Marcel", levels("marc").whole, "Marcel Roy", false);
add("marc (début) → Marcel", levels("marc").wordStart, "Marcel Roy", true);
add("marc (début) ↛ Lamarche", levels("marc").wordStart, "Lamarche", false);
add("lise (début) ↛ Élise", levels("lise").wordStart, "Élise", false);
add("elise (début) → Élise", levels("elise").wordStart, "Élise", true);
add("mile (entier) ↛ Émile", levels("mile").whole, "Émile", false);
add("re (texte) ↛ Tremblay", levels("re").text, "Tremblay", false);
add("re (texte) → Renée", levels("re").text, "Renée", true);

// ── Littéraux ────────────────────────────────────────────────────────────────
add("a.b → a b", levels("a.b").infix, "a b", true);
add("a.b ↛ axb", levels("a.b").infix, "axb", false);
add("50% → 50% comptant", levels("50%").infix, "50% comptant", true);
add("50% ↛ 500 comptant", levels("50%").infix, "500 comptant", false);
add("a_b ↛ axb", levels("a_b").infix, "axb", false);
add("a(b → a(b", levels("a(b").infix, "a(b", true);
add("x[y → x[y", levels("x[y").infix, "x[y", true);
add("a* ↛ aaa", levels("a*").infix, "aaa", false);
add("vide ↛ ''", levels("tremblay").infix, "", false);

// ── Chiffres, courriel, postal ───────────────────────────────────────────────
add("650000 → 650 000 $", digitsPattern("650000"), "Budget : 650 000 $", true);
add("650000 → 650 NBSP 000 $", digitsPattern("650000"), "Budget : 650 000 $", true);
add("650000 → 650 NNBSP 000 $", digitsPattern("650000"), "Budget : 650 000 $", true);
add("650000 ↛ 650 / 000", digitsPattern("650000"), "650 / 000", false);
add("numéro écrit à la main", digitsPattern("4184761542"), "rappeler au (418) 476-1542 svp", true);
add("412 → 412 rue Tremblay", digitsPattern("412"), "412 rue Tremblay", true);
add("412 → 412B", digitsPattern("412"), "412B rue Tremblay", true);
add("412 → « 3, 412 rue »", digitsPattern("412"), "app. 3, 412 rue X", true);
add("412 ↛ 6412 rue Bédard", digitsPattern("412"), "6412 rue Bédard", false);
add("412 ↛ 4127", digitsPattern("412"), "4127 boul. Laurier", false);
add("4184761542 → +14184761542", digitsPattern("4184761542"), "+14184761542", true);
add("4184761542 ↛ 41847615420", digitsPattern("4184761542"), "41847615420", false);
add("4761542 → fin de 4184761542", digitsPattern("4761542"), "rappeler au 4184761542", true);
add("courriel littéral", emailPattern("jean.roy@x.com"), "Courriel : Jean.Roy@X.com", true);
add("courriel ↛ jeanxroy", emailPattern("jean.roy@x.com"), "jeanxroy@x.com", false);
for (const s of ["G1V 4M3", "g1v4m3", "G1V-4M3", "Québec (Québec) G1V 4M3"]) {
  add(`postal → ${s}`, postalPattern("g1v4m3"), s, true);
}
add("postal ↛ G1V 4M4", postalPattern("g1v4m3"), "G1V 4M4", false);

// ── Bonus de nom ─────────────────────────────────────────────────────────────
add("exact → Jean Tremblay", exactNamePattern(["jean", "tremblay"])!, "Jean Tremblay", true);
add("exact → « TREMBLAY, Jean. »", exactNamePattern(["jean", "tremblay"])!, "  TREMBLAY, Jean. ", true);
add("exact ↛ Jean-Marc Tremblay", exactNamePattern(["jean", "tremblay"])!, "Jean-Marc Tremblay", false);
add("expression → Marie Jean Tremblay", phraseNamePattern(["jean", "tremblay"])!, "Marie Jean Tremblay", true);
add("expression ↛ Tremblay Jean", phraseNamePattern(["jean", "tremblay"])!, "Tremblay Jean", false);
add("début → Jean-Marc", startNamePattern("jean")!, "Jean-Marc Tremblay", true);
add("début ↛ Marc Jean", startNamePattern("jean")!, "Marc Jean", false);

// ── Flou ─────────────────────────────────────────────────────────────────────
for (const typed of ["trembly", "tremblai", "rtemblay", "tremblayy", "trenblay"]) {
  const fz = fuzzyPattern(foldSearch(typed))!;
  add(`flou ${typed} → Tremblay`, fz.pattern, "Jean Tremblay", true);
  add(`préfiltre ${typed} → Tremblay`, fz.prefilter, "Jean Tremblay", true);
}
add("flou ↛ Xtremblay", fuzzyPattern("trembly")!.pattern, "Xtremblay", false);
add("flou ↛ Trenbli (deux fautes)", fuzzyPattern("trembly")!.pattern, "Trenbli", false);

describe("motifs : Postgres = Postgres (C) = JS = attendu", () => {
  it(`${cases.length} cas`, async () => {
    const failures: string[] = [];
    for (const c of cases) {
      const [row] = await sqlRaw.unsafe<{ pg: boolean; pg_c: boolean }[]>(
        `select $1::text ~* $2::text pg, ($1::text collate "C") ~* $2::text pg_c`,
        [c.text, c.pattern],
      );
      const js = new RegExp(c.pattern, "iu").test(c.text);
      if (row.pg !== c.expected || row.pg_c !== c.expected || js !== c.expected) {
        failures.push(`${c.label} : pg=${row.pg} pg(C)=${row.pg_c} js=${js} attendu=${c.expected}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("COMMENT_TEXT (SQL) = normalizeStoredBody (TS)", () => {
  it.each([
    "Voir avec @[Josée Roy](0000cafe-0000-4000-8000-00000000beef) demain",
    "🤖 Notes d'appel (IA) — appel sortant du 3 septembre 2026, 14 h 05 (4 min 12 s)\n\nLa cliente veut une verrière.",
    "🤖 AI call notes — outbound call on September 3, 2026\n\nWants a sunroom.",
    "🤖 Assistant « Léa » : le client rappellera lundi",
    "Rendez-vous fixé — 3 octobre\n\nNotes : jumelé",
    "texte simple, sans rien",
    "@[A](11111111-2222-3333-4444-555555555555) et @[B](aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)",
    // La forme qu'écrit `toStoredBody` (nom sans crochets), partout où elle peut tomber.
    "@[Josée Roy](0000cafe-0000-4000-8000-00000000beef), demain",
    "(voir @[Marie-Ève O’Brien](0000CAFE-0000-4000-8000-00000000BEEF).)",
    "Fin de phrase avec @[Luc](11111111-2222-3333-4444-555555555555)",
    "Trois : @[A](11111111-2222-3333-4444-555555555555)@[B](aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee) @[C](aaaaaaaa-bbbb-cccc-dddd-000000000000)",
    "Ligne 1\n\n@[Josée](0000cafe-0000-4000-8000-00000000beef)\nLigne 3",
    "🤖 Notes d'appel (IA) — appel sortant du 3 septembre 2026\n\nVoir @[Luc](11111111-2222-3333-4444-555555555555) lundi.",
    "🤖 Assistant « Léa » : rappeler @[Josée](0000cafe-0000-4000-8000-00000000beef)",
    // Ni mention ni en-tête : rendu tel quel (aucun nettoyage n'a lieu).
    "courriel : jean@exemple.com [lien] (note)",
    "🤖 sans en-tête reconnu",
  ])("%s", async (body) => {
    const [row] = Array.from(
      await testDb.execute<{ h: string }>(sql`select ${COMMENT_TEXT} h from (select ${body}::text body) c`),
    );
    expect(row.h.replace(/\s+/g, " ").trim()).toBe(normalizeStoredBody(body).text);
  });
});
