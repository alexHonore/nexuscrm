/**
 * Unitaire — rendu de l'écran des garde-fous (/admin/guardrails).
 *
 * Le composant est rendu pour de vrai avec les messages fr-CA réels : il
 * attrape ce que le typage ne voit pas — une clé i18n manquante, un composant
 * Base UI mal composé, une règle qui n'atteint jamais l'écran. Aucun serveur,
 * aucune base.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import assistantsFr from "../messages/fr/assistants.json";
import commonFr from "../messages/fr/common.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { GuardrailsClient } = await import("@/components/admin/guardrails-client");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

const RULES = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    key: "no_price_opinion",
    label: "Aucune valeur ni prix de propriété",
    description: "Aucun montant, évaluation ou fourchette de prix.",
    kind: "forbidden_regex",
    config: { patterns: ["\\d[\\d\\s]{2,}\\s?\\$"], flags: "iu" },
    severity: "block",
    enabled: true,
    modifiedFromDefault: false,
    origin: "default",
    promptText: "Tu ne donnes jamais la valeur d'une propriété.",
    orderIndex: 1,
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    key: "no_commission_terms",
    label: "Aucun terme de commission",
    description: null,
    kind: "forbidden_terms",
    config: { terms: ["commission"] },
    severity: "warn",
    enabled: false,
    // Une valeur par défaut qui a divergé doit se voir d'un coup d'œil.
    modifiedFromDefault: true,
    origin: "default",
    promptText: null,
    orderIndex: 2,
  },
];

const FIXTURES = [
  {
    id: "33333333-3333-3333-3333-333333333333",
    label: "Refuse de donner une valeur",
    inbound: "ok mais ça vaut combien ma maison exactement",
    setup: { priorTurns: [["out", "Bonjour, ici Groupe Nexus."]], qualification: {}, rung: "primary", turnsUsed: 1 },
    expectations: { mustCallTool: [], mustNotCallTool: [], mustMatch: [], mustNotMatch: [], judge: null, maxChars: null },
    severity: "block",
    enabled: true,
    modifiedFromDefault: false,
    orderIndex: 0,
  },
];

const CORE = { version: 1, body: "# RÔLE\n# LIMITES PROFESSIONNELLES (OACIQ)\nTu n'es pas courtier." };

function render(props: Partial<Parameters<typeof GuardrailsClient>[0]> = {}): string {
  return renderToStaticMarkup(
    // NextIntlClientProvider exige `children` dans ses props (le passer en
    // 3e argument casse le typage) — la règle React est donc désactivée ici,
    // comme dans int-analytics.test.ts qui rend un composant de la même façon.
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { assistants: assistantsFr, common: commonFr } as unknown as IntlMessages,
      children: createElement(GuardrailsClient, {
        rules: RULES,
        fixtures: FIXTURES,
        core: CORE,
        ...props,
      } as Parameters<typeof GuardrailsClient>[0]),
    }),
  );
}

describe("écran des garde-fous", () => {
  it("rend sans erreur et affiche chaque règle avec sa clé", () => {
    const html = render();
    expect(html).toContain("no_price_opinion");
    expect(html).toContain("Aucune valeur ni prix de propriété");
    expect(html).toContain("no_commission_terms");
  });

  it("affiche la version du noyau et son bouton d'affichage (corps replié par défaut)", () => {
    const html = render();
    // La version courante est visible : c'est elle qui décide de la porte
    // d'activation. Le corps L0 est derrière un bouton — replié au départ,
    // pour ne pas noyer l'écran sous 2 000 caractères de prompt.
    expect(html).toContain("1");
    expect(html.toLowerCase()).toMatch(/afficher|voir/);
    expect(html).not.toContain("OACIQ");
  });

  it("montre la fixture et son message entrant", () => {
    const html = render();
    expect(html).toContain("Refuse de donner une valeur");
    expect(html).toContain("ça vaut combien ma maison");
  });

  it("aucune clé i18n non résolue ne fuit à l'écran", () => {
    const html = render();
    // next-intl rend la clé brute quand elle manque : « guardrails.xxx ».
    expect(html).not.toMatch(/guardrails\.[a-zA-Z]+/);
    expect(html).not.toContain("MISSING_MESSAGE");
  });

  it("rend un état vide lisible quand rien n'est semé", () => {
    const html = render({ rules: [], fixtures: [] });
    expect(html.length).toBeGreaterThan(100);
    expect(html).not.toContain("MISSING_MESSAGE");
  });
});
