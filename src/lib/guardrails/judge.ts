/**
 * Règles `llm_judge` — évaluées par le modèle classifieur, dans un appel
 * SÉPARÉ qui ne voit que le critère et la sortie (jamais l'historique complet).
 *
 * Échoue FERMÉ : une réponse illisible est un échec, pas un laissez-passer.
 * Une règle bloquante ne doit jamais passer parce que le juge a bafouillé.
 */

export interface JudgeInput {
  criterion: string;
  output: string;
  /** Contexte minimal (message entrant, objectif courant) — facultatif. */
  context?: string;
  /**
   * Position du brouillon dans la conversation.
   *
   * Indispensable : plusieurs critères en dépendent explicitement (« s'il
   * s'agit du PREMIER message… »). Sans cette information, le juge ne peut pas
   * appliquer son propre critère, et comme il échoue fermé il refuse TOUT —
   * c'est ce qui bloquait chaque réponse au milieu d'une conversation.
   */
  isFirstOutbound?: boolean;
}

export interface JudgeVerdict {
  passed: boolean;
  reason: string;
}

export type JudgeGenerate = (prompt: { system: string; user: string }) => Promise<string>;

const JUDGE_SYSTEM = `Tu es un évaluateur de conformité. On te donne un critère et la réponse d'un assistant SMS.
Tu réponds UNIQUEMENT par un objet JSON, sans aucun texte autour, exactement de cette forme :
{"passed": true, "reason": "…"}
« passed » vaut true seulement si la réponse respecte pleinement le critère.
« reason » est une phrase courte en français qui justifie la décision.`;

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Le modèle a parfois enrobé le JSON de prose ou de balises de code.
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export async function judgeWithLlm(input: JudgeInput, generate: JudgeGenerate): Promise<JudgeVerdict> {
  const user = [
    `Critère : ${input.criterion}`,
    input.isFirstOutbound === undefined
      ? null
      : input.isFirstOutbound
        ? "Position : c'est le PREMIER message sortant de cette conversation."
        : "Position : ce n'est PAS le premier message sortant ; l'assistant a déjà écrit à cette personne.",
    input.context ? `Contexte : ${input.context}` : null,
    `Réponse de l'assistant : ${input.output}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");

  let raw: string;
  try {
    raw = await generate({ system: JUDGE_SYSTEM, user });
  } catch {
    return { passed: false, reason: "judge_error" };
  }

  const parsed = extractJson(raw);
  if (parsed === null || typeof parsed !== "object") {
    return { passed: false, reason: "judge_unparseable" };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.passed !== "boolean") {
    return { passed: false, reason: "judge_unparseable" };
  }
  return {
    passed: record.passed,
    reason: typeof record.reason === "string" && record.reason.trim() !== "" ? record.reason : "—",
  };
}
