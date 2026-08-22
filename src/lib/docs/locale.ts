import { PARAM_DOCS_EN } from "./params.en";
import type { DocLocale, ParamDoc, ParamDocText, ResolvedParamDoc } from "./types";

export { docLocale } from "./types";

/**
 * Résolution de la langue d'une fiche de paramètre — module PUR.
 *
 * Le français est la source ; l'anglais est une surcouche par chemin. Une
 * traduction manquante RETOMBE sur le français plutôt que d'afficher un vide :
 * lire la fiche dans l'autre langue reste infiniment plus utile que de ne rien
 * lire, et le test de parité (`tests/unit-docs-locale.test.ts`) fait de toute
 * façon échouer le build sur un chemin non traduit.
 */

function frenchText(doc: ParamDoc): ParamDocText {
  return {
    label: doc.labelFr,
    what: doc.whatFr,
    why: doc.whyFr,
    effect: doc.effectFr,
    pitfalls: doc.pitfallsFr,
    allowed: doc.allowed
      ? Object.fromEntries(doc.allowed.map((a) => [String(a.value), a.labelFr]))
      : undefined,
  };
}

export function paramDocText(doc: ParamDoc, locale: DocLocale): ParamDocText {
  const fr = frenchText(doc);
  if (locale === "fr") return fr;
  const en = PARAM_DOCS_EN[doc.path];
  if (!en) return fr;
  return {
    label: en.label || fr.label,
    what: en.what || fr.what,
    why: en.why || fr.why,
    effect: en.effect ?? fr.effect,
    pitfalls: en.pitfalls ?? fr.pitfalls,
    allowed: en.allowed ?? fr.allowed,
  };
}

/** La fiche, langue tranchée, prête pour l'affichage. */
export function resolveParamDoc(
  doc: ParamDoc & { overridden?: boolean },
  locale: DocLocale,
): ResolvedParamDoc {
  const text = paramDocText(doc, locale);
  return {
    path: doc.path,
    section: doc.section,
    type: doc.type,
    required: doc.required,
    defaultValue: doc.defaultValue,
    allowed: doc.allowed?.map((a) => ({
      value: a.value,
      label: text.allowed?.[String(a.value)] ?? a.labelFr,
    })),
    label: text.label,
    what: text.what,
    why: text.why,
    effect: text.effect,
    pitfalls: text.pitfalls,
    related: doc.related,
    example: doc.example,
    orderIndex: doc.orderIndex,
    overridden: doc.overridden,
  };
}
