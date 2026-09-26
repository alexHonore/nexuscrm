/**
 * Recherche de clients — le classement (§4).
 *
 * UNE table (`LEVELS`) et UN barème (`BONUS`) : le statement SQL en génère son
 * arithmétique (`scoreSpec`), `scoreFeatures` l'applique en TS, et le test de
 * parité exige que les deux donnent le même entier pour chaque ligne.
 *
 * Chaque terme compte UNE fois, dans son meilleur champ : un mot répété dans
 * vingt commentaires ne dépasse jamais un nom.
 *
 * Module PUR : ni base, ni React.
 */
import {
  MASK_COLUMNS,
  type Level,
  type LevelRow,
  type MaskColumn,
  type MatchFeatures,
  type MatchField,
  type MatchReason,
  type ScoreSpec,
  type SearchPlan,
} from "./types";

export const LEVELS = [
  { column: "name_x", field: "name", level: "whole", points: 100 },
  { column: "name_w", field: "name", level: "prefix", points: 80 },
  { column: "name_i", field: "name", level: "infix", points: 45 },
  { column: "name_f", field: "name", level: "fuzzy", points: 30 },
  { column: "ph_x", field: "phone", level: "exact", points: 130 },
  { column: "ph_s", field: "phone", level: "suffix", points: 95 },
  { column: "ph_i", field: "phone", level: "infix", points: 70 },
  // Le DÉBUT du numéro national (indicatif régional, « marc 514 ») — seulement
  // pour 3–6 chiffres PARMI d'autres termes, qui n'ont plus l'infixe. Toute une
  // région le partage : il pèse comme une ville, pas comme un numéro.
  { column: "ph_p", field: "phone", level: "prefix", points: 40 },
  { column: "em_x", field: "email", level: "exact", points: 130 },
  { column: "em_p", field: "email", level: "prefix", points: 70 },
  { column: "em_i", field: "email", level: "infix", points: 40 },
  { column: "em_t", field: "email", level: "text", points: 25 },
  // 44 et non 45 (spec) : à 45, une ville entière ÉGALAIT un infixe de nom, et
  // l'ordre « nom infixe > ville » (§4, ordre de référence) dépendait de l'activité.
  { column: "city_x", field: "city", level: "whole", points: 44 },
  { column: "city_w", field: "city", level: "prefix", points: 40 },
  { column: "city_i", field: "city", level: "infix", points: 25 },
  { column: "city_f", field: "city", level: "fuzzy", points: 15 },
  { column: "addr_pc", field: "address", level: "postal", points: 60 },
  { column: "addr_m", field: "address", level: "match", points: 20 },
  { column: "notes_m", field: "notes", level: "match", points: 25 },
  { column: "proj_m", field: "project", level: "match", points: 15 },
  { column: "com_m", field: "comment", level: "match", points: 22 },
  { column: "fup_m", field: "followup", level: "match", points: 18 },
  { column: "call_m", field: "call", level: "match", points: 18 },
  { column: "sms_m", field: "sms", level: "match", points: 12 },
] as const satisfies readonly LevelRow[];

export const BONUS = {
  nameExact: 150,
  namePhrase: 25,
  nameStart: 15,
  sameRecord: 20,
  /**
   * « Toute l'adresse » (voir `ScoreSpec.sameAddress`). Plus que
   * `name_x + ph_p − 2·addr_m` (100) : « 412 rue tremblay » met le résident
   * devant chaque Tremblay de l'indicatif 412 qui habite « rue … » (I6) ; moins
   * que `name_x + ph_s − 2·addr_m` (155) : « tremblay 5551 » garde le Tremblay
   * dont le numéro FINIT par 5551 devant le « 5551 rue Tremblay ».
   */
  sameAddress: 120,
  recent30: 10,
  recent180: 4,
  depthPer: 2,
  depthMax: 6,
} as const;

/** Les paliers de fraîcheur de l'historique, du plus récent au plus ancien. */
export const RECENCY_TIERS = [
  { days: 30, points: BONUS.recent30 },
  { days: 180, points: BONUS.recent180 },
] as const;

const DAY_MS = 86_400_000;

/** La ligne de `LEVELS` de chaque colonne. */
export const LEVEL_OF: Readonly<Record<MaskColumn, LevelRow>> = Object.fromEntries(
  LEVELS.map((row) => [row.column, row]),
) as Record<MaskColumn, LevelRow>;

