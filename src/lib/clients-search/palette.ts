/**
 * Recherche de clients — les aides PURES de la palette ⌘K (§6.1).
 *
 * Importé par un composant client : aucun motif à lookbehind ici (Safari < 16.4
 * lève dessus), seulement de la réécriture de requête et des listes.
 *
 * L'état de la palette vit DANS la chaîne `q` : choisir une puce de portée
 * réécrit `dans:…` ; « Chercher partout » le retire. Une requête partagée ou
 * rouverte dit donc exactement ce qu'elle cherche.
 */
import { foldSearch } from "./fold";
import { contactKind, tokenizeSearch } from "./query";
import type { MatchGroup, ParsedQuery } from "./types";

export type ScopeLocale = "fr" | "en";

/** Le jeton de portée écrit dans la requête, par langue d'interface. */
export const SCOPE_TOKENS: Readonly<Record<ScopeLocale, Readonly<Record<MatchGroup, string>>>> = {
  fr: { contact: "dans:contact", profile: "dans:lieu", notes: "dans:notes" },
  en: { contact: "in:contact", profile: "in:place", notes: "in:notes" },
};

const scopeLocale = (locale: string): ScopeLocale => (locale.toLowerCase().startsWith("en") ? "en" : "fr");

const isWs = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/**
 * Retire des tranches `[début, fin)` d'une chaîne. Seuls les espaces qui
 * BORDENT une tranche retirée se resserrent : l'intérieur des guillemets n'est
 * jamais touché.
 */
function cut(source: string, spans: readonly [number, number][]): string {
  let out = source;
  // De la fin vers le début : les positions des tranches restantes ne bougent pas.
  for (const [s, e] of [...spans].sort((a, b) => b[0] - a[0])) {
    let from = s;
    while (from > 0 && isWs(out[from - 1])) from--;
    let to = e;
    while (to < out.length && isWs(out[to])) to++;
    const left = out.slice(0, from);
    const right = out.slice(to);
    out = left && right ? `${left} ${right}` : left + right;
  }
  return out.trim();
}

/**
 * Pose, remplace ou retire (`scope === null`) le jeton de portée. Le DERNIER
 * jeton existant est remplacé sur place ; les autres disparaissent ; sans jeton,
 * le nouveau s'ajoute à la fin. Le reste de la requête — guillemets compris —
 * n'est pas touché.
 */
export function applyScopeToken(q: string, scope: MatchGroup | null, locale: string): string {
  const tokens = tokenizeSearch(q);
  const scopes = tokens.filter((t) => t.operator?.kind === "scope");
  const next = scope ? SCOPE_TOKENS[scopeLocale(locale)][scope] : null;
  if (scopes.length === 0) {
    const base = q.trim();
    if (!next) return base;
    return base ? `${base} ${next}` : next;
  }
  const last = scopes[scopes.length - 1];
  const others = scopes.slice(0, -1).map((t) => [t.start, t.end] as [number, number]);
  const replaced = next ? q.slice(0, last.start) + next + q.slice(last.end) : q;
  // Les autres jetons sont AVANT le dernier : leurs positions ne bougent pas.
  const spans = next ? others : [...others, [last.start, last.end] as [number, number]];
  return cut(replaced, spans);
}

export type NoResultSuggestion =
  /** « Chercher partout » : la même requête sans portée. */
  | { kind: "everywhere"; query: string }
  /** « Chercher seulement « t » » : un seul terme, tel que tapé (opérateur compris). */
  | { kind: "only"; term: string; query: string }
  /** « Retirer les exclusions » : la requête sans ses `-mot`. */
  | { kind: "withoutExclusions"; query: string }
  /** Texte fixe : un numéro ou un courriel ne cherche que les fiches dont on voit les coordonnées. */
  | { kind: "contactHint" }
  /** Texte fixe : les mots de 1–2 lettres ne descendent pas dans les notes. */
  | { kind: "shortHint" };

/** Au plus 3 propositions « Chercher seulement ». */
export const MAX_ONLY_SUGGESTIONS = 3;

/**
 * Que proposer quand rien n'est trouvé, dans l'ordre d'affichage :
 * partout (portée posée) → seulement « t » (2 termes ou plus, 3 au plus) →
 * sans exclusions → aide coordonnées (chiffres ou courriel) → aide mots courts.
 */
export function noResultSuggestions(parsed: ParsedQuery): NoResultSuggestion[] {
  const out: NoResultSuggestion[] = [];
  const source = parsed.source;
  if (parsed.scope) out.push({ kind: "everywhere", query: applyScopeToken(source, null, "fr") });
  if (parsed.positive.length >= 2) {
    for (const t of parsed.positive.slice(0, MAX_ONLY_SUGGESTIONS)) {
      out.push({ kind: "only", term: t.text, query: t.raw });
    }
  }
  if (parsed.negative.length > 0) {
    out.push({ kind: "withoutExclusions", query: cut(source, parsed.negative.map((t) => t.span)) });
  }
  // Même règle que la recherche : un numéro ou un courriel, même entre
  // guillemets, n'est cherché que là où les coordonnées sont ouvertes.
  if (parsed.positive.some((t) => t.kind === "digits" || contactKind(t))) out.push({ kind: "contactHint" });
  if (parsed.shortOnly) out.push({ kind: "shortHint" });
  return out;
}

/** Au plus 8 recherches récentes. */
export const RECENT_MAX = 8;

const recentKey = (q: string) => foldSearch(q).replace(/\s+/g, " ").trim();

/**
 * Ajoute une recherche VALIDÉE (fiche ouverte ou « tous les résultats ») en
 * tête de l'historique : sans doublon au pliage près (la graphie la plus
 * récente gagne), au plus `max`. Seulement des CHAÎNES de requête — jamais un
 * nom ni un identifiant de fiche : un nom stocké survivrait à un retrait de droit.
 */
export function pushRecent(list: readonly string[], q: string, max: number = RECENT_MAX): string[] {
  const entry = q.replace(/\s+/g, " ").trim();
  const clean = list.filter((x) => typeof x === "string" && x.trim() !== "");
  if (!entry) return clean.slice(0, max);
  const key = recentKey(entry);
  return [entry, ...clean.filter((x) => recentKey(x) !== key)].slice(0, max);
}
