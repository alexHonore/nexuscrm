/**
 * Unitaire — sections SMS et IA de la page de consommation.
 *
 * Le rendu vérifie ce que le typage ne voit pas : une clé i18n manquante, un
 * chiffre qui n'atteint pas l'écran, ou le badge « estimation » qui doit
 * accompagner le SMS (dépense estimée, pas facturée).
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import adminFr from "../messages/fr/admin.json";
import commonFr from "../messages/fr/common.json";
import type { ConsumptionReport } from "@/components/admin/consumption-sections";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { ConsumptionSections } = await import("@/components/admin/consumption-sections");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

const nf = new Intl.NumberFormat("fr-CA");
const money = (n: number | null) => (n === null ? "—" : n.toFixed(2));

function wrap(data: ConsumptionReport | null): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { admin: adminFr, common: commonFr } as unknown as IntlMessages,
      children: createElement(ConsumptionSections, {
        data,
        loading: false,
        error: data === null,
        money,
        nf,
        moneyAxis: (n: number) => String(n),
        dayLabel: (d: string) => d.slice(5),
        onRateSaved: () => {},
      }),
    }),
  );
}

const DATA: ConsumptionReport = {
  from: "2026-08-01",
  to: "2026-08-31",
  ai: {
    turns: 3,
    tokensIn: 340,
    tokensOut: 150,
    costUsd: 0.035,
    byModel: [
      { model: "claude-sonnet-5", turns: 2, tokensIn: 300, tokensOut: 130, costUsd: 0.03 },
      { model: "gpt-4o-mini", turns: 1, tokensIn: 40, tokensOut: 20, costUsd: 0.005 },
    ],
    daily: [
      { date: "2026-08-01", costUsd: 0.02 },
      { date: "2026-08-02", costUsd: 0.015 },
    ],
    account: { totalUsageUsd: 7.14, totalCreditsUsd: 15 },
  },
  sms: {
    outboundMessages: 2,
    outboundSegments: 3,
    inboundMessages: 1,
    inboundSegments: 1,
    segmentCostUsd: 0.0079,
    estimatedCostUsd: 0.0316,
    realCostUsd: null,
    costSource: "estimate",
    costUsd: 0.0316,
    carrierFeesUsd: null,
    dailyVolume: [
      {
        date: "2026-08-01",
        outboundMessages: 2,
        outboundSegments: 3,
        inboundMessages: 1,
        inboundSegments: 1,
      },
      {
        date: "2026-08-02",
        outboundMessages: 0,
        outboundSegments: 0,
        inboundMessages: 0,
        inboundSegments: 0,
      },
    ],
    dailyCost: null,
    balance: { balanceUsd: 12.29, currency: "USD" },
  },
  transcripts: {
    calls: 4,
    audioSeconds: 720,
    tokensIn: 5200,
    tokensOut: 610,
    costUsd: 0.048,
    failed: 1,
    skipped: 2,
    byModel: [
      {
        model: "google/gemini-2.5-flash",
        calls: 4,
        audioSeconds: 720,
        tokensIn: 5200,
        tokensOut: 610,
        costUsd: 0.048,
      },
    ],
    daily: [
      { date: "2026-08-01", costUsd: 0.048 },
      { date: "2026-08-02", costUsd: 0 },
    ],
  },
};

describe("ConsumptionSections", () => {
  it("montre le coût IA réel par modèle et les segments SMS estimés", () => {
    const html = wrap(DATA);
    // IA — le modèle et son coût réel.
    expect(html).toContain("claude-sonnet-5");
    expect(html).toContain("gpt-4o-mini");
    expect(html).toContain("0.03");
    // SMS — badge « estimation » et les segments comptés.
    expect(html).toContain("estimation");
    expect(html).toContain("Segments");
    // L'ANCRE du compte OpenRouter : dépense à vie et crédits restants —
    // le seul chiffre IA qui ne dépende pas de notre propre comptage.
    expect(html).toContain("Compte OpenRouter");
    expect(html).toContain("7.14");
    expect(html).toContain("Crédits restants");
    // Notes d'appel — appels résumés, minutes et coût réel par modèle.
    // (renderToStaticMarkup encode l'apostrophe en &#x27;)
    expect(html).toContain("Notes d&#x27;appel (IA)");
    expect(html).toContain("google/gemini-2.5-flash");
    expect(html).toContain("Appels résumés");
    expect(html).toContain("0.05"); // money(0.048)
    // Aucune clé i18n nue.
    expect(html).not.toContain("MISSING_MESSAGE");
    expect(html).not.toMatch(/billing\.[a-zA-Z]+/);
  });

  it("états vides : le dit sans planter, dans les trois sections", () => {
    const empty: ConsumptionReport = {
      ...DATA,
      ai: { turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, byModel: [], daily: [], account: null },
      sms: { outboundMessages: 0, outboundSegments: 0, inboundMessages: 0, inboundSegments: 0, segmentCostUsd: 0.0079, estimatedCostUsd: 0, realCostUsd: null, costSource: "estimate", costUsd: 0, carrierFeesUsd: null, dailyVolume: [], dailyCost: null, balance: null },
      transcripts: { calls: 0, audioSeconds: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, failed: 0, skipped: 0, byModel: [], daily: [] },
    };
    const html = wrap(empty);
    expect(html).toContain("Aucun tour");
    expect(html).toContain("Aucun SMS");
    expect(html).toContain("Aucune note d&#x27;appel");
    expect(html).not.toContain("MISSING_MESSAGE");
  });

  it("coût réel de Twilio : badge « réel » et coût facturé, pas l'estimation", () => {
    const real: ConsumptionReport = {
      ...DATA,
      sms: { ...DATA.sms, realCostUsd: 1.23, costSource: "twilio", costUsd: 1.23 },
    };
    const html = wrap(real);
    expect(html).toContain("réel");
    expect(html).toContain("1.23"); // le coût facturé
    expect(html).toContain("facturé par Twilio");
  });

  it("frais de transporteur inconnus : « indisponible », jamais 0,00 $", () => {
    // La catégorie `sms` de Twilio n'inclut PAS les frais de transporteur.
    // Tant qu'on ne les a pas, la ligne le DIT — l'afficher à 0 $ reviendrait à
    // affirmer qu'il n'y en a pas.
    const html = wrap(DATA);
    // L'assertion vise la LIGNE des frais, pas le mot « indisponible » posé
    // ailleurs sur la page : sinon un message d'erreur voisin la satisferait.
    expect(html).toMatch(/Frais de transporteur<\/span><span[^>]*italic[^>]*>indisponible</);
    // Et quand on les a, c'est un montant.
    const withFees: ConsumptionReport = {
      ...DATA,
      sms: { ...DATA.sms, carrierFeesUsd: 0.42 },
    };
    expect(wrap(withFees)).toContain("0.42");
  });

  it("un seul modèle : pas de graphique à une barre, le tableau suffit", () => {
    // Une valeur seule est une TUILE de chiffre, pas un graphique : sous deux
    // barres, le classement ne se dessine pas. Les notes d'appel n'ont qu'un
    // modèle dans DATA ; en ajouter un second doit faire apparaître un
    // graphique de plus, et un seul.
    const count = (html: string) => (html.match(/recharts-responsive-container/g) ?? []).length;
    const withTwo: ConsumptionReport = {
      ...DATA,
      transcripts: {
        ...DATA.transcripts,
        byModel: [
          ...DATA.transcripts.byModel,
          {
            model: "openai/whisper-1",
            calls: 1,
            audioSeconds: 60,
            tokensIn: 10,
            tokensOut: 5,
            costUsd: 0.004,
          },
        ],
      },
    };
    expect(count(wrap(withTwo))).toBe(count(wrap(DATA)) + 1);
    // Le tableau, lui, montre le modèle unique dans les deux cas : la valeur
    // n'est jamais perdue avec le graphique.
    expect(wrap(DATA)).toContain("google/gemini-2.5-flash");
  });

  it("échec de chargement : « indisponible », JAMAIS « zéro » (honnêteté)", () => {
    // data null + error → message d'indisponibilité, pas les états vides « rien ».
    const html = wrap(null);
    expect(html).toContain("indisponibles");
    expect(html).not.toContain("Aucun tour");
    expect(html).not.toContain("Aucun SMS");
  });
});
