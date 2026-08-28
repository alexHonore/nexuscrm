/**
 * Budget de segments — ce qu'un message de l'assistant a le droit de COÛTER.
 *
 * Un SMS n'est pas facturé au message, il est facturé au SEGMENT : 160
 * caractères quand tout le texte tient dans la table GSM 03.38, 70 dès qu'un
 * seul caractère en sort — un « ê », un « ç » minuscule, une apostrophe
 * courbe, un émoji. En français du Québec, la deuxième situation est la
 * NORMALE : « ça », « peut-être », « français », « s'il vous plaît » cassent
 * tous le GSM-7. Un message de 200 caractères correctement accentué coûte donc
 * trois segments là où le même texte sans accents en coûterait deux… et un
 * texte de 300 caractères — le défaut de `approach.maxChars` — en coûte cinq.
 *
 * Ce module donne à l'administrateur le cadran que ce constat appelle : jusqu'à
 * combien de segments je paie un message, et qu'est-ce que j'accepte de
 * sacrifier pour y tenir. Les trois réglages sont indépendants :
 *
 *  · `maxSegments` — le plafond. `null` = aucun, c'est-à-dire EXACTEMENT le
 *    comportement d'avant ce module.
 *  · `onOverflow` — ce qui arrive quand le brouillon dépasse quand même.
 *  · `economy` — jusqu'où on a le droit de retoucher les caractères pour
 *    gagner de la place sans rien retirer au propos.
 *
 * Pur et sans dépendance d'infrastructure (règle du module src/lib/sms :
 * aucune importation de Next.js, aucune base de données, aucune lecture
 * d'environnement). Le compte de segments ne se recalcule JAMAIS ici : il
 * vient d'`analyzeSms`, seule autorité sur GSM 03.38 dans ce dépôt — deux
 * arithmétiques finiraient par annoncer un coût que l'expéditeur ne facture
 * pas.
 */
import { z } from "zod";
import { analyzeSms, capacityFor, isGsm7Char, lintSms, type SmsAnalysis } from "./segments";

/**
 * Ce qui arrive à un brouillon trop cher.
 *
 * · « send » : rien. Le plafond n'est qu'une consigne dans le prompt, et le
 *   dépassement se lit dans le journal du tour. C'est le bout « messages
 *   complets » du cadran.
 * · « rewrite » : une réécriture est demandée au modèle, puis le message part
 *   tel qu'il revient — même s'il dépasse encore. Un tour de plus chez le
 *   fournisseur de modèle, jamais de texte amputé.
 * · « trim » : une réécriture, PUIS une coupe si ça n'a pas suffi. Seul réglage
 *   qui garantit la facture, au prix d'une phrase perdue.
 */
export const OVERFLOW_POLICIES = ["send", "rewrite", "trim"] as const;
export type OverflowPolicy = (typeof OVERFLOW_POLICIES)[number];

/**
 * Jusqu'où on retouche les caractères pour tenir dans moins de segments.
 *
 * · « off » : le texte part exactement comme le modèle l'a écrit.
 * · « typography » : ponctuation droite — apostrophe courbe, guillemets
 *   typographiques, tiret cadratin, points de suspension, espace insécable
 *   redeviennent leur équivalent ASCII. AUCUNE perte de sens : c'est la même
 *   substitution que celle proposée par l'écran de délivrabilité.
 * · « ascii » : en plus, les accents tombent (« ça » → « ca »). L'orthographe
 *   en souffre — c'est un vrai sacrifice, pas un nettoyage — mais c'est le
 *   seul levier qui fait passer un message français de 70 à 160 caractères
 *   par segment.
 */
export const TEXT_ECONOMIES = ["off", "typography", "ascii"] as const;
export type TextEconomy = (typeof TEXT_ECONOMIES)[number];

export const segmentBudgetSchema = z.object({
  maxSegments: z.number().int().min(1).max(4).nullable(),
  onOverflow: z.enum(OVERFLOW_POLICIES),
  economy: z.enum(TEXT_ECONOMIES),
});
export type SegmentBudget = z.infer<typeof segmentBudgetSchema>;

/**
 * Le budget qui ne change RIEN.
 *
 * `approach` est une colonne jsonb dont aucune fiche existante ne porte cette
 * clé, et la configuration est reparsée à chaque lecture : le défaut posé ici
 * est celui que TOUTE la flotte adopte à sa prochaine recompilation. Il doit
 * donc reproduire le comportement d'avant au caractère près — aucun plafond,
 * aucune retouche. « rewrite » n'est le défaut que de la conduite à tenir en
 * cas de dépassement, laquelle ne peut pas se produire tant que
 * `maxSegments` vaut `null` : c'est une valeur inerte tant que quelqu'un n'a
 * pas explicitement posé un plafond.
 */
export const DEFAULT_SEGMENT_BUDGET: SegmentBudget = {
  maxSegments: null,
  onOverflow: "rewrite",
  economy: "off",
};

/**
 * Variante RÉGLAGE : chaque champ a son défaut, si bien que `parse({})` rend
 * `DEFAULT_SEGMENT_BUDGET`. C'est ce que lit une fiche enregistrée avant que
 * ce réglage existe.
 */