/** Les colonnes qui parlent de la FICHE (tout sauf l'historique) — `fiche_m`. */
export const FICHE_COLUMNS: readonly MaskColumn[] = MASK_COLUMNS.filter(
  (c) => c !== "com_m" && c !== "fup_m" && c !== "call_m" && c !== "sms_m",
);
/** Les colonnes d'historique — `hist_m`. */
export const HISTORY_COLUMNS = ["com_m", "fup_m", "call_m", "sms_m"] as const satisfies readonly MaskColumn[];

/**
 * Le LIEU d'une fiche — `same_address`. La ville en fait partie : l'adresse est
 * du texte libre, qui porte la ville (« 412 rue Tremblay, Lévis ») ou non.
 */
export const LOCATION_COLUMNS = [
  "city_x",
  "city_w",
  "city_i",
  "city_f",
  "addr_pc",
  "addr_m",
] as const satisfies readonly MaskColumn[];

/** Un numéro civique : 1 à 6 chiffres, rien d'autre (« 12 », « 412 », « 12345 »). */
const CIVIC = /^\d{1,6}$/;

/**
 * Les seuils de fraîcheur pour `now` : `now − 30 j`, `now − 180 j` (jours de
 * 24 h, pas de calendrier). Le builder SQL les lie en `::timestamptz`.
 */
export function recencyCutoffs(now: Date): Date[] {
  return RECENCY_TIERS.map((t) => new Date(now.getTime() - t.days * DAY_MS));
}

/** Le barème du score pour un plan, en données (voir `ScoreSpec`). */
export function scoreSpec(plan: Pick<SearchPlan, "positive" | "columns" | "exactName" | "phraseName" | "startName" | "req">): ScoreSpec {
  return {
    terms: plan.positive.map((t) => ({
      term: t.index,
      bit: t.bit,
      columns: LEVELS.filter((row) => plan.columns[row.column].entries.some((e) => e.bit === t.bit))
        .map((row) => ({ column: row.column as MaskColumn, points: row.points as number }))
        .sort((a, b) => b.points - a.points),
    })),
    nameExact: plan.exactName ? BONUS.nameExact : null,
    namePhrase: plan.phraseName ? BONUS.namePhrase : null,
    nameStart: plan.startName ? BONUS.nameStart : null,
    sameRecord: plan.positive.length >= 2 ? BONUS.sameRecord : null,
    // Sans numéro civique, « tremblay laval » cherche une personne à Laval :
    // le boulevard Tremblay à Laval ne doit pas passer devant.
    sameAddress:
      plan.positive.length >= 2 &&
      plan.positive.some(
        (t) => (t.kind === "digits" || t.kind === "text") && CIVIC.test(t.value) && t.columns.includes("addr_m"),
      )
        ? BONUS.sameAddress
        : null,
    history: {
      req: plan.req,
      recency: RECENCY_TIERS.map((t) => ({ days: t.days, points: t.points })),
      depthPer: BONUS.depthPer,
      depthMax: BONUS.depthMax,
    },
  };
}

/** Le OU des colonnes données. */
function orOf(masks: Readonly<Record<MaskColumn, number>>, columns: readonly MaskColumn[]): number {
  let m = 0;
  for (const c of columns) m |= masks[c] ?? 0;
  return m;
}

/** La meilleure ligne de `LEVELS` pour le bit donné (à points égaux, la première de la table). */
function bestRow(masks: Readonly<Record<MaskColumn, number>>, bit: number): LevelRow | null {
  let best: LevelRow | null = null;
  for (const row of LEVELS) {
    if (((masks[row.column] ?? 0) & bit) !== 0 && (!best || row.points > best.points)) best = row;
  }
  return best;
}

export type ScorePart =
  | { kind: "term"; term: number; column: MaskColumn; points: number }
  | {
      kind: "nameExact" | "namePhrase" | "nameStart" | "sameRecord" | "sameAddress" | "recency" | "depth";
      points: number;
    };

