import "server-only";

/**
 * Dépense IA RÉELLE du COMPTE OpenRouter (API /credits).
 *
 * Les traces de tour somment ce que chaque appel a coûté — mais ce comptage a
 * une histoire : avant le correctif du 2026-08-26, le coût n'était jamais
 * demandé au routeur (`usage.include` absent) et seul le dernier appel d'un
 * tour était compté (ni classifieur, ni juges, ni régénérations). La page
 * montrait 0,92 $ pendant que le compte en avait brûlé 7,14 $.
 *
 * Ce chiffre-ci vient du FOURNISSEUR : dépense à vie et crédits achetés du
 * compte. Il ne se découpe pas par période, mais il ne ment pas — c'est
 * l'ancre contre laquelle vérifier la somme des traces, exactement comme le
 * coût Twilio réel ancre l'estimation par segments.
 *
 * Retour `null` quand la clé n'est pas configurée ou que l'API est
 * injoignable : l'appelant affiche alors la somme des traces, seule.
 */

const OPENROUTER_TIMEOUT_MS = 10_000;

export type OpenRouterAccountUsage = {
  /** Dépense à vie du compte ($ US). */
  totalUsageUsd: number;
  /** Crédits achetés à vie ($ US). */
  totalCreditsUsd: number;
};

export async function getOpenRouterAccountUsage(
  env: Record<string, string | undefined> = process.env,
): Promise<OpenRouterAccountUsage | null> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const baseUrl = (env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  try {
    const res = await fetch(`${baseUrl}/credits`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { total_credits?: unknown; total_usage?: unknown };
    };
    const usage = Number(json.data?.total_usage);
    const credits = Number(json.data?.total_credits);
    if (!Number.isFinite(usage)) return null;
    return {
      totalUsageUsd: usage,
      totalCreditsUsd: Number.isFinite(credits) ? credits : 0,
    };
  } catch {
    return null;
  }
}
