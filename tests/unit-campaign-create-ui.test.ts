/**
 * Unitaire — les trois portes de création d'une campagne.
 *
 * Une clé i18n manquante ne se voit pas au typage : elle s'affiche en
 * production sous la forme du chemin brut. Ce test lit les clés que le
 * composant demande VRAIMENT et vérifie qu'elles existent dans les deux
 * langues, puis rend la liste pour s'assurer que la porte d'entrée est là.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import campaignsEn from "../messages/en/campaigns.json";
import campaignsFr from "../messages/fr/campaigns.json";
import commonFr from "../messages/fr/common.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { CampaignCreateDialog, AiCreator, SimpleCreator, ComplexCreator } = await import(
  "@/components/admin/campaign-create"
);
const { CampaignsListClient } = await import("@/components/admin/campaigns-list-client");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

function wrap(element: React.ReactElement): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { campaigns: campaignsFr, common: commonFr } as unknown as IntlMessages,
      children: element,
    }),
  );
}

/** Chemins lus par le composant — la liste est tenue à la main, exprès. */
const REQUIRED = [
  "create.title",
  "create.subtitle",
  "create.back",
  ...["ai", "simple", "complex"].flatMap((mode) => [
    `create.${mode}.name`,
    `create.${mode}.pitch`,
    `create.${mode}.time`,
    `create.${mode}.title`,
    `create.${mode}.subtitle`,
    `create.${mode}.createIt`,
  ]),
  "create.ai.badge",
  "create.ai.prompt",
  "create.ai.example",
  "create.ai.placeholder",
  "create.ai.thinking",
  "create.ai.ready",
  "create.ai.noProvider",
  "create.ai.retry",
  "create.ai.failed",
  "create.simple.fieldName",
  "create.simple.trigger",
  "create.simple.cold",
  "create.simple.coldDays",
  "create.simple.followUps",
  "create.simple.none",
  "create.simple.noneHint",
  "create.simple.one",
  "create.simple.oneHint",
  "create.simple.two",
  "create.simple.twoHint",
  ...["lead_created", "category_changed", "scheduled", "manual"].flatMap((kind) => [
    `create.simple.triggerHint.${kind}`,
    `list.trigger.${kind}`,
  ]),
  "create.complex.note",
  "create.summary.abTest",
  "create.summary.dailyCap",
  "create.summary.ladder",
  "create.summary.now",
  "create.summary.dayN",
  "create.summary.written",
  "create.summary.byAssistant",
];

function at(messages: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
      messages,
    );
}

describe("textes des trois portes", () => {
  it("chaque chemin demandé existe en français ET en anglais", () => {
    for (const path of REQUIRED) {
      expect(typeof at(campaignsFr, path), `fr — ${path}`).toBe("string");
      expect(typeof at(campaignsEn, path), `en — ${path}`).toBe("string");
    }
  });

  it("chaque mode annonce son coût en temps", () => {
    for (const mode of ["ai", "simple", "complex"]) {
      expect(at(campaignsFr, `create.${mode}.time`), mode).toBeTruthy();
    }
  });

  it("le nom du mode et le libellé du champ « nom » ne se marchent pas dessus", () => {
    // Le piège déjà rencontré côté assistants : écraser `simple.name` avec
    // « Nom » ferait afficher « Nom » comme titre de mode.
    expect(at(campaignsFr, "create.simple.name")).toBe("Configuration simple");
    expect(at(campaignsFr, "create.simple.fieldName")).toBe("Nom de la campagne");
  });

  it("le mode complet dit qu'il crée un BROUILLON — rien ne part tout seul", () => {
    const note = String(at(campaignsFr, "create.complex.note"));
    expect(note.toLowerCase()).toContain("brouillon");
  });
});

describe("porte d'entrée dans la liste", () => {
  it("la liste vide propose de créer, sans passer par un brouillon vide", () => {
    const html = wrap(createElement(CampaignsListClient, { items: [], archivedCount: 0 }));
    expect(html).toContain("Nouvelle campagne");
    expect(html).toContain("Aucune campagne");
  });

  it("le déclencheur fourni est rendu tel quel", () => {
    const html = wrap(
      createElement(CampaignCreateDialog, {
        trigger: createElement("button", {}, "Nouvelle campagne"),
      }),
    );
    expect(html).toContain("Nouvelle campagne");
  });
});

describe("panneaux des trois modes", () => {
  const noop = () => {};

  it("le mode IA demande ce qu'on veut AVANT d'écrire quoi que ce soit", () => {
    const html = wrap(createElement(AiCreator, { busy: false, onCreate: noop }));
    expect(html).toContain("Qui voulez-vous rejoindre");
    // Rien n'est enregistré tant que le résumé n'a pas été relu.
    expect(html).not.toContain("Créer cette campagne");
  });

  it("le mode simple montre les quatre déclencheurs, avec leur explication", () => {
    const html = wrap(createElement(SimpleCreator, { busy: false, onCreate: noop }));
    for (const label of [
      "Nouveau lead",
      "Changement de catégorie",
      "Balayage périodique",
      "Manuelle",
    ]) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain("Un balayage régulier de votre base");
  });

  it("le mode simple affiche l'échelle ET le plafond avant de créer", () => {
    // Le plafond quotidien est le réglage qui, mal compris, produit une
    // campagne active qui n'écrit à personne : il doit être lisible ici.
    const html = wrap(createElement(SimpleCreator, { busy: false, onCreate: noop }));
    expect(html).toContain("échelle des messages");
    expect(html).toContain("50 personnes / jour");
    expect(html).toContain("Tout de suite");
    expect(html).toContain("rédigé par l&#x27;assistant");
  });

  it("le mode complet annonce un brouillon", () => {
    const html = wrap(createElement(ComplexCreator, { busy: false, onCreate: noop }));
    expect(html).toContain("brouillon");
    expect(html).toContain("Créer et ouvrir");
  });

  it("aucun panneau ne laisse fuir un chemin de traduction brut", () => {
    for (const [name, Panel] of [
      ["ai", AiCreator],
      ["simple", SimpleCreator],
      ["complex", ComplexCreator],
    ] as const) {
      const html = wrap(createElement(Panel, { busy: false, onCreate: noop }));
      expect(html, name).not.toContain("create.");
      expect(html, name).not.toContain("campaigns.");
    }
  });
});
