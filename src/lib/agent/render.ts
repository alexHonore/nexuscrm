/**
 * Rendu de gabarits `{{jeton}}` — utilisé pour le gabarit de tour (L7) et pour
 * l'injection du bloc d'exécution (runtime) dans le prompt compilé.
 *
 * Pur et défensif : ne lève JAMAIS, quel que soit le gabarit (accolades non
 * fermées, jetons vides, entrées farfelues). Un jeton inconnu se rend en
 * chaîne vide et est signalé une seule fois via `warnings`, jamais en levant.
 */

/** Valeur substituable dans un gabarit. */
export type TemplateValue = string | number | null | undefined;

export interface RenderResult {
  text: string;
  warnings: string[];
}

/** `{{ jeton.pointé }}` — espaces internes tolérées, clé peut contenir des points. */
const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Remplace chaque `{{clé}}` par `vars[clé]` (converti en chaîne). Une clé
 * absente de `vars` (pas seulement `null`/`undefined` — réellement absente)
 * rend "" et ajoute un avertissement dédupliqué `unknown_variable: <clé>`.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, TemplateValue>,
): RenderResult {
  const seenWarnings = new Set<string>();
  const warnings: string[] = [];

  const text = template.replace(TOKEN_RE, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      const warning = `unknown_variable: ${key}`;
      if (!seenWarnings.has(warning)) {
        seenWarnings.add(warning);
        warnings.push(warning);
      }
      return "";
    }
    const value = vars[key];
    if (value === null || value === undefined) return "";
    return String(value);
  });

  return { text, warnings };
}

const RUNTIME_TOKEN_RE = /\{\{\s*runtime\s*\}\}/;

/**
 * Injecte le bloc d'exécution (runtime) dans le prompt compilé.
 *
 * - `includeRuntimeLayer` false → le prompt est retourné inchangé.
 * - Si le prompt contient `{{runtime}}`, le bloc y est substitué.
 * - Sinon, le bloc est ajouté à la fin, séparé par une ligne vide.
 */
export function renderRuntimeIntoPrompt(
  prompt: string,
  runtimeBlock: string,
  includeRuntimeLayer: boolean,
): string {
  if (!includeRuntimeLayer) return prompt;
  if (RUNTIME_TOKEN_RE.test(prompt)) {
    return prompt.replace(RUNTIME_TOKEN_RE, () => runtimeBlock);
  }
  return `${prompt}\n\n${runtimeBlock}`;
}
