/**
 * Unitaire — rendu du contrôle de mise en service.
 *
 * L'écran n'a de valeur que s'il NOMME chaque blocage et dit quoi faire. Un
 * « pas prêt » global renverrait à la chasse au trésor qu'il doit supprimer.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import assistantsFr from "../messages/fr/assistants.json";
import commonFr from "../messages/fr/common.json";
import { preflight, type PreflightFacts } from "@/lib/golive/preflight";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { GoLiveChecklist } = await import("@/components/admin/go-live-checklist");
type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

const NOW = new Date("2026-08-21T15:00:00Z");
const ready = (o: Partial<PreflightFacts> = {}): PreflightFacts => ({
  mode: "live", rawMode: "live", liveConfirmed: true, killSwitch: false, killSwitchReason: null,
  hasTwilioCredentials: true, twilioMissing: [], hasWebhookSignatureSecret: true, activeNumberCount: 1,
  numbersWithoutMessagingService: 0,
  quietHoursLabel: "9h-20h", appUrl: "https://crm.example.com", hasMessagingServiceEnv: true, activeAssistantCount: 1, activeAssistantsWithRedSuite: 0,
  activeCampaignCount: 1, lastDispatchAt: new Date(NOW.getTime() - 30_000), now: NOW,
  llmProvidersConfigured: ["openrouter"],
  assistantsMissingModelKey: [], assistantsMissingFallbackKey: [], ...o,
});

function render(facts: PreflightFacts): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { assistants: assistantsFr, common: commonFr } as unknown as IntlMessages,
      children: createElement(GoLiveChecklist, { report: preflight(facts) }),
    }),
  );
}

describe("écran de mise en service", () => {
  it("une installation prête le dit clairement", () => {
    const html = render(ready());
    expect(html).toContain("Prêt à envoyer");
  });

  it("chaque blocage est NOMMÉ et accompagné de quoi faire", () => {
    const html = render(ready({ mode: "dry_run", activeNumberCount: 0 }));
    expect(html).toContain("blocage");
    expect(html).toContain("Mode d&#x27;envoi");
    expect(html).toContain("Numéro expéditeur actif");
    // La consigne, pas seulement le constat.
    expect(html).toContain("SMS_MODE=live");
    expect(html).toContain("Ajoutez-en un");
  });

  it("le répartiteur arrêté — la panne la plus silencieuse — est expliqué", () => {
    const html = render(ready({ lastDispatchAt: null }));
    expect(html).toContain("Répartiteur");
    expect(html).toContain("s&#x27;accumulent en file");
    expect(html).toContain("Jamais");
  });

  it("blocages et avertissements sont séparés", () => {
    const html = render(ready({ numbersWithoutMessagingService: 2, hasMessagingServiceEnv: false, activeNumberCount: 0 }));
    expect(html).toContain("Blocages");
    expect(html).toContain("Avertissements");
    // Un avertissement ne mérite pas la même urgence ; les mêler ferait
    // ignorer les deux.
    expect(html.indexOf("Blocages")).toBeLessThan(html.indexOf("Avertissements"));
  });

  it("les vérifications réussies n'affichent PAS de consigne de correction", () => {
    const html = render(ready());
    expect(html).toContain("Vérifié");
    // Répéter « comment corriger » sous une ligne verte est du bruit.
    expect(html).not.toContain("Relevez-le dans les réglages");
  });

  it("la raison de l'interrupteur d'arrêt est affichée", () => {
    const html = render(ready({ killSwitch: true, killSwitchReason: "incident Twilio" }));
    expect(html).toContain("incident Twilio");
  });

  it("aucune clé i18n non résolue", () => {
    const html = render(ready({ mode: "dry_run", killSwitch: true, activeAssistantCount: 0 }));
    expect(html).not.toContain("MISSING_MESSAGE");
    expect(html).not.toMatch(/goLive\.[a-zA-Z]+/);
  });
});