export const segmentBudgetSettingsSchema = z.object({
  maxSegments: z.number().int().min(1).max(4).nullable().default(DEFAULT_SEGMENT_BUDGET.maxSegments),
  onOverflow: z.enum(OVERFLOW_POLICIES).default(DEFAULT_SEGMENT_BUDGET.onOverflow),
  economy: z.enum(TEXT_ECONOMIES).default(DEFAULT_SEGMENT_BUDGET.economy),
});

/** Ce qui a réellement joué sur un brouillon, dans l'ordre d'application. */
export const BUDGET_STEPS = ["typography", "ascii", "trim"] as const;
export type BudgetStep = (typeof BUDGET_STEPS)[number];

// ── Le nombre à écrire dans le prompt ────────────────────────────────────────

/**
 * Combien de caractères l'assistant peut écrire pour tenir dans son budget.
 *
 * L'encodage retenu est celui que le message AURA une fois l'économie
 * appliquée, pas celui qu'il aurait aujourd'hui : sans « ascii », un texte
 * français est présumé UCS-2 (67 caractères par segment) parce que c'est ce
 * qu'il est presque toujours. Présumer le GSM-7 donnerait un budget deux fois
 * trop généreux, que le premier « ç » ferait exploser.
 *
 * Rend `null` quand aucun plafond n'est posé : il n'y a alors rien à dire de
 * plus que ce que `approach.maxChars` dit déjà.
 */
export function charBudgetFor(budget: SegmentBudget): number | null {
  if (budget.maxSegments === null) return null;
  return capacityFor(budget.economy === "ascii" ? "GSM-7" : "UCS-2", budget.maxSegments);
}

// ── Économie de caractères ───────────────────────────────────────────────────

/**
 * Ponctuation droite : les substituts viennent de `lintSms`, pas d'une
 * seconde table.
 *
 * L'analyseur sait déjà nommer chaque caractère qui force l'UCS-2 et proposer
 * son équivalent sûr quand il en existe un ; s'en servir garantit que ce qui
 * est remplacé ici est exactement ce que l'écran de délivrabilité reproche
 * là-bas. Les caractères sans équivalent fidèle (lettres accentuées, émojis)
 * n'ont pas de suggestion et ne sont donc pas touchés.
 */
export function normalizeTypography(body: string): string {
  let out = body;
  for (const warning of lintSms(body).warnings) {
    if (warning.suggestion !== undefined) out = out.split(warning.char).join(warning.suggestion);
  }
  return out;
}

/**
 * Les lettres que la décomposition Unicode ne sait pas ramener à du GSM-7.
 *
 * « œ » n'est pas un « o » accentué : aucune forme NFD ne le sépare, il faut
 * l'épeler. Les ligatures et lettres nordiques que la table GSM contient DÉJÀ
 * (æ, Æ, ø, Ø, ß, à, è, é, ù, ì, ò, Ç, É…) n'ont rien à faire ici — elles
 * passent telles quelles.
 */
const SPELLED_OUT: ReadonlyMap<string, string> = new Map([
  ["œ", "oe"],
  ["Œ", "OE"],
  ["ĳ", "ij"],
  ["Ĳ", "IJ"],
  ["đ", "d"],
  ["Đ", "D"],
  ["ł", "l"],
  ["Ł", "L"],
  ["№", "no"],
  ["℠", ""],
  ["™", ""],
  ["©", ""],
  ["®", ""],
]);

const COMBINING_MARKS = /\p{M}/gu;

/**
 * Ramène le texte dans la table GSM 03.38 — accents compris.
 *
 * Trois passes, de la moins destructrice à la plus : la ponctuation d'abord
 * (aucune perte), puis les lettres qui s'épellent, puis la décomposition
 * Unicode qui retire les signes diacritiques (« ê » → « e »). Ce qui résiste
 * encore — émoji, idéogramme, symbole sans équivalent — DISPARAÎT : le
 * conserver annulerait tout le gain, un seul caractère hors table suffisant à
 * faire basculer le message entier en UCS-2.
 *
 * L'itération se fait par POINTS DE CODE (`for…of`) : une paire de
 * substitution coupée en deux produirait un caractère de remplacement, ce qui
 * est pire que la supprimer.
 */
export function toGsm7(body: string): string {
  const out: string[] = [];
  for (const char of normalizeTypography(body)) {
    if (isGsm7Char(char)) {
      out.push(char);
      continue;
    }
    const spelled = SPELLED_OUT.get(char);
    if (spelled !== undefined) {
      out.push(spelled);
      continue;
    }
    const stripped = char.normalize("NFD").replace(COMBINING_MARKS, "");
    // La décomposition ne vaut que si TOUT ce qu'elle rend est représentable :
    // à moitié convertie, la lettre ferait basculer le message quand même.
    if (stripped !== "" && [...stripped].every(isGsm7Char)) out.push(stripped);
  }
  // Une suppression laisse un trou : « super 👍 merci » deviendrait « super
  // merci » avec deux espaces. Les sauts de ligne ne sont pas touchés — ils
  // sont dans la table, et ils sont voulus.
  return out.join("").replace(/[^\S\r\n]{2,}/g, " ").trim();
}

