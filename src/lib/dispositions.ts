import type { Disposition } from "@/db/schema";

/**
 * Les boutons colorés du popup d'après-appel.
 * `categoryKey` = catégorie (pipeline) appliquée automatiquement au client.
 */
export const DISPOSITION_CONFIG: Record<
  Disposition,
  { categoryKey: string | null; color: string; textColor?: string }
> = {
  voicemail: { categoryKey: "voicemail", color: "#3b82f6" }, // bleu
  booked: { categoryKey: "booked", color: "#16a34a" }, // vert
  callback: { categoryKey: "callback", color: "#f59e0b" }, // ambre
  not_interested: { categoryKey: "not_interested", color: "#ef4444" }, // rouge
  dncl: { categoryKey: "dncl", color: "#1e293b" }, // noir ardoise
  not_qualified: { categoryKey: "not_qualified", color: "#6b7280" }, // gris
  no_answer: { categoryKey: null, color: "#94a3b8" }, // gris clair — ne change pas la catégorie
};

export const DISPOSITION_ORDER: Disposition[] = [
  "booked",
  "callback",
  "voicemail",
  "no_answer",
  "not_interested",
  "not_qualified",
  "dncl",
];

// ── Dispositions pilotées par le pipeline ────────────────────────────────────
// Depuis l'alignement du pipeline sur la base Notion, les boutons d'après-appel
// sont les STATUTS du pipeline eux-mêmes (plus « Sans réponse », qui ne déplace
// pas la fiche). Valeur enregistrée dans calls.disposition : la clé de la
// catégorie quand elle en a une, sinon « cat:<id> » — les 7 anciennes valeurs
// restent donc valides telles quelles.

export type PipelineCategory = {
  id: number;
  key: string | null;
  nameFr: string;
  nameEn: string;
  color: string;
  sortOrder: number;
};

export type DispositionOption = {
  /** Valeur envoyée à PATCH /api/calls/[id] et stockée dans calls.disposition. */
  value: string;
  label: string;
  color: string;
  /** Clé de catégorie (comportements : callback → relance, booked → réservation, dncl). */
  key: string | null;
};

/** Valeur de disposition d'une catégorie du pipeline. */
export function categoryDispositionValue(cat: { id: number; key: string | null }): string {
  return cat.key ?? `cat:${cat.id}`;
}

/**
 * Couleur de texte lisible sur un aplat de la couleur donnée (luma YIQ) :
 * les statuts Notion peuvent être jaune/lime clair — du blanc y serait illisible.
 */
export function dispositionTextColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? "#1e293b" : "#ffffff";
}

/**
 * Boutons/filtres d'après-appel : « Sans réponse » puis les statuts du
 * pipeline dans l'ordre du tableau — sans « Non contacté » (classer un appel
 * terminé dans « non contacté » n'a pas de sens).
 */
export function pipelineDispositionOptions(
  cats: PipelineCategory[],
  locale: string,
  noAnswerLabel: string,
): DispositionOption[] {
  return [
    {
      value: "no_answer",
      label: noAnswerLabel,
      color: DISPOSITION_CONFIG.no_answer.color,
      key: "no_answer",
    },
    ...cats
      .filter((c) => c.key !== "new")
      .map((c) => ({
        value: categoryDispositionValue(c),
        label: locale === "en" ? c.nameEn : c.nameFr,
        color: c.color,
        key: c.key,
      })),
  ];
}

/**
 * Libellé + couleur d'une valeur de calls.disposition, pour les journaux et
 * les graphiques : chaque catégorie est indexée par sa clé ET par
 * « cat:<id> ». Les valeurs absentes (no_answer, vieilles valeurs orphelines)
 * gardent le repli i18n/DISPOSITION_CONFIG de l'appelant.
 */
export function dispositionDisplayMap(
  cats: PipelineCategory[],
  locale: string,
): Map<string, { label: string; color: string }> {
  const map = new Map<string, { label: string; color: string }>();
  for (const c of cats) {
    const display = { label: locale === "en" ? c.nameEn : c.nameFr, color: c.color };
    map.set(`cat:${c.id}`, display);
    if (c.key) map.set(c.key, display);
  }
  return map;
}
