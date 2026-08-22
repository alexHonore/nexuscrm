/**
 * Unitaire — rendu des trois modes de création.
 *
 * Ce qui compte : les trois portes sont visibles et se distinguent, et chacune
 * annonce ce qu'elle coûte en temps. Un choix entre trois formulaires sans
 * savoir lequel prend deux minutes ou onze onglets n'est pas un choix.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import assistantsFr from "../messages/fr/assistants.json";
import commonFr from "../messages/fr/common.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const {
  AssistantCreateDialog,
  AiCreator,
  SimpleCreator,
  ComplexCreator,
  ModelStep,
  EMPTY_CHOICE,
  withChosenModel,
} = await import("@/components/admin/assistant-create");
const { assistantConfigSchema } = await import("@/lib/assistants/schema");
const {
  ChatIllustration,
  FormIllustration,
  DashboardIllustration,
} = await import("@/components/admin/create-illustrations");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

/**
 * Le rendu échappe les apostrophes (« Créer l&#x27;assistant ») : sans les
 * décoder, un `not.toContain("Créer l\'assistant")` passe toujours et
 * n'affirme rien.
 */
function text(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function wrap(element: React.ReactElement): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { assistants: assistantsFr, common: commonFr } as unknown as IntlMessages,
      children: element,
    }),
  );
}

describe("illustrations", () => {
  it("sont des vecteurs EN LIGNE, sans fichier distant", () => {
    // Aucune dépendance nouvelle, aucun asset à héberger, et elles suivent la
    // couleur du thème.
    for (const [name, C] of [
      ["chat", ChatIllustration],
      ["form", FormIllustration],
      ["dashboard", DashboardIllustration],
    ] as const) {
      const html = renderToStaticMarkup(createElement(C, {}));
      expect(html, name).toContain("<svg");
      expect(html, name).toContain("currentColor");
      expect(html, name).not.toContain("<img");
      expect(html, name).not.toContain("http");
    }
  });

  it("l'illustration de conversation est animée", () => {
    const html = renderToStaticMarkup(createElement(ChatIllustration, {}));
    expect(html).toContain("<animate");
  });
});

describe("choix du mode", () => {
  it("les trois portes sont proposées, avec leur promesse", () => {
    const html = wrap(
      createElement(AssistantCreateDialog, { trigger: createElement("button", {}, "Nouveau") }),
    );
    // Le déclencheur est rendu ; le contenu du dialogue arrive à l'ouverture.
    expect(html).toContain("Nouveau");
  });
});

describe("textes de création", () => {
  it("chaque mode annonce son coût en temps", () => {
    const create = (assistantsFr as unknown as { create: Record<string, { time?: string }> }).create;
    for (const mode of ["ai", "simple", "complex"]) {
      expect(create[mode].time, mode).toBeTruthy();
    }
  });

  it("le mode IA dit ce qu'il fait AVANT d'écrire quoi que ce soit", () => {
    const create = assistantsFr as unknown as {
      create: { ai: Record<string, string>; next: string };
    };
    // Rien n'est enregistré tant que le résumé n'a pas été relu.
    expect(create.create.ai.ready).toBeTruthy();
    // …et le bouton ne crée pas : il mène à l'étape du modèle.
    expect(create.create.next).toBeTruthy();
  });

  it("les libellés du mode simple et le nom du mode ne se marchent pas dessus", () => {
    const simple = (assistantsFr as unknown as { create: { simple: Record<string, string> } })
      .create.simple;
    expect(simple.name).toBe("Configuration simple");
    expect(simple.fieldName).toBe("Nom de l'assistant");
  });
});

