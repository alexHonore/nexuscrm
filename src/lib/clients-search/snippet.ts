/**
 * Recherche de clients — l'EXTRAIT montré sous une fiche trouvée (§5.3).
 *
 * Module PUR, mais qui compile les motifs du plan (lookbehind) : il ne tourne
 * que côté SERVEUR. Le navigateur ne reçoit que des intervalles
 * `[début, fin)` à surligner — jamais de HTML, jamais de motif.
 *
 * Chaîne complète, par texte candidat :
 * `normalizeStoredBody` → `redactContact` (case `contact` fermée) →
 * `pickSnippetSource` → `buildSnippet`.
 */
import { CONTACT_DIGIT_RUN } from "./query";
import { LEVELS } from "./score";
import type { HighlightPattern, MaskColumn, SnippetField, SnippetOrigin } from "./types";

/** Largeur visée d'un extrait, et le contexte gardé avant le premier terme. */
export const SNIPPET_WIDTH = 160;
export const SNIPPET_LEAD = 50;
/** Distance maximale jusqu'à l'espace où une coupe se recale. */
export const SNIPPET_SNAP = 15;

/** La marque qui remplace un courriel ou un numéro quand la case `contact` est fermée. */
export const REDACTED = "•••";

/** Un texte d'historique prêt à montrer : en-tête IA retiré, mentions lisibles, espaces simples. */
export type NormalizedBody = {
  text: string;
  origin: SnippetOrigin;
  /** Les `@Nom` du texte, `[début, fin)` : une coupe ne tombe jamais dedans. */
  mentions: [number, number][];
};

/**
 * L'en-tête des notes IA — la MÊME expression que `COMMENT_TEXT` en SQL :
 * sans ce retrait, « appel », « sortant », « septembre » trouveraient chaque
 * note d'appel.
 */
const AI_HEADER = /^🤖 (?:Notes d'appel \(IA\)|AI call notes)[^\n]*\n+|^🤖 Assistant « [^»]* » : /u;
const BOOKING = /^Rendez-vous (?:fixé|annulé) —/u;
const STORED_MENTION = /@\[([^\]]+)\]\([0-9a-fA-F-]{36}\)/g;

/**
 * Un corps stocké (commentaire, note d'appel, suivi, SMS) → le texte montré.
 * L'identifiant d'une mention ne survit JAMAIS : `@[Nom](uuid)` devient `@Nom`.
 */
export function normalizeStoredBody(body: string): NormalizedBody {
  let text = body;
  let origin: SnippetOrigin = "human";
  if (text.startsWith("🤖")) origin = "ai";
  const stripped = text.replace(AI_HEADER, "");
  if (stripped !== text) {
    origin = "ai";
    text = stripped;
  } else if (BOOKING.test(text)) {
    origin = "booking";
  }
  text = text.replace(/\s+/g, " ").trim();

  const mentions: [number, number][] = [];
  let out = "";
  let last = 0;
  for (const m of text.matchAll(STORED_MENTION)) {
    const at = m.index ?? 0;
    out += text.slice(last, at);
    const start = out.length;
    out += `@${m[1]}`;
    mentions.push([start, out.length]);
    last = at + m[0].length;
  }
  out += text.slice(last);
  return { text: out, origin, mentions };
}

/**
 * Un courriel (`[^\s@]+@[^\s@]+\.[^\s@]+`), sans avaler la ponctuation qui
 * l'entoure : « (jean@x.com), » garde sa parenthèse et sa virgule.
 */
const EMAIL = /[^\s@(«"“'<[]+@[^\s@]+\.[^\s@]*[^\s@.,;:!?)»"”'>\]]/g;
/**
 * 7 chiffres ou plus, séparés au plus par 3 caractères parmi ` ().+-` — la
 * MÊME forme que `contactKind` (query.ts) : un terme qui la contient ne touche
 * jamais une fiche aux coordonnées fermées.
 */
const LONG_DIGITS = new RegExp(`\\+?${CONTACT_DIGIT_RUN.source}`, "g");

/**
 * Masque courriels et suites de 7 chiffres ou plus (`•••`) — pour un extrait
 * montré à qui n'a pas la case `contact` de la fiche. Un `NormalizedBody`
 * garde ses mentions alignées (une mention touchée par un masque est oubliée).
 */
export function redactContact(text: string): string;
export function redactContact(body: NormalizedBody): NormalizedBody;
export function redactContact(input: string | NormalizedBody): string | NormalizedBody {
  const src = typeof input === "string" ? input : input.text;
  const hits: [number, number][] = [];
  for (const re of [EMAIL, LONG_DIGITS]) {
    for (const m of src.matchAll(re)) hits.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const h of hits) {
    const top = merged[merged.length - 1];
    if (top && h[0] <= top[1]) top[1] = Math.max(top[1], h[1]);
    else merged.push([h[0], h[1]]);
  }
  let out = "";
  let last = 0;
  // Décalage : pour chaque masque, où il commence dans la source et de combien il raccourcit.
  const shifts: { at: number; end: number; delta: number }[] = [];
  for (const [s, e] of merged) {
    out += src.slice(last, s) + REDACTED;
    shifts.push({ at: s, end: e, delta: e - s - REDACTED.length });
    last = e;
  }
  out += src.slice(last);
  if (typeof input === "string") return out;

  const mentions: [number, number][] = [];
  for (const [ms, me] of input.mentions) {
    if (shifts.some((sh) => ms < sh.end && me > sh.at)) continue;
    const before = shifts.filter((sh) => sh.end <= ms).reduce((d, sh) => d + sh.delta, 0);
    mentions.push([ms - before, me - before]);
  }
  return { text: out, origin: input.origin, mentions };
}

// ─── Surlignage ────────────────────────────────────────────────────────────────

const compiled = new Map<string, RegExp | null>();

/** Compile (et garde) un motif du plan. Un motif invalide ne surligne rien plutôt que de lever. */
function compile(pattern: string): RegExp | null {
  let re = compiled.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern, "giu");
    } catch {
      re = null;
    }
    if (compiled.size > 500) compiled.clear();
    compiled.set(pattern, re);
  }
  return re;
}

