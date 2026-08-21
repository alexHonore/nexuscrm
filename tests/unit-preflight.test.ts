/**
 * Unitaire — contrôle avant mise en service.
 *
 * Huit endroits du moteur peuvent, chacun, faire qu'aucun message ne parte.
 * Ce module existe pour dire LEQUEL. Un « ça ne marche pas » global renverrait
 * à la même chasse au trésor qu'il doit supprimer.
 */
import { describe, expect, it } from "vitest";
import { preflight, type PreflightFacts } from "@/lib/golive/preflight";

const NOW = new Date("2026-08-21T15:00:00Z");

/** Une installation prête à envoyer pour de vrai. */
function ready(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    mode: "live",
    rawMode: "live",
    liveConfirmed: true,
    killSwitch: false,
    killSwitchReason: null,
    hasTwilioCredentials: true,
    hasWebhookSignatureSecret: true,
    activeNumberCount: 1,
    numbersWithoutMessagingService: 0,
    consentValidity: "unlimited",
    consentedClientCount: 120,
    quietHoursLabel: "9h-20h",
    activeAssistantCount: 1,
    activeAssistantsWithRedSuite: 0,
    activeCampaignCount: 1,
    lastDispatchAt: new Date(NOW.getTime() - 30_000),
    now: NOW,
    llmProvidersConfigured: ["openrouter"],
    ...overrides,
  };
}

describe("prêt à envoyer", () => {
  it("une installation complète peut envoyer", () => {
    const report = preflight(ready());
    expect(report.canSendLive).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("chaque blocage est NOMMÉ, pas résumé", () => {
    const report = preflight(
      ready({ mode: "dry_run", killSwitch: true, activeNumberCount: 0, activeAssistantCount: 0 }),
    );
    expect(report.canSendLive).toBe(false);
    // C'est la liste qui a de la valeur : savoir « ça ne marche pas » ne
    // raccourcit aucune recherche.
    expect(report.blockers).toContain("mode");
    expect(report.blockers).toContain("kill_switch");
    expect(report.blockers).toContain("sms_number");
    expect(report.blockers).toContain("assistant_active");
  });
});

describe("les deux drapeaux du mode réel", () => {
  it("SMS_MODE=live sans confirmation NE suffit pas", () => {
    // Un déploiement qui hérite d'une variable ne doit pas se mettre à écrire.
    const report = preflight(ready({ mode: "dry_run", rawMode: "live", liveConfirmed: false }));
    expect(report.canSendLive).toBe(false);
    expect(report.blockers).toContain("mode");
    expect(report.blockers).toContain("live_confirmed");
  });

  it("hors intention « live », la confirmation absente n'est PAS un blocage", () => {
    // En simulation, SMS_LIVE_CONFIRMED n'a aucune raison d'exister : le
    // signaler comme blocage crierait au loup à chaque environnement de test.
    const report = preflight(ready({ mode: "dry_run", rawMode: undefined, liveConfirmed: false }));
    expect(report.blockers).toContain("mode");
    expect(report.blockers).not.toContain("live_confirmed");
  });
});

describe("le répartiteur, panne la plus silencieuse", () => {
  it("un répartiteur qui n'a jamais tourné bloque", () => {
    // Rien n'échoue, rien ne part : sans cette vérification, on cherche
    // ailleurs pendant des heures.
    const report = preflight(ready({ lastDispatchAt: null }));
    expect(report.blockers).toContain("dispatcher");
    expect(report.checks.find((c) => c.id === "dispatcher")?.detail).toBe("jamais");
  });

  it("un battement vieux de plus de quinze minutes bloque", () => {
    const stale = new Date(NOW.getTime() - 20 * 60 * 1000);
    expect(preflight(ready({ lastDispatchAt: stale })).blockers).toContain("dispatcher");
  });

  it("un battement récent passe", () => {
    const fresh = new Date(NOW.getTime() - 60_000);
    expect(preflight(ready({ lastDispatchAt: fresh })).blockers).not.toContain("dispatcher");
  });
});

describe("avertissements — ça partira, mais quelque chose surprendra", () => {
  it("un numéro sans service de messagerie avertit sans bloquer", () => {
    const report = preflight(ready({ numbersWithoutMessagingService: 1 }));
    expect(report.canSendLive).toBe(true);
    expect(report.warnings).toContain("messaging_service");
  });

  it("aucun consentement enregistré avertit : la campagne n'inscrira personne", () => {
    const report = preflight(ready({ consentedClientCount: 0 }));
    expect(report.canSendLive).toBe(true);
    expect(report.warnings).toContain("consented_clients");
  });

  it("un assistant ACTIF avec une suite rouge est signalé", () => {
    // Il a forcément été activé en contournant l'exigence : le signaler vaut
    // mieux que supposer que c'est impossible.
    const report = preflight(ready({ activeAssistantsWithRedSuite: 1 }));
    expect(report.warnings).toContain("assistant_suite");
  });

  it("sans secret de signature, l'entrant est forgeable — avertissement", () => {
    const report = preflight(ready({ hasWebhookSignatureSecret: false }));
    expect(report.canSendLive).toBe(true);
    expect(report.warnings).toContain("webhook_signature");
  });

  it("aucune campagne active : rien ne s'inscrira, mais l'envoi reste possible", () => {
    const report = preflight(ready({ activeCampaignCount: 0 }));
    expect(report.canSendLive).toBe(true);
    expect(report.warnings).toContain("campaign_active");
  });
});

describe("le modèle", () => {
  it("aucun fournisseur configuré bloque : l'assistant ne peut rien dire", () => {
    const report = preflight(ready({ llmProvidersConfigured: [] }));
    expect(report.blockers).toContain("llm_provider");
  });
});

describe("informations", () => {
  it("les heures de politesse et la validité du consentement sont affichées, pas jugées", () => {
    const report = preflight(ready({ consentValidity: "6m", quietHoursLabel: "9h-20h" }));
    const quiet = report.checks.find((c) => c.id === "quiet_hours");
    const consent = report.checks.find((c) => c.id === "consent_policy");
    expect(quiet?.level).toBe("info");
    expect(quiet?.detail).toBe("9h-20h");
    expect(consent?.detail).toBe("6m");
    expect(report.canSendLive).toBe(true);
  });

  it("l'interrupteur affiche SA raison", () => {
    const report = preflight(ready({ killSwitch: true, killSwitchReason: "incident Twilio" }));
    expect(report.checks.find((c) => c.id === "kill_switch")?.detail).toBe("incident Twilio");
  });
});
