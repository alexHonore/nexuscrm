import { enabledRules } from "./resolve";
import {
  parseRuleConfig,
  type RuleData,
  type RuleVerdict,
  type GuardrailKind,
} from "./types";

/**
 * Filtre déterministe de sortie (§11.5) — évalué AVANT tout envoi.
 *
 * Ne juge que les règles activées dont la sévérité est `block` ou `warn` :
 * une règle `off` ou désactivée ne produit AUCUN verdict (l'admin l'a éteinte,
 * rien dans le code ne la réimpose). Les critères `llm_judge` sont asynchrones
 * et évalués séparément (./judge) ; `custom_instruction` n'existe que dans le
 * prompt.
 *
 * Les raisons ne citent JAMAIS le brouillon : il contient des renseignements
 * personnels et finirait dans des journaux sans politique de purge.
 */

/** Minuscule + sans accents — « Commission » et « commissions » se valent. */
function fold(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Liens : schéma explicite, préfixe www., ET domaine nu (« groupe-nexus.com »).
 * Sans la troisième forme, « voir nos propriétés sur exemple.com » passait
 * entre les mailles alors même qu'aucun lien n'est autorisé.
 *
 * EXPORTÉ parce que le tableau de bord de délivrabilité
 * (`src/lib/deliverability/content.ts`) compte les liens des messages déjà
 * partis. Deux définitions de « lien » donneraient un écran qui reproche un
 * lien que le garde-fou laisse passer — ou l'inverse ; c'est la même expression
 * ou rien. Le drapeau `g` la rend apatride avec `String.match` / `matchAll`
 * seulement : ne jamais l'utiliser avec `.test()` ni `.exec()`.
 */
export const URL_RE =
  /(https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|net|org|ca|qc|io|co|info|biz|app|link|ly|me|shop|site|xyz)\b[^\s]*)/gi;

function hostnameOf(rawUrl: string): string | null {
  const candidate = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface FilterContext {
  /** Outils réellement appelés par le modèle à ce tour. */
  toolCallNames?: string[];
  /** Intentions détectées par le classifieur (ex. "optout"). */
  intents?: string[];
}

function evaluateRule(draft: string, rule: RuleData, ctx: FilterContext): RuleVerdict {
  const base = { key: rule.key, label: rule.label, severity: rule.severity };
  const kind: GuardrailKind = rule.kind;

  switch (kind) {
    case "forbidden_regex": {
      const config = parseRuleConfig("forbidden_regex", rule.config);
      const index = config.patterns.findIndex((pattern) =>
        new RegExp(pattern, config.flags).test(draft),
      );
      return index === -1
        ? { ...base, passed: true }
        : { ...base, passed: false, reason: `motif interdit #${index + 1}` };
    }
    case "forbidden_terms": {
      const config = parseRuleConfig("forbidden_terms", rule.config);
      const folded = fold(draft);
      const hit = config.terms.find((term) => folded.includes(fold(term)));
      return hit === undefined
        ? { ...base, passed: true }
        : { ...base, passed: false, reason: `terme interdit : ${hit}` };
    }
    case "max_chars": {
      const { max } = parseRuleConfig("max_chars", rule.config);
      return draft.length <= max
        ? { ...base, passed: true }
        : { ...base, passed: false, reason: `${draft.length} caractères (max ${max})` };
    }
    case "max_questions": {
      const { max } = parseRuleConfig("max_questions", rule.config);
      const count = (draft.match(/\?/g) ?? []).length;
      return count <= max
        ? { ...base, passed: true }
        : { ...base, passed: false, reason: `${count} questions (max ${max})` };
    }
    case "link_policy": {
      const { allowedDomains } = parseRuleConfig("link_policy", rule.config);
      const urls = draft.match(URL_RE) ?? [];
      for (const url of urls) {
        const host = hostnameOf(url);
        const allowed =
          host !== null &&
          allowedDomains.some((domain) => {
            const d = domain.toLowerCase().replace(/^\./, "");
            return host === d || host.endsWith(`.${d}`);
          });
        if (!allowed) return { ...base, passed: false, reason: `lien non autorisé (${host ?? "?"})` };
      }
      return { ...base, passed: true };
    }
    case "required_tool_on_intent": {
      const config = parseRuleConfig("required_tool_on_intent", rule.config);
      const intentPresent = ctx.intents?.includes(config.intent) ?? false;
      if (!intentPresent) return { ...base, passed: true };
      const called = ctx.toolCallNames?.includes(config.tool) ?? false;
      return called
        ? { ...base, passed: true }
        : { ...base, passed: false, reason: `outil « ${config.tool} » non appelé (intention ${config.intent})` };
    }
    // Asynchrone (./judge) et purement prompt : rien à décider ici.
    case "llm_judge":
    case "custom_instruction":
      return { ...base, passed: true };
  }
}

/**
 * Une règle dont la config ne se lit pas (jsonb édité à la main, fichier
 * importé bricolé) ÉCHOUE au lieu de lever : lever ferait avorter le tour
 * entier — aucune réponse, aucune trace, personne d'averti — alors qu'un
 * verdict rouge bloque l'envoi proprement et se voit dans le fil.
 */
function evaluateRuleSafely(draft: string, rule: RuleData, ctx: FilterContext): RuleVerdict {
  try {
    return evaluateRule(draft, rule, ctx);
  } catch (err) {
    return {
      key: rule.key,
      label: rule.label,
      severity: rule.severity,
      passed: false,
      reason: `garde-fou illisible : ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    };
  }
}

/** Verdicts des règles déterministes, dans l'ordre résolu. */
export function evaluateOutputRules(
  draft: string,
  rules: RuleData[],
  ctx: FilterContext = {},
): RuleVerdict[] {
  return enabledRules(rules).map((rule) => evaluateRuleSafely(draft, rule, ctx));
}

/** Les règles `block` en échec — non vide = l'envoi est refusé (§11.5). */
export function blockingFailures(verdicts: RuleVerdict[]): RuleVerdict[] {
  return verdicts.filter((v) => !v.passed && v.severity === "block");
}