const toTime = (d: Date | string | null): number | null => {
  if (d === null) return null;
  const t = typeof d === "string" ? Date.parse(d) : d.getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Le score d'une ligne — l'entier que le SQL DOIT rendre (test de parité).
 * `parts` détaille chaque point (seulement les parts non nulles) ; leur somme
 * est `total`.
 */
export function scoreFeatures(features: MatchFeatures, now: Date): { total: number; parts: ScorePart[] } {
  const parts: ScorePart[] = [];
  const k = Math.max(0, Math.min(features.termCount, 8));
  const req = (1 << k) - 1;

  for (let i = 0; i < k; i++) {
    const row = bestRow(features.masks, 1 << i);
    if (row) parts.push({ kind: "term", term: i, column: row.column, points: row.points });
  }
  if (features.nameExact) parts.push({ kind: "nameExact", points: BONUS.nameExact });
  if (features.namePhrase) parts.push({ kind: "namePhrase", points: BONUS.namePhrase });
  if (features.nameStart) parts.push({ kind: "nameStart", points: BONUS.nameStart });
  if (features.sameRecord && k >= 2) parts.push({ kind: "sameRecord", points: BONUS.sameRecord });
  if (features.sameAddress && k >= 2) parts.push({ kind: "sameAddress", points: BONUS.sameAddress });

  // L'historique ne rapporte fraîcheur et profondeur que s'il PORTE la fiche :
  // un terme trouvé seulement là.
  const fiche = orOf(features.masks, FICHE_COLUMNS);
  const hist = orOf(features.masks, HISTORY_COLUMNS);
  if ((hist & req & ~fiche) !== 0) {
    const at = toTime(features.histAt);
    if (at !== null) {
      const cut = recencyCutoffs(now);
      const tier = RECENCY_TIERS.findIndex((_, idx) => at >= cut[idx].getTime());
      if (tier >= 0) parts.push({ kind: "recency", points: RECENCY_TIERS[tier].points });
    }
    const depth = Math.min(BONUS.depthMax, BONUS.depthPer * Math.max(0, features.histN - 1));
    if (depth > 0) parts.push({ kind: "depth", points: depth });
  }

  return { total: parts.reduce((sum, p) => sum + p.points, 0), parts };
}

/**
 * Pourquoi la fiche est là : le niveau GAGNANT de chaque terme, regroupé par
 * champ (le niveau affiché est le meilleur du groupe), points décroissants.
 * La ligne ne filtre rien : c'est `searchClients` qui retire ce que la
 * personne n'a pas le droit de voir (téléphone, courriel, historique, SMS).
 */
export function matchReasons(features: MatchFeatures): MatchReason[] {
  const k = Math.max(0, Math.min(features.termCount, 8));
  const byField = new Map<MatchField, { row: LevelRow; terms: number[]; order: number }>();
  for (let i = 0; i < k; i++) {
    const row = bestRow(features.masks, 1 << i);
    if (!row) continue;
    const group = byField.get(row.field);
    if (!group) {
      byField.set(row.field, { row, terms: [i], order: LEVELS.findIndex((r) => r.column === row.column) });
    } else {
      group.terms.push(i);
      if (row.points > group.row.points) {
        group.row = row;
        group.order = LEVELS.findIndex((r) => r.column === row.column);
      }
    }
  }
  return [...byField.values()]
    .sort((a, b) => b.row.points - a.row.points || a.order - b.order)
    .map((g) => ({ field: g.row.field, level: g.row.level as Level, terms: g.terms }));
}

/** Des masques tous à zéro — point de départ des tests et de la relecture des lignes. */
export function emptyMasks(): Record<MaskColumn, number> {
  return Object.fromEntries(MASK_COLUMNS.map((c) => [c, 0])) as Record<MaskColumn, number>;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Relit une ligne du statement (colonnes nommées comme `MaskColumn`, plus
 * `name_exact`, `name_phrase`, `name_start`, `same_record`, `same_address`,
 * `hist_at`, `hist_n`). Les entiers passent par `Number()` : le pilote peut rendre des
 * chaînes.
 */
export function featuresFromRow(row: Readonly<Record<string, unknown>>, termCount: number): MatchFeatures {
  const masks = emptyMasks();
  for (const c of MASK_COLUMNS) masks[c] = num(row[c]);
  const histAt = row.hist_at;
  return {
    termCount,
    masks,
    nameExact: row.name_exact === true,
    namePhrase: row.name_phrase === true,
    nameStart: row.name_start === true,
    sameRecord: row.same_record === true,
    sameAddress: row.same_address === true,
    histAt: histAt instanceof Date || typeof histAt === "string" ? histAt : null,
    histN: num(row.hist_n),
  };
}
