import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { paramDocs } from "@/db/schema-sms";
import { resolveParamDoc } from "@/lib/docs/locale";
import { PARAM_DOCS, getParamDoc, listParamDocs } from "@/lib/docs/params";
import type { DocLocale, DocSection, ParamDoc, ResolvedParamDoc } from "@/lib/docs/types";

/**
 * Lecture de la documentation : registre de code + surcouches administrateur.
 *
 * Le registre décide QUELS paramètres existent ; la base ne peut que réécrire
 * le texte de ceux-là. Une ligne dont le chemin a disparu du registre est
 * simplement ignorée — elle ne peut pas ressusciter un champ supprimé.
 */

/**
 * La fiche telle qu'elle part vers l'écran : langue déjà tranchée.
 *
 * La réécriture en base ne porte que le FRANÇAIS (colonnes `label_fr`,
 * `what_fr`…). En anglais, la fiche affichée reste donc celle du registre —
 * une réécriture française rendue à un administrateur anglophone serait pire
 * que le texte d'origine.
 */
export type ParamDocView = ResolvedParamDoc;

type OverrideRow = typeof paramDocs.$inferSelect;

function merge(base: ParamDoc, row: OverrideRow | undefined, locale: DocLocale): ParamDocView {
  // Une réécriture ne porte que le français : en anglais on rend le registre
  // tel quel, plutôt qu'un texte français maquillé en « personnalisé ».
  if (!row || locale !== "fr") return resolveParamDoc({ ...base, overridden: false }, locale);
  return resolveParamDoc(
    {
      ...base,
      labelFr: row.labelFr ?? base.labelFr,
      whatFr: row.whatFr ?? base.whatFr,
      whyFr: row.whyFr ?? base.whyFr,
      effectFr: row.effectFr ?? base.effectFr,
      pitfallsFr: row.pitfallsFr ?? base.pitfallsFr,
      overridden: true,
    },
    locale,
  );
}

async function overrideMap(): Promise<Map<string, OverrideRow>> {
  const rows = await db.select().from(paramDocs);
  return new Map(rows.map((r) => [r.path, r]));
}

export async function getParamDocs(
  locale: DocLocale,
  section?: DocSection,
): Promise<ParamDocView[]> {
  const overrides = await overrideMap();
  return listParamDocs(section).map((d) => merge(d, overrides.get(d.path), locale));
}

export async function getParamDocFor(path: string, locale: DocLocale): Promise<ParamDocView | null> {
  const base = getParamDoc(path);
  if (!base) return null;
  const [row] = await db.select().from(paramDocs).where(eq(paramDocs.path, base.path)).limit(1);
  return merge(base, row, locale);
}

export interface SaveParamDocInput {
  path: string;
  labelFr?: string | null;
  whatFr?: string | null;
  whyFr?: string | null;
  effectFr?: string | null;
  pitfallsFr?: string | null;
  updatedById: string;
}

/**
 * Réécrit le texte d'un paramètre. Refuse un chemin absent du registre : c'est
 * précisément la garantie qui empêche la base de dériver du schéma.
 */
export async function saveParamDoc(input: SaveParamDocInput): Promise<ParamDocView> {
  const base = getParamDoc(input.path);
  if (!base) throw new Error(`unknown_param_path:${input.path}`);

  const values = {
    path: base.path,
    labelFr: input.labelFr ?? null,
    whatFr: input.whatFr ?? null,
    whyFr: input.whyFr ?? null,
    effectFr: input.effectFr ?? null,
    pitfallsFr: input.pitfallsFr ?? null,
    updatedById: input.updatedById,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(paramDocs)
    .values(values)
    .onConflictDoUpdate({ target: paramDocs.path, set: values })
    .returning();

  return merge(base, row, "fr");
}

/**
 * Rend au paramètre son texte d'origine. Français : les colonnes de réécriture
 * n'ont jamais porté que ça, et c'est le seul écran qui les édite.
 */
export async function resetParamDoc(path: string): Promise<ParamDocView | null> {
  const base = getParamDoc(path);
  if (!base) return null;
  await db.delete(paramDocs).where(eq(paramDocs.path, base.path));
  return resolveParamDoc({ ...base, overridden: false }, "fr");
}

/** Chemins réécrits dont le registre ne veut plus — à nettoyer. */
export async function staleOverrides(): Promise<string[]> {
  const rows = await db.select({ path: paramDocs.path }).from(paramDocs);
  const known = new Set(PARAM_DOCS.map((d) => d.path));
  return rows.map((r) => r.path).filter((p) => !known.has(p));
}
