import "server-only";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { categoryDispositionValue } from "@/lib/dispositions";
import { getSetting } from "@/lib/settings";
import type { ClassificationRuleInput } from "@/lib/agent/compile";

/**
 * Les règles de classement, résolues UNE fois pour deux usages qui doivent
 * s'accorder : ce que le prompt propose au modèle, et ce que l'outil accepte.
 *
 * S'ils divergeaient, le symptôme serait le pire possible — un assistant qui
 * essaie sans arrêt une catégorie que le prompt lui a nommée et que l'outil
 * refuse, tour après tour, sans que rien à l'écran ne l'explique. D'où une
 * seule fonction, et une liste d'autorisation DÉRIVÉE des règles plutôt que
 * tenue à côté.
 *
 * Une règle qui pointe vers une catégorie supprimée du pipeline est ignorée en
 * silence des deux côtés : elle disparaît du prompt et n'est pas acceptée. La
 * fiche de réglage, elle, la montre encore pour qu'on la corrige.
 */
export interface ResolvedClassification {
  /** Ce que le compilateur rend dans la couche L2. */
  forPrompt: ClassificationRuleInput[];
  /** Ce que l'outil accepte : valeur de catégorie → cible réelle. */
  allowed: Map<string, { id: number; label: string }>;
}

export async function resolveClassification(
  locale: "fr" | "en" = "fr",
): Promise<ResolvedClassification> {
  const [settings, rows] = await Promise.all([
    getSetting("classification").catch(() => ({ rules: [] as never[] })),
    db.select().from(categories).orderBy(asc(categories.sortOrder)),
  ]);

  const byValue = new Map(
    rows.map((row) => [
      categoryDispositionValue(row),
      { id: row.id, label: locale === "en" ? row.nameEn : row.nameFr },
    ]),
  );

  const forPrompt: ClassificationRuleInput[] = [];
  const allowed = new Map<string, { id: number; label: string }>();
  for (const rule of settings.rules) {
    if (!rule.enabled) continue;
    const target = byValue.get(rule.category);
    if (!target) continue;
    forPrompt.push({
      when: rule.when,
      categoryValue: rule.category,
      categoryLabel: target.label,
    });
    allowed.set(rule.category, target);
  }
  return { forPrompt, allowed };
}