type Hit = { start: number; end: number; term: number };

function findHits(text: string, patterns: readonly (string | Pick<HighlightPattern, "pattern" | "term">)[]): Hit[] {
  const hits: Hit[] = [];
  patterns.forEach((p, idx) => {
    const pattern = typeof p === "string" ? p : p.pattern;
    const term = typeof p === "string" ? idx : p.term;
    const re = compile(pattern);
    if (!re) return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      hits.push({ start: m.index, end: m.index + m[0].length, term });
    }
  });
  return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}

function mergeRanges(ranges: readonly [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const top = out[out.length - 1];
    if (top && s <= top[1]) top[1] = Math.max(top[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Où les motifs tombent dans `text` : intervalles `[début, fin)` en offsets
 * UTF-16, triés, fusionnés quand ils se touchent. Les MÊMES motifs que le SQL :
 * ce qui a fait remonter la fiche est ce qui est surligné.
 */
export function highlightRanges(
  text: string,
  patterns: readonly (string | Pick<HighlightPattern, "pattern" | "term">)[],
): [number, number][] {
  if (!text) return [];
  return mergeRanges(findHits(text, patterns).map((h) => [h.start, h.end]));
}

// ─── Choix de la source ────────────────────────────────────────────────────────

/** Les points d'un champ d'extrait : ceux de sa ligne « match » dans `LEVELS`. */
export const SNIPPET_FIELD_POINTS: Readonly<Record<SnippetField, number>> = {
  notes: LEVELS.find((r) => r.column === "notes_m")!.points,
  address: LEVELS.find((r) => r.column === "addr_m")!.points,
  project: LEVELS.find((r) => r.column === "proj_m")!.points,
  comment: LEVELS.find((r) => r.column === "com_m")!.points,
  followup: LEVELS.find((r) => r.column === "fup_m")!.points,
  call: LEVELS.find((r) => r.column === "call_m")!.points,
  sms: LEVELS.find((r) => r.column === "sms_m")!.points,
};

export type SnippetCandidate = {
  field: SnippetField;
  /** Le masque de la source (ex. `com_m`, ou `addr_m | addr_pc`) — déjà filtré par les droits. */
  mask: number;
  text: string | null;
  at?: Date | string | null;
};

const popcount = (m: number) => {
  let n = 0;
  for (let x = m >>> 0; x; x &= x - 1) n++;
  return n;
};

const timeOf = (d: Date | string | null | undefined): number => {
  if (!d) return Number.NEGATIVE_INFINITY;
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/**
 * Les termes que la ligne montre DÉJÀ sans extrait : le nom, la ville, et le
 * téléphone quand la case `contact` est ouverte.
 */
export function coveredBits(masks: Readonly<Record<MaskColumn, number>>, contactOpen: boolean): number {
  let m =
    masks.name_x | masks.name_w | masks.name_i | masks.name_f | masks.city_x | masks.city_w | masks.city_i | masks.city_f;
  if (contactOpen) m |= masks.ph_x | masks.ph_s | masks.ph_i | masks.ph_p;
  return m;
}

/**
 * La source de l'extrait : parmi celles dont le masque touche un terme, la
 * mieux classée par (1) termes que la ligne ne montre pas encore, (2) termes
 * trouvés, (3) points du champ, (4) fraîcheur. `null` quand aucune source
 * n'apporte un terme de plus — la ligne dit déjà tout.
 */
export function pickSnippetSource<T extends SnippetCandidate>(
  candidates: readonly T[],
  opts: { req: number; covered: number },
): T | null {
  let best: { c: T; key: number[] } | null = null;
  for (const c of candidates) {
    const hit = c.mask & opts.req;
    if (hit === 0 || !c.text) continue;
    const key = [popcount(hit & ~opts.covered), popcount(hit), SNIPPET_FIELD_POINTS[c.field], timeOf(c.at)];
    if (!best || compareKeys(key, best.key) > 0) best = { c, key };
  }
  if (!best || best.key[0] === 0) return null;
  return best.c;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) return a[k] > b[k] ? 1 : -1;
  }
  return 0;
}

// ─── Fenêtre ───────────────────────────────────────────────────────────────────

export type BuiltSnippet = {
  text: string;
  /** Offsets UTF-16 dans `text` (l'extrait), pas dans la source. */
  ranges: [number, number][];
  clippedStart: boolean;
  clippedEnd: boolean;
};

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Ne jamais couper entre les deux moitiés d'une paire de substitution (emoji). */
function safeBoundary(text: string, at: number, dir: -1 | 1): number {
  if (at <= 0 || at >= text.length) return Math.max(0, Math.min(text.length, at));
  if (isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1))) return dir < 0 ? at - 1 : at + 1;
  return at;
}

/** Ne jamais couper dans une mention `@Nom` : la coupe sort de la mention, du côté donné. */
function outsideAtomic(at: number, atomic: readonly [number, number][], dir: -1 | 1): number {
  for (const [s, e] of atomic) {
    if (at > s && at < e) return dir < 0 ? s : e;
  }
  return at;
}

const isWs = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/**
 * Recale le DÉBUT sur un espace à ±15 caractères : d'abord en reculant (on
 * gagne du contexte), sinon en avançant — sans jamais dépasser `limit` (le
 * premier terme gardé).
 */
function snapStart(text: string, start: number, limit: number): number {
  if (start <= 0) return 0;
  for (let k = start; k >= Math.max(0, start - SNIPPET_SNAP); k--) {
    if (k === 0) return 0;
    if (isWs(text[k - 1])) return k;
  }
  for (let k = start + 1; k <= Math.min(limit, start + SNIPPET_SNAP); k++) {
    if (isWs(text[k - 1])) return k;
  }
  return start;
}

/**
 * Recale la FIN sur un espace à ±15 caractères : d'abord en reculant (sans
 * repasser avant `floor`, la fin du dernier terme gardé), sinon en avançant.
 */
function snapEnd(text: string, end: number, floor: number): number {
  if (end >= text.length) return text.length;
  for (let k = end; k >= Math.max(floor, end - SNIPPET_SNAP); k--) {
    if (isWs(text[k])) return k;
  }
  for (let k = end + 1; k <= Math.min(text.length, end + SNIPPET_SNAP); k++) {
    if (k === text.length || isWs(text[k])) return k;
  }
  return end;
}

/**
 * L'extrait : la fenêtre de ~160 caractères qui couvre le plus de termes
 * DISTINCTS, commencée ~50 caractères avant le terme qui l'ancre, recalée sur
 * des espaces, sans couper une paire de substitution ni une mention. Sans
 * aucun terme trouvé : les 160 premiers caractères, `ranges: []`.
 */
export function buildSnippet(
  text: string,
  patterns: readonly (string | Pick<HighlightPattern, "pattern" | "term">)[],
  opts: { atomic?: readonly [number, number][]; width?: number } = {},
): BuiltSnippet {
  const width = opts.width ?? SNIPPET_WIDTH;
  const atomic = opts.atomic ?? [];
  const hits = findHits(text, patterns);

  if (text.length <= width) {
    return { text, ranges: mergeRanges(hits.map((h) => [h.start, h.end])), clippedStart: false, clippedEnd: false };
  }

  let start = 0;
  let end = width;
  let floor = 0;
  if (hits.length > 0) {
    // La fenêtre la plus dense : chaque terme trouvé peut l'ancrer.
    let best: { start: number; distinct: number; anchor: Hit } | null = null;
    for (const anchor of hits) {
      const s = Math.max(0, Math.min(anchor.start - SNIPPET_LEAD, text.length - width));
      const inside = hits.filter((h) => h.start >= s && h.end <= s + width);
      const distinct = new Set(inside.map((h) => h.term)).size;
      if (!best || distinct > best.distinct) best = { start: s, distinct, anchor };
    }
    start = best!.start;
    end = Math.min(text.length, start + width);
    const kept = hits.filter((h) => h.start >= start && h.end <= end);
    const firstKept = kept.length ? Math.min(...kept.map((h) => h.start)) : best!.anchor.start;
    floor = kept.length ? Math.max(...kept.map((h) => h.end)) : Math.min(end, best!.anchor.end);
    start = snapStart(text, start, firstKept);
  }
  end = snapEnd(text, end, Math.max(floor, start + 1));

  start = safeBoundary(text, outsideAtomic(start, atomic, -1), -1);
  end = safeBoundary(text, outsideAtomic(end, atomic, 1), 1);

  const slice = text.slice(start, end);
  const ranges = mergeRanges(
    hits
      .filter((h) => h.end > start && h.start < end)
      .map((h) => [Math.max(h.start, start) - start, Math.min(h.end, end) - start] as [number, number]),
  );
  return { text: slice, ranges, clippedStart: start > 0, clippedEnd: end < text.length };
}