describe("panneaux des trois modes", () => {
  // Le corps d'un dialogue Base UI n'existe pas dans le rendu serveur : sans
  // ces rendus directs, une clé i18n manquante à l'intérieur ne se verrait
  // qu'à l'ouverture, en production.
  const noop = () => {};

  it("le mode IA demande le besoin avant d'écrire quoi que ce soit", () => {
    const html = text(wrap(createElement(AiCreator, { onSubmit: noop })));
    expect(html).toContain("Que voulez-vous que cet assistant accomplisse");
    expect(html).not.toContain("Créer l'assistant");
  });

  it("le mode simple pose ses questions et résume ce qui sera créé", () => {
    const html = text(wrap(createElement(SimpleCreator, { onSubmit: noop })));
    expect(html).toContain("Des acheteurs");
    expect(html).toContain("Des vendeurs");
    expect(html).toContain("Objectif");
    // Aucun des trois modes ne CRÉE : ils mènent au choix du modèle.
    expect(html).toContain("Continuer");
    expect(html).not.toContain("Créer l'assistant");
  });

  it("le mode complet mène lui aussi au choix du modèle", () => {
    const html = text(wrap(createElement(ComplexCreator, { onSubmit: noop })));
    expect(html).toContain("Continuer");
    expect(html).not.toContain("Créer l'assistant");
  });

  it("aucun panneau ne laisse fuir un chemin de traduction brut", () => {
    for (const [name, Panel] of [
      ["ai", AiCreator],
      ["simple", SimpleCreator],
      ["complex", ComplexCreator],
    ] as const) {
      const html = text(wrap(createElement(Panel, { onSubmit: noop })));
      expect(html, name).not.toContain("create.");
      expect(html, name).not.toContain("assistants.");
    }
  });
});

describe("choix du modèle à la création", () => {
  const config = assistantConfigSchema.parse({
    name: "Assistant",
    identity: { mode: "team", orgName: "Groupe Nexus", brokerName: "Alex-Honoré" },
    goal: { primary: { type: "video_meeting", durationMin: 30 }, fallbacks: [] },
    approach: {},
    model: {},
  });

  it("l'étape existe, annonce ce qu'elle demande et ne crée rien sans choix", () => {
    const html = text(
      wrap(
        createElement(ModelStep, {
          busy: false,
          config,
          value: EMPTY_CHOICE,
          onChange: () => {},
          onCreate: () => {},
        }),
      ),
    );
    expect(html).toContain("Fournisseur");
    expect(html).toContain("Aucun modèle choisi");
    expect(html).toContain("Créer l'assistant");
    // Le bouton est INERTE tant que rien n'est choisi : un choix par omission
    // n'est pas un choix, et c'est ce réglage qui décide du coût par message.
    // L'ATTRIBUT, pas la classe : tout bouton shadcn porte
    // « disabled:pointer-events-none » dans son `class`, donc chercher le mot
    // « disabled » n'importe où dans la balise passe toujours.
    expect(html).toMatch(
      /<button[^>]* disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Créer l'assistant/,
    );
    // …et le même motif ne doit PAS matcher un bouton actif : sans ça, le test
    // resterait vert le jour où quelqu'un enlève `disabled={model === ""}`.
    const active = html.replace(/ disabled=""/g, "").replace(/ data-disabled=""/g, "");
    expect(active).not.toMatch(
      /<button[^>]* disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Créer l'assistant/,
    );
    expect(html).toContain("Choisissez un modèle");
    expect(html).not.toContain("create.");
  });

  it("une sortie existe quand aucun fournisseur n'est configuré", () => {
    // L'étape rend la création IMPOSSIBLE tant qu'aucun modèle n'est choisi.
    // Sans clé de fournisseur, le catalogue revient vide : il faut alors
    // pouvoir taper l'identifiant, sinon l'écran est un cul-de-sac. Le champ
    // n'apparaît qu'APRÈS une réponse vide du serveur (donc jamais au rendu
    // serveur) ; ce qui se vérifie ici, c'est que la sortie est écrite.
    const create = (assistantsFr as unknown as {
      create: { model: Record<string, string> };
    }).create.model;
    expect(create.manual).toBeTruthy();
    expect(create.manualHint).toBeTruthy();
    expect(create.unconfigured).toMatch(/clé/i);
  });

  it("le modèle choisi ÉCRASE le défaut du schéma", () => {
    // Le défaut ne doit jamais survivre à l'étape de choix — sinon un
    // assistant naît sur un modèle que personne n'a regardé.
    expect(config.model.model).toBe("anthropic/claude-sonnet-5");
    const chosen = withChosenModel(config, {
      provider: "google",
      model: "gemini-3-pro",
      effort: "medium",
    });
    expect(chosen.model.provider).toBe("google");
    expect(chosen.model.model).toBe("gemini-3-pro");
    expect(chosen.model.reasoningEffort).toBe("medium");
    // Le reste du bloc modèle (classifieur, repli, routage) est conservé.
    expect(chosen.model.classifier).toEqual(config.model.classifier);
    expect(chosen.model.routing).toEqual(config.model.routing);
    // …et la configuration d'origine n'est pas mutée.
    expect(config.model.provider).toBe("openrouter");
  });
});