/**
 * Applique l'économie choisie — et ne la garde que si elle PAIE.
 *
 * La garde est nécessaire, pas décorative. En UCS-2, « … » occupe une unité et
 * « ... » en occupe trois : une ponctuation « nettoyée » sur un texte qui reste
 * accentué RALLONGE le message. De même, retirer les accents d'un message
 * court qui tenait déjà dans un segment abîme l'orthographe sans rien
 * économiser. On compare donc le coût réel avant et après, et on ne retient la
 * retouche que si elle fait tomber au moins un segment.
 */
export function applyEconomy(
  body: string,
  economy: TextEconomy,
): { body: string; step: BudgetStep | null } {
  if (economy === "off" || body === "") return { body, step: null };
  const candidate = economy === "ascii" ? toGsm7(body) : normalizeTypography(body);
  if (candidate === body) return { body, step: null };
  if (analyzeSms(candidate).segments >= analyzeSms(body).segments) return { body, step: null };
  return { body: candidate, step: economy === "ascii" ? "ascii" : "typography" };
}

// ── La coupe, dernier recours ────────────────────────────────────────────────

/** Fins de phrase reconnues — le point final d'une abréviation compris, tant pis. */
const SENTENCE_END = /[.!?…]/;

/**
 * Le plus long préfixe qui tient dans `maxSegments`, en points de code.
 *
 * Recherche dichotomique légitime : le coût d'un préfixe ne DÉCROÎT jamais
 * quand on l'allonge — un caractère de plus ajoute des unités, ou fait basculer
 * en UCS-2, ce qui en ajoute encore. Le pas se compte en points de code pour
 * ne jamais couper une paire de substitution en deux.
 */
function longestFitting(points: string[], maxSegments: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (analyzeSms(points.slice(0, mid).join("")).segments <= maxSegments) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Coupe le message pour qu'il tienne dans `maxSegments` — proprement.
 *
 * Le moteur refuse déjà d'envoyer un message que le fournisseur a tronqué au
 * milieu d'une phrase ; couper au milieu d'un mot ici dirait le contraire de
 * cette règle. On cherche donc, dans ce qui tient : la dernière fin de phrase,
 * sinon la dernière frontière de mot, et une coupe brutale seulement s'il n'y
 * a ni l'une ni l'autre (un seul mot très long — en pratique, jamais).
 *
 * La fin de phrase n'est retenue que si elle laisse plus de la moitié de ce
 * qui tenait : sinon on garde la frontière de mot, qui conserve davantage du
 * propos. Un message déjà dans son budget revient tel quel.
 */
export function trimToSegments(body: string, maxSegments: number): string {
  if (analyzeSms(body).segments <= maxSegments) return body;
  const points = [...body];
  const fitting = longestFitting(points, maxSegments);
  if (fitting === 0) return "";

  const head = points.slice(0, fitting);
  let sentence = -1;
  let word = -1;
  for (let i = 0; i < head.length; i += 1) {
    if (SENTENCE_END.test(head[i])) sentence = i + 1;
    if (/\s/.test(head[i])) word = i;
  }

  const cut =
    sentence > 0 && sentence * 2 > fitting ? sentence : word > 0 ? word : fitting;
  return head.slice(0, cut).join("").trimEnd();
}

// ── Ce que le moteur appelle ─────────────────────────────────────────────────

export interface SegmentBudgetOutcome {
  /** Le corps à envoyer — identique à l'entrée quand rien n'a joué. */
  body: string;
  /** Coût du brouillon tel que le modèle l'a écrit. */
  before: SmsAnalysis;
  /** Coût du corps rendu. */
  after: SmsAnalysis;
  /** Ce qui a joué, dans l'ordre. Vide = le brouillon part intact. */
  applied: BudgetStep[];
  /** Le corps rendu dépasse-t-il ENCORE le plafond ? */
  overflow: boolean;
}

/**
 * L'étape que le moteur et le bac à sable appliquent au brouillon, au même
 * endroit : juste après la découpe en paragraphes, AVANT les garde-fous.
 *
 * L'ordre n'est pas négociable. Les garde-fous doivent juger le texte qui PART
 * — sinon un tour refusé rapporterait un verdict sur un texte qui n'a jamais
 * existé, et la longueur mesurée par la règle « max_chars » ne serait pas celle
 * du message facturé.
 *
 * La coupe n'est PAS faite ici : elle est le dernier recours, et le moteur
 * doit d'abord pouvoir demander au modèle de réécrire. C'est lui qui appelle
 * `trimToSegments` à sa dernière tentative, quand il n'a plus personne à qui
 * demander.
 */
export function applySegmentBudget(body: string, budget: SegmentBudget): SegmentBudgetOutcome {
  const before = analyzeSms(body);
  const economized = applyEconomy(body, budget.economy);
  const after = economized.body === body ? before : analyzeSms(economized.body);
  return {
    body: economized.body,
    before,
    after,
    applied: economized.step === null ? [] : [economized.step],
    overflow: budget.maxSegments !== null && after.segments > budget.maxSegments,
  };
}
