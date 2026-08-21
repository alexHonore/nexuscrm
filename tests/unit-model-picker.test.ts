/**
 * Unitaire — entonnoir de choix du modèle.
 *
 * Le catalogue OpenRouter compte 420 modèles. Ce qui compte ici, ce n'est pas
 * qu'ils s'affichent, c'est que ceux qu'on NE DOIT PAS proposer disparaissent,
 * et que l'étape « réflexion » n'apparaisse que là où elle fonctionne.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import assistantsFr from "../messages/fr/assistants.json";
import commonFr from "../messages/fr/common.json";
import { LABS, UNKNOWN_LAB, isFloatingAlias, isInteractiveModel, labIdOf, labOf } from "@/lib/llm/labs";
import type { ModelDescriptor } from "@/lib/llm/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { ModelPicker } = await import("@/components/admin/model-picker");
type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

const MODELS: ModelDescriptor[] = [
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", contextTokens: 1000000, supportsTools: true, supportsReasoning: true, inputPerMTok: 2 },
  { id: "anthropic/claude-sonnet-5:batch", label: "Claude Sonnet 5 (batch)", contextTokens: 1000000, supportsTools: true, inputPerMTok: 1 },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", contextTokens: 1048576, supportsTools: true, supportsReasoning: false, inputPerMTok: 0.3 },
  { id: "mistralai/mistral-large", label: "Mistral Large", contextTokens: 128000, supportsTools: true, inputPerMTok: 2 },
  { id: "someone/free-model:free", label: "Gratuit", contextTokens: 8000, supportsTools: false },
];

function render(
  value = "anthropic/claude-sonnet-5",
  effort: "none" | "low" | "medium" | "high" = "none",
  messages: Record<string, unknown> = { assistants: assistantsFr, common: commonFr },
) {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: messages as unknown as IntlMessages,
      children: createElement(ModelPicker, {
        models: MODELS, loading: false, value, effort,
        onChange: () => {}, onReload: () => {},
      }),
    }),
  );
}

describe("registre des laboratoires", () => {
  it("reconnaît un identifiant OpenRouter", () => {
    expect(labIdOf("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(labOf("anthropic/claude-sonnet-5").name).toBe("Anthropic");
    expect(labOf("mistralai/mistral-large").color).toBe("#FA520F");
  });

  it("un laboratoire inconnu reçoit un gris neutre, pas une couleur inventée", () => {
    const lab = labOf("inconnu-xyz/modele");
    expect(lab.name).toBe("inconnu-xyz");
    expect(LABS["inconnu-xyz"]).toBeUndefined();
    // …et la note générique, pas une note inventée.
    expect(lab.noteKey).toBe(UNKNOWN_LAB.noteKey);
  });

  it("un identifiant sans préfixe ne fait pas planter", () => {
    expect(labIdOf("modele-sans-slash")).toBe("autre");
  });

  it("un même laboratoire ne se dédouble PAS sous deux préfixes", () => {
    // OpenRouter publie « ~anthropic/claude-sonnet-latest » à côté de
    // « anthropic/claude-sonnet-5 ». Sans normalisation, l'entonnoir montre
    // deux tuiles Anthropic : une à sa couleur, une grise.
    expect(labIdOf("~anthropic/claude-sonnet-latest")).toBe("anthropic");
    expect(labOf("~anthropic/claude-sonnet-latest").name).toBe("Anthropic");
    expect(labIdOf("meta/muse-spark-1.2")).toBe("meta-llama");
    expect(labOf("meta/muse-spark-1.2").name).toBe("Meta");
  });

  it("un alias flottant est SIGNALÉ, pas masqué", () => {
    // Derrière « -latest » le modèle change sans prévenir : un assistant dont
    // le prompt et les garde-fous ont été réglés répond autrement du jour au
    // lendemain, sans qu'aucune configuration n'ait bougé.
    expect(isFloatingAlias("~anthropic/claude-sonnet-latest")).toBe(true);
    expect(isFloatingAlias("google/gemini-flash-latest")).toBe(true);
    expect(isFloatingAlias("openrouter/auto")).toBe(true);
    expect(isFloatingAlias("anthropic/claude-sonnet-5")).toBe(false);
    // Signalé ≠ écarté : il reste choisissable.
    expect(isInteractiveModel("~anthropic/claude-sonnet-latest")).toBe(true);
  });

  it("les variantes différées et gratuites sont ÉCARTÉES", () => {
    // Moins chères à l'affichage, inutilisables pour un assistant qui répond
    // à un client : une exécution `:batch` arrive parfois des heures plus tard.
    expect(isInteractiveModel("anthropic/claude-sonnet-5")).toBe(true);
    expect(isInteractiveModel("anthropic/claude-sonnet-5:batch")).toBe(false);
    expect(isInteractiveModel("someone/free-model:free")).toBe(false);
  });

  it("la note d'un laboratoire est une CLÉ i18n, pas une phrase en dur", () => {
    // Un administrateur anglophone lisait des notes en français : le texte vit
    // dans messages/<locale>/assistants.json sous model.labNote.<clé>.
    for (const lab of Object.values(LABS)) {
      expect(lab.noteKey, lab.id).toBe(lab.id);
      expect(lab).not.toHaveProperty("noteFr");
    }
    expect(UNKNOWN_LAB.noteKey).toBe("autre");
  });
});

describe("entonnoir", () => {
  it("s'ouvre sur les LABORATOIRES, pas sur 400 identifiants", () => {
    const html = render();
    expect(html).toContain("Anthropic");
    expect(html).toContain("Google");
    expect(html).toContain("Mistral");
    // L'étape des modèles n'est pas encore affichée.
    expect(html).not.toContain("Gemini 2.5 Flash");
  });

  it("les variantes écartées ne sont comptées nulle part", () => {
    const html = render();
    // Anthropic n'a qu'UN modèle utilisable sur les deux fournis.
    expect(html).toContain("Anthropic");
    expect(html).not.toContain("batch");
    expect(html).not.toContain("Gratuit");
  });

  it("la sélection courante reste visible pendant la navigation", () => {
    const html = render("anthropic/claude-sonnet-5");
    expect(html).toContain("Claude Sonnet 5");
    expect(html).toContain("anthropic/claude-sonnet-5");
  });

  it("un effort actif est affiché sur la sélection", () => {
    const html = render("anthropic/claude-sonnet-5", "high");
    expect(html).toContain("Élevée");
  });

  it("aucun effort n'affiche aucune pastille", () => {
    const html = render("anthropic/claude-sonnet-5", "none");
    expect(html).not.toContain("Élevée");
  });

  it("les trois étapes sont annoncées", () => {
    const html = render();
    expect(html).toContain("Laboratoire");
    expect(html).toContain("Modèle");
    expect(html).toContain("Réflexion");
  });

  it("aucune clé i18n non résolue", () => {
    const html = render();
    expect(html).not.toContain("MISSING_MESSAGE");
    expect(html).not.toMatch(/model\.(step|effort|labNote)\./);
  });

  it("la note d'un laboratoire vient des messages de la locale", () => {
    // Avec la clé présente, la note s'affiche traduite…
    const withNotes = {
      common: commonFr,
      assistants: {
        ...assistantsFr,
        model: { ...assistantsFr.model, labNote: { anthropic: "Note de test Anthropic" } },
      },
    };
    const html = render("anthropic/claude-sonnet-5", "none", withNotes);
    expect(html).toContain("Note de test Anthropic");
    // …et une clé absente (Google, Mistral ici) ne laisse fuir ni clé brute
    // ni phrase dans la mauvaise langue.
    expect(html).not.toContain("labNote");
    expect(html).not.toContain("Rapide et peu coûteux");
  });
});
