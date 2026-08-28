/**
 * Unitaire — l'écran de délivrabilité rend de vraies phrases, dans les deux
 * langues, et ne ment jamais par omission.
 *
 * Trois régressions que ces cas empêchent, dans l'ordre de gravité :
 *
 *  · **Une clé absente.** next-intl rend alors le chemin brut
 *    (`deliverability.numbers.title`) au milieu d'un tableau — visible en
 *    production, invisible au typage. Une clé qui n'existe qu'en français
 *    échappe à tout rendu français : c'est la parité fr/en qui l'attrape.
 *  · **« Inconnu » peint en vert.** Un indicateur calculé sur onze messages
 *    doit se lire « — » et « pas assez de données », jamais comme un succès.
 *    C'est la seule confusion de cet écran qui coûte de l'argent : on croit
 *    surveiller ce qu'on ne surveille pas.
 *  · **Un constat sans destination.** Le lien « Corriger ici » est ce qui
 *    transforme une liste de chiffres en liste de tâches. S'il disparaît, la
 *    page redevient un rapport qu'on regarde une fois.
 *
 * `renderToStaticMarkup` échappe les apostrophes (`d&#x27;`) : on cherche donc
 * des fragments sans apostrophe, jamais des phrases entières.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import adminFr from "../messages/fr/admin.json";
import adminEn from "../messages/en/admin.json";
import commonFr from "../messages/fr/common.json";
import { DeliverabilityFindings } from "@/components/admin/deliverability-findings";
import { DeliverabilityTemplates } from "@/components/admin/deliverability-templates";
import type { Finding, TemplateCluster } from "@/lib/deliverability/types";

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

function render(node: React.ReactNode, locale: "fr" | "en" = "fr"): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale,
      messages: {
        admin: locale === "fr" ? adminFr : adminEn,
        common: commonFr,
      } as unknown as IntlMessages,
      children: node,
    }),
  );
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "carrier_filtered",
    severity: "danger",
    family: "delivery",
    title: "Des messages sont filtres par un operateur",
    why: "Le code 30007 veut dire que le message a ete jete sans etre remis.",
    fix: "Retirez le lien raccourci et mettez l adresse complete.",
    deepLink: "/admin/campaigns/abc?tab=ladder",
    external: false,
    subject: "Relance printemps",
    evidence: {
      metric: "filtered_rate",
      value: 0.043,
      threshold: 0.01,
      unit: "rate",
      samples: [{ label: "Barreau 0", excerpt: "Bonjour, une occasion a Levis" }],
    },
    ...overrides,
  };
}

const cluster = (o: Partial<TemplateCluster> = {}): TemplateCluster => ({
  representativeBody: "Bonjour Marie, une occasion a Levis",
  messages: 600,
  distinctRecipients: 590,
  distinctSendingNumbers: 1,
  ...o,
});

/** Aucun chemin de clé ne doit survivre au rendu. */
function expectNoRawKeys(html: string) {
  expect(html, "next-intl a rendu un chemin de clé au lieu d'un texte").not.toContain(
    "MISSING_MESSAGE",
  );
  expect(html, "un chemin de clé apparaît à l'écran").not.toMatch(/deliverability\.[a-zA-Z]+\./);
}

