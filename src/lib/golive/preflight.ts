/**
 * Contrôle avant mise en service — module PUR.
 *
 * Il répond à UNE question : est-ce qu'un vrai SMS peut partir vers un vrai
 * numéro, maintenant? Et quand la réponse est non, il dit exactement ce qui
 * manque.
 *
 * Pourquoi une liste de vérifications explicite plutôt qu'un « ça marche » :
 * le moteur a huit endroits qui peuvent, chacun, faire qu'aucun message ne
 * parte — le mode, les deux drapeaux, l'interrupteur, le numéro, le
 * consentement, la porte d'activation de l'assistant, l'état de la campagne, le
 * répartiteur. Découvrir lequel après avoir cliqué « activer » et attendu une
 * heure est le pire chemin possible ; c'est aussi celui qu'on prend quand rien
 * ne l'énumère.
 *
 * Chaque vérification a une SÉVÉRITÉ distincte :
 *  · `blocker` — rien ne partira. Point.
 *  · `warning` — des messages partiront, mais quelque chose vous surprendra.
 *  · `info` — état à connaître, pas un problème.
 */

export const CHECK_LEVELS = ["blocker", "warning", "info"] as const;
export type CheckLevel = (typeof CHECK_LEVELS)[number];

export const CHECK_IDS = [
  "mode",
  "live_confirmed",
  "kill_switch",
  "twilio_credentials",
  "webhook_signature",
  "sms_number",
  "messaging_service",
  "consent_policy",
  "consented_clients",
  "quiet_hours",
  "assistant_active",
  "assistant_suite",
  "campaign_active",
  "dispatcher",
  "llm_provider",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface PreflightFacts {
  /** Mode résolu par le moteur — jamais la variable brute. */
  mode: "live" | "sandbox" | "dry_run";
  /** SMS_MODE tel qu'écrit dans l'environnement, pour distinguer les cas. */
  rawMode: string | undefined;
  liveConfirmed: boolean;
  killSwitch: boolean;
  killSwitchReason: string | null;
  hasTwilioCredentials: boolean;
  hasWebhookSignatureSecret: boolean;
  activeNumberCount: number;
  numbersWithoutMessagingService: number;
  consentValidity: string;
  consentedClientCount: number;
  quietHoursLabel: string;
  activeAssistantCount: number;
  /** Assistants actifs dont la suite n'est PAS verte. */
  activeAssistantsWithRedSuite: number;
  activeCampaignCount: number;
  /** Dernier passage du répartiteur, ou null s'il n'a jamais tourné. */
  lastDispatchAt: Date | null;
  now: Date;
  llmProvidersConfigured: string[];
}

export interface PreflightCheck {
  id: CheckId;
  level: CheckLevel;
  /** true = cette vérification est satisfaite. */
  ok: boolean;
  /** Détail chiffré, affiché tel quel. */
  detail?: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  /** Peut-on envoyer un vrai SMS? Faux dès qu'un blocage subsiste. */
  canSendLive: boolean;
  blockers: CheckId[];
  warnings: CheckId[];
}

/** Au-delà, on considère que le répartiteur ne tourne plus. */
const DISPATCH_STALE_MS = 15 * 60 * 1000;

export function preflight(facts: PreflightFacts): PreflightReport {
  const checks: PreflightCheck[] = [];
  const add = (id: CheckId, level: CheckLevel, ok: boolean, detail?: string) =>
    checks.push({ id, level, ok, detail });

  // ── Ce qui décide qu'un message part pour de vrai ────────────────────────
  add("mode", "blocker", facts.mode === "live", facts.mode);

  // Les DEUX drapeaux : SMS_MODE=live ne suffit pas, et c'est voulu — un
  // déploiement qui hérite d'une variable ne doit pas se mettre à écrire.
  add(
    "live_confirmed",
    facts.rawMode === "live" ? "blocker" : "info",
    facts.liveConfirmed,
    facts.liveConfirmed ? "SMS_LIVE_CONFIRMED=true" : "SMS_LIVE_CONFIRMED absent",
  );

  add("kill_switch", "blocker", !facts.killSwitch, facts.killSwitchReason ?? undefined);

  add("twilio_credentials", "blocker", facts.hasTwilioCredentials);

  // Sans secret de signature, n'importe qui peut forger un entrant : ce n'est
  // pas un blocage d'ENVOI, mais c'est une porte ouverte.
  add("webhook_signature", "warning", facts.hasWebhookSignatureSecret);

  add("sms_number", "blocker", facts.activeNumberCount > 0, `${facts.activeNumberCount}`);

  // Un numéro sans service de messagerie envoie quand même, mais perd le
  // regroupement A2P — c'est ce qui fait classer un numéro comme indésirable.
  add(
    "messaging_service",
    "warning",
    facts.numbersWithoutMessagingService === 0,
    `${facts.numbersWithoutMessagingService}`,
  );

  // ── Ce qui décide qu'il part vers QUELQU'UN ──────────────────────────────
  add("consent_policy", "info", true, facts.consentValidity);
  add(
    "consented_clients",
    "warning",
    facts.consentedClientCount > 0,
    `${facts.consentedClientCount}`,
  );
  add("quiet_hours", "info", true, facts.quietHoursLabel);

  // ── Ce qui décide qu'il dit quelque chose ────────────────────────────────
  add("llm_provider", "blocker", facts.llmProvidersConfigured.length > 0, facts.llmProvidersConfigured.join(", "));
  add("assistant_active", "blocker", facts.activeAssistantCount > 0, `${facts.activeAssistantCount}`);

  // Un assistant actif avec une suite rouge a forcément été activé en
  // contournant l'exigence : le signaler vaut mieux que le supposer impossible.
  add(
    "assistant_suite",
    "warning",
    facts.activeAssistantsWithRedSuite === 0,
    `${facts.activeAssistantsWithRedSuite}`,
  );

  add("campaign_active", "warning", facts.activeCampaignCount > 0, `${facts.activeCampaignCount}`);

  // ── Ce qui décide qu'il part TOUT COURT ──────────────────────────────────
  const dispatchFresh =
    facts.lastDispatchAt !== null &&
    facts.now.getTime() - facts.lastDispatchAt.getTime() < DISPATCH_STALE_MS;
  add(
    "dispatcher",
    "blocker",
    dispatchFresh,
    facts.lastDispatchAt === null ? "jamais" : facts.lastDispatchAt.toISOString(),
  );

  const blockers = checks.filter((c) => c.level === "blocker" && !c.ok).map((c) => c.id);
  const warnings = checks.filter((c) => c.level === "warning" && !c.ok).map((c) => c.id);

  return { checks, canSendLive: blockers.length === 0, blockers, warnings };
}
