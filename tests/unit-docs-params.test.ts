/**
 * Unitaire — la documentation des paramètres est-elle complète et exploitable?
 *
 * Le test central (§19.1) : CHAQUE chemin du schéma zod d'un assistant doit
 * avoir une entrée documentée. Un paramètre ajouté sans documentation fait
 * échouer le build — c'est le seul moyen d'empêcher la référence de dériver du
 * schéma en quelques semaines.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assistantConfigSchema } from "@/lib/assistants/schema";
import { PARAM_DOCS, documentedPaths, getParamDoc, listParamDocs } from "@/lib/docs/params";
import { DOC_SECTIONS, DOC_TYPES } from "@/lib/docs/types";

/**
 * Parcourt un schéma zod et retourne les chemins de ses feuilles.
 * Les tableaux d'objets sont représentés par un segment « [] » : la
 * documentation d'un repli vaut pour tous les replis.
 */
function leafPaths(schema: z.ZodType, prefix = ""): string[] {
  const def = (schema as unknown as { def: { type: string; shape?: Record<string, z.ZodType> } }).def;

  // Traverse les enveloppes (default, optional, nullable…) jusqu'au type réel.
  const inner = (schema as unknown as { def: { innerType?: z.ZodType } }).def.innerType;
  if (inner) return leafPaths(inner, prefix);

  if (def.type === "object" && def.shape) {
    return Object.entries(def.shape).flatMap(([key, child]) =>
      leafPaths(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  if (def.type === "array") {
    const element = (schema as unknown as { def: { element: z.ZodType } }).def.element;
    const elementDef = (element as unknown as { def: { type: string } }).def;
    // Tableau d'objets : on documente le gabarit de l'élément.
    if (elementDef.type === "object" || (element as unknown as { def: { innerType?: unknown } }).def.innerType) {
      return leafPaths(element, `${prefix}[]`);
    }
    // Tableau de valeurs simples : le tableau lui-même est la feuille.
    return [prefix];
  }
  return [prefix];
}


/** Options d'un enum zod au chemin donné, ou null si le chemin n'est pas un enum. */
function enumOptionsAt(path: string): string[] | null {
  let node: z.ZodType = assistantConfigSchema;
  for (const segment of path.split(".")) {
    const unwrapped = unwrap(node);
    const def = (unwrapped as unknown as { def: { type: string; shape?: Record<string, z.ZodType>; element?: z.ZodType } }).def;
    if (segment.endsWith("[]")) {
      const key = segment.slice(0, -2);
      const child = def.shape?.[key];
      if (!child) return null;
      const arr = (unwrap(child) as unknown as { def: { element?: z.ZodType } }).def.element;
      if (!arr) return null;
      node = arr;
      continue;
    }
    const child = def.shape?.[segment];
    if (!child) return null;
    node = child;
  }
  const final = unwrap(node);
  const def = (final as unknown as { def: { type: string; entries?: Record<string, string> } }).def;
  if (def.type !== "enum" || !def.entries) return null;
  return Object.values(def.entries);
}

function unwrap(schema: z.ZodType): z.ZodType {
  const inner = (schema as unknown as { def: { innerType?: z.ZodType } }).def.innerType;
  return inner ? unwrap(inner) : schema;
}

describe("registre de documentation", () => {
  it("§19.1 — CHAQUE chemin de la config d'assistant est documenté", () => {
    const paths = leafPaths(assistantConfigSchema);
    expect(paths.length).toBeGreaterThan(20);

    const undocumented = paths.filter((path) => getParamDoc(path) === undefined);
    // Message explicite : la personne qui casse ce test doit savoir quoi écrire.
    expect(
      undocumented,
      `Paramètres sans documentation dans src/lib/docs/params.ts :\n  ${undocumented.join("\n  ")}\n` +
        "Ajoutez une entrée ParamDoc (what/why/effect/pitfalls) pour chacun.",
    ).toEqual([]);
  });

  it("aucune documentation ne pointe vers un chemin qui n'existe plus", () => {
    const paths = new Set(leafPaths(assistantConfigSchema));
    // Les entrées de gabarit et les chemins composés (tools.stop) sont légitimes.
    const orphans = documentedPaths().filter((path) => {
      if (paths.has(path)) return false;
      if (path.startsWith("tools.")) return false;
      if (path.includes("[]")) return false;
      if (path.startsWith("guardrails.") || path.startsWith("campaign.")) return false;
      // Entrées « conteneur » : elles documentent la structure elle-même
      // (la chaîne de replis, le bloc de repli, les surcouches), pas une feuille.
      if (["goal.fallbacks", "model.fallbacks", "layerOverrides", "layerOverrides.mode", "layerOverrides.text"].includes(path)) return false;
      return true;
    });
    expect(orphans, `Documentation orpheline : ${orphans.join(", ")}`).toEqual([]);
  });

  it("chaque entrée est exploitable : libellé, quoi, pourquoi, section et type valides", () => {
    for (const entry of PARAM_DOCS) {
      expect(entry.labelFr.trim().length, entry.path).toBeGreaterThan(0);
      // « Quoi » et « pourquoi » sont le minimum vital : sans eux la fiche
      // n'apprend rien à personne.
      expect(entry.whatFr.trim().length, entry.path).toBeGreaterThan(20);
      expect(entry.whyFr.trim().length, entry.path).toBeGreaterThan(20);
      expect(DOC_SECTIONS, entry.path).toContain(entry.section);
      expect(DOC_TYPES, entry.path).toContain(entry.type);
    }
  });

  it("les chemins sont uniques", () => {
    const paths = documentedPaths();
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("les renvois pointent vers des paramètres existants", () => {
    for (const entry of PARAM_DOCS) {
      for (const related of entry.related) {
        // Les renvois vers une famille (« booking », « guardrails.severity »)
        // sont tolérés ; un renvoi vers un chemin d'assistant doit résoudre.
        if (!related.includes(".")) continue;
        if (related.startsWith("guardrails.") || related.startsWith("campaign.")) continue;
        expect(
          getParamDoc(related),
          `${entry.path} renvoie vers ${related}, qui n'existe pas`,
        ).toBeDefined();
      }
    }
  });

  it("les paramètres réglables ont des valeurs permises ou un exemple", () => {
    for (const entry of PARAM_DOCS) {
      if (entry.type !== "enum") continue;
      expect(entry.allowed?.length ?? 0, `${entry.path} : enum sans valeurs permises`).toBeGreaterThan(0);
      for (const value of entry.allowed ?? []) {
        expect(value.labelFr.trim().length, entry.path).toBeGreaterThan(0);
      }
    }
  });


  it("les valeurs permises documentées existent VRAIMENT dans le schéma", () => {
    // Le piège que ce test attrape : documenter « libre » alors que le schéma
    // attend « raw ». La fiche paraît juste et l'import échoue.
    let checked = 0;
    for (const entry of PARAM_DOCS) {
      if (entry.type !== "enum" || !entry.allowed) continue;
      const options = enumOptionsAt(entry.path);
      if (!options) continue;
      checked += 1;
      const documented = entry.allowed.map((a) => a.value).filter((v) => v !== null);
      for (const value of documented) {
        expect(
          options,
          `${entry.path} : « ${String(value)} » est documenté mais absent du schéma`,
        ).toContain(value);
      }
      // L'inverse compte autant : une valeur du schéma jamais documentée est
      // une option que personne ne sait utiliser.
      for (const option of options) {
        expect(
          documented,
          `${entry.path} : « ${option} » existe dans le schéma mais n'est pas documenté`,
        ).toContain(option);
      }
    }
    expect(checked, "aucun enum vérifié — le résolveur de chemin est cassé").toBeGreaterThan(5);
  });

  it("les pièges nomment un symptôme, pas seulement une consigne", () => {
    // Sur les paramètres les plus faciles à mal régler, le texte doit dire à
    // quoi ressemble l'erreur vue de l'extérieur.
    for (const path of ["approach.persistence", "approach.questionBudget", "model.model"]) {
      const entry = getParamDoc(path);
      expect(entry?.pitfallsFr, path).toBeDefined();
      expect(entry!.pitfallsFr!.length, path).toBeGreaterThan(60);
    }
  });

  it("le filtrage par section fonctionne et couvre les sections utilisées", () => {
    const sections = new Set(PARAM_DOCS.map((d) => d.section));
    for (const section of sections) {
      const list = listParamDocs(section);
      expect(list.length, section).toBeGreaterThan(0);
      expect(list.every((d) => d.section === section)).toBe(true);
    }
    expect(listParamDocs().length).toBe(PARAM_DOCS.length);
  });

  it("un chemin de repli concret hérite de la documentation du gabarit", () => {
    const template = getParamDoc("goal.fallbacks[].type");
    const concrete = getParamDoc("goal.fallbacks[0].type");
    expect(template).toBeDefined();
    expect(concrete).toBe(template);
  });
});