describe("liste des constats", () => {
  it("rend un titre, un pourquoi, un geste et un lien de correction", () => {
    const html = render(createElement(DeliverabilityFindings, { findings: [finding()], moreCount: 0 }));
    expectNoRawKeys(html);
    expect(html).toContain("filtres par un operateur");
    expect(html).toContain("Retirez le lien raccourci");
    expect(html, "sans lien, la page redevient un rapport").toContain(
      'href="/admin/campaigns/abc?tab=ladder"',
    );
    expect(html).toContain("Corriger ici");
  });

  it("un lien externe s'ouvre ailleurs et le dit", () => {
    const html = render(
      createElement(DeliverabilityFindings, {
        findings: [
          finding({
            id: "smart_encoding_off",
            family: "engine",
            severity: "warn",
            deepLink: "https://console.twilio.com/us1/develop/sms/services",
            external: true,
          }),
        ],
        moreCount: 0,
      }),
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("Twilio");
  });

  it("le plus grave passe devant", () => {
    const html = render(
      createElement(DeliverabilityFindings, {
        findings: [
          finding({ id: "ucs2_inflation", severity: "info", title: "AAA_INFO", family: "content" }),
          finding({ id: "carrier_filtered", severity: "danger", title: "ZZZ_DANGER" }),
        ],
        moreCount: 0,
      }),
    );
    expect(html.indexOf("ZZZ_DANGER"), "un danger sous un simple avis").toBeLessThan(
      html.indexOf("AAA_INFO"),
    );
  });

  it("rien à corriger se lit comme un succès calme, pas comme une erreur", () => {
    const html = render(createElement(DeliverabilityFindings, { findings: [], moreCount: 0 }));
    expectNoRawKeys(html);
    expect(html).toContain("Rien");
  });

  it("les constats non affichés sont COMPTÉS, jamais tus", () => {
    const html = render(createElement(DeliverabilityFindings, { findings: [finding()], moreCount: 7 }));
    expect(html).toContain("7");
  });

  it("un constat de contenu affiche la phrase sur les barreaux non gardés", () => {
    // C'est la phrase la plus utile de l'écran : un barreau écrit à la main ne
    // passe par AUCUN garde-fou, et rien d'autre dans le produit ne le dit.
    const html = render(
      createElement(DeliverabilityFindings, {
        findings: [finding({ id: "merge_field_leak", family: "content" })],
        moreCount: 0,
      }),
    );
    expect(html).toMatch(/garde-fou/i);
  });

  it("« inconnu » se lit « — », jamais comme un bon chiffre", () => {
    const html = render(
      createElement(DeliverabilityFindings, {
        findings: [
          finding({
            evidence: { metric: "filtered_rate", value: null, threshold: null, unit: "rate", samples: [] },
          }),
        ],
        moreCount: 0,
      }),
    );
    expect(html).toContain("—");
    expect(html).toContain("Trop peu de messages");
  });

  it("l'anglais rend de l'anglais, sans clé manquante", () => {
    const html = render(
      createElement(DeliverabilityFindings, { findings: [finding()], moreCount: 3 }),
      "en",
    );
    expectNoRawKeys(html);
    expect(html).toContain("Fix this here");
    expect(html, "une phrase française a survécu à la bascule").not.toMatch(/[«»]/);
  });

  it("« 0 autres cas » ne s'affiche jamais", () => {
    // Le drapeau de troncature se posait sur une valeur en MINUTES : « 8 902 »
    // minutes depuis le dernier passage du répartiteur devenait « 0 autres cas
    // non affichés », une phrase qui n'a jamais rien voulu dire.
    const html = render(
      createElement(DeliverabilityFindings, {
        findings: [
          finding({
            id: "dispatcher_stale",
            family: "engine",
            evidence: {
              metric: "dispatcher_age",
              value: 8902,
              threshold: 60,
              unit: "minutes",
              samples: [],
              truncated: true,
            },
          }),
        ],
        moreCount: 0,
      }),
    );
    expect(html).not.toContain("0 autres cas");
  });

  it("les cas réellement cachés sont comptés", () => {
    const html = render(
      createElement(DeliverabilityFindings, {
        findings: [
          finding({
            id: "suppression_leak",
            family: "consent",
            evidence: {
              metric: "suppression_leak",
              value: 42,
              threshold: 0,
              unit: "count",
              samples: [{ label: "…0142" }],
              truncated: true,
            },
          }),
        ],
        moreCount: 0,
      }),
    );
    expect(html).toContain("41");
  });
});

describe("gabarits envoyés", () => {
  it("un gabarit porté par plusieurs numéros est marqué, pas seulement coloré", () => {
    const html = render(
      createElement(DeliverabilityTemplates, {
        templates: { clusters: [cluster({ distinctSendingNumbers: 3 })], scanned: 12, truncated: false },
      }),
    );
    expectNoRawKeys(html);
    // Le nombre de numéros ET une phrase : la couleur seule ne porte jamais le
    // sens, et « 3 » sans explication ne dit pas qu'il s'agit d'essaimage.
    expect(html).toContain("3");
    expect(html).toMatch(/num[ée]ros/i);
  });

  it("un balayage tronqué le DIT", () => {
    // Sinon l'opérateur corrige les vingt premiers groupes en croyant avoir
    // tout couvert.
    const html = render(
      createElement(DeliverabilityTemplates, {
        templates: { clusters: [cluster()], scanned: 20_000, truncated: true },
      }),
    );
    expect(html).toMatch(/tronqu/i);
  });

  it("aucun gabarit se dit, plutôt que de rendre un tableau vide", () => {
    const html = render(
      createElement(DeliverabilityTemplates, {
        templates: { clusters: [], scanned: 0, truncated: false },
      }),
    );
    expectNoRawKeys(html);
    expect(html).toMatch(/Aucun message/i);
  });
});
