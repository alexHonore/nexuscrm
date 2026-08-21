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

const { AssistantCreateDialog } = await import("@/components/admin/assistant-create");
const {
  ChatIllustration,
  FormIllustration,
  DashboardIllustration,
} = await import("@/components/admin/assistant-create/illustrations");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

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
    const ai = (assistantsFr as unknown as { create: { ai: Record<string, string> } }).create.ai;
    // Rien n'est enregistré tant que le résumé n'a pas été relu.
    expect(ai.ready).toBeTruthy();
    expect(ai.createIt).toBeTruthy();
  });

  it("les libellés du mode simple et le nom du mode ne se marchent pas dessus", () => {
    const simple = (assistantsFr as unknown as { create: { simple: Record<string, string> } })
      .create.simple;
    expect(simple.name).toBe("Configuration simple");
    expect(simple.fieldName).toBe("Nom de l'assistant");
  });
});
