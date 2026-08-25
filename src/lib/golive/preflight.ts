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
 * la porte d'activation de l'assistant, l'état de la campagne, le
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
  "app_url",
  "live_confirmed",
  "kill_switch",
  "twilio_credentials",
  "webhook_signature",
  "sms_number",
  "messaging_service",
  "quiet_hours",
  "assistant_active",
  "assistant_suite",
  "campaign_active",
  "dispatcher",
  "llm_provider",
  "assistant_model_keys",
  "assistant_fallback_keys",
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
  /**
   * Le transport peut-il RÉELLEMENT partir? Pas « des identifiants existent » :
   * `getSmsProvider` exige compte + paire de clé API + Messaging Service, et
   * retombe en dry_run sans les trois. Vérifier moins ici dirait « prêt »
   * pendant que le moteur refuse d'envoyer — exactement ce que ce contrôle
   * existe pour empêcher.
   */
  hasTwilioCredentials: boolean;
  /** Détail de ce qui manque, pour que le message soit actionnable. */
  twilioMissing: string[];
  hasWebhookSignatureSecret: boolean;
  /** NEXT_PUBLIC_APP_URL — l'URL que Twilio appelle et que la signature suppose. */
  appUrl: string | null;
  /** TWILIO_MESSAGING_SERVICE_SID présent : c'est lui que le chemin d'envoi utilise. */
  hasMessagingServiceEnv: boolean;
  activeNumberCount: number;
  numbersWithoutMessagingService: number;
  quietHoursLabel: string;
  activeAssistantCount: number;
  /** Assistants actifs dont la suite n'est PAS verte. */
  activeAssistantsWithRedSuite: number;
  activeCampaignCount: number;
  /** Dernier passage du répartiteur, ou null s'il n'a jamais tourné. */
  lastDispatchAt: Date | null;
  now: Date;
  llmProvidersConfigured: string[];
  /**
   * Assistants ACTIFS dont le générateur ou le classifieur pointe un
   * fournisseur SANS clé (« Nom : fournisseur »). Une clé peut exister au
   * global (`llm_provider` vert) pendant qu'un assistant en vise une autre —
   * c'est le trou que ce contrôle bouche.
   */
  assistantsMissingModelKey: string[];
  /**
   * Assistants actifs dont le REPLI n'a pas de clé. Les messages partent quand
   * même (le principal répond), mais à la première panne le repli « réglé
   * exactement pour ça » lèvera au lieu de rattraper — l'incident du
   * 2026-08-25 (repli anthropic sans ANTHROPIC_API_KEY).
   */
  assistantsMissingFallbackKey: string[];
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

  add(
    "twilio_credentials",
    "blocker",
    facts.hasTwilioCredentials,
    facts.twilioMissing.length > 0 ? facts.twilioMissing.join(", ") : undefined,
  );

  // Sans secret de signature, n'importe qui peut forger un entrant : ce n'est
  // pas un blocage d'ENVOI, mais c'est une porte ouverte.
  add("webhook_signature", "warning", facts.hasWebhookSignatureSecret);
  // L'URL publique sert au rappel de statut ET à la signature des webhooks :
  // absente ou en http, chaque entrant est refusé en silence.
  add(
    "app_url",
    "warning",
    facts.appUrl !== null && facts.appUrl.startsWith("https://"),
    facts.appUrl ?? undefined,
  );

  add("sms_number", "blocker", facts.activeNumberCount > 0, `${facts.activeNumberCount}`);

  // Un numéro sans service de messagerie envoie quand même, mais perd le
  // regroupement A2P — c'est ce qui fait classer un numéro comme indésirable.
  // C'est la variable d'environnement que le chemin d'envoi utilise ; la
  // colonne par numéro n'est qu'informative.
  add(
    "messaging_service",
    "warning",
    facts.hasMessagingServiceEnv || facts.numbersWithoutMessagingService === 0,
    facts.hasMessagingServiceEnv ? undefined : `${facts.numbersWithoutMessagingService}`,
  );

  // ── Ce qui décide qu'il part vers QUELQU'UN ──────────────────────────────
  add("quiet_hours", "info", true, facts.quietHoursLabel);

  // ── Ce qui décide qu'il dit quelque chose ────────────────────────────────
  add("llm_provider", "blocker", facts.llmProvidersConfigured.length > 0, facts.llmProvidersConfigured.join(", "));
  // Une clé au global ne suffit pas : chaque assistant actif doit pouvoir
  // joindre SES fournisseurs — générateur et classifieur (bloquant), et le
  // repli (avertissement : ça envoie, mais la première panne surprendra).
  add(
    "assistant_model_keys",
    "blocker",
    facts.assistantsMissingModelKey.length === 0,
    facts.assistantsMissingModelKey.join(" · ") || undefined,
  );
  add(
    "assistant_fallback_keys",
    "warning",
    facts.assistantsMissingFallbackKey.length === 0,
    facts.assistantsMissingFallbackKey.join(" · ") || undefined,
  );
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
    // Pas de texte ici : le module est pur et l'écran traduit l'absence.
    facts.lastDispatchAt === null ? undefined : facts.lastDispatchAt.toISOString(),
  );

  const blockers = checks.filter((c) => c.level === "blocker" && !c.ok).map((c) => c.id);
  const warnings = checks.filter((c) => c.level === "warning" && !c.ok).map((c) => c.id);

  return { checks, canSendLive: blockers.length === 0, blockers, warnings };
}
