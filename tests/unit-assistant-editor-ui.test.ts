/**
 * Unitaire — rendu de la liste et de l'éditeur d'assistants.
 *
 * Onze onglets, des dizaines de champs et une aide en ligne par paramètre : le
 * typage ne voit ni une clé i18n manquante, ni un composant Base UI mal composé,
 * ni un champ dont la documentation n'arrive jamais à l'écran. On rend donc pour
 * de vrai, avec les messages fr-CA et le registre de documentation réels.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import assistantsFr from "../messages/fr/assistants.json";
import commonFr from "../messages/fr/common.json";
import { assistantConfigSchema } from "@/lib/assistants/schema";
import { PARAM_DOCS } from "@/lib/docs/params";
import type { AssistantEditorData } from "@/components/admin/assistant-editor/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { AssistantEditor } = await import("@/components/admin/assistant-editor");
const { AssistantsListClient } = await import("@/components/admin/assistants-list-client");
const { ParamDocsProvider } = await import("@/components/admin/assistant-editor/param-help");
const { ApproachTab, KnowledgeTab, ToolsTab } = await import(
  "@/components/admin/assistant-editor/tabs-basic"
);
const { PromptTab, TestTab } = await import("@/components/admin/assistant-editor/tabs-advanced");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

const DOCS = Object.fromEntries(PARAM_DOCS.map((d) => [d.path, { ...d, overridden: false }]));

const CONFIG = assistantConfigSchema.parse({
  name: "Acheteur FB",
  description: "Leads Facebook acheteurs",
  identity: { mode: "named_person", brokerName: "Alex-Honoré" },
  goal: {
    primary: {
      type: "video_meeting",
      durationMin: 30,
      appointmentType: "meet",
      requiredFields: ["project_type", "timing"],
    },
    fallbacks: [{ type: "phone_call", durationMin: 15 }],
  },
  approach: { persistence: 2 },
  knowledge: { claims: ["Nous couvrons Québec et Lévis."] },
  objectionPacks: ["buyer_fr"],
  tools: ["get_slots", "book_meeting", "stop", "handoff"],
  model: {},
});

const DATA: AssistantEditorData = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  config: CONFIG,
  status: "draft",
  version: 1,
  suitePassed: false,
  needsRecompile: true,
  compiledPrompt: "# RÔLE\nTu écris pour Groupe Nexus.",
  compiledAt: "2026-08-19T14:00:00.000Z",
  users: [
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Alex-Honoré", email: "a@nexus.test", role: "admin" },
  ],
  packs: [{ id: "buyer_fr", label: "Objections acheteur", itemCount: 4 }],
  coreRules: [
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      key: "no_price_opinion",
      label: "Aucune valeur ni prix",
      kind: "forbidden_regex",
      severity: "block",
      enabled: true,
    },
  ],
  ownRules: [],
  lastRun: {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    passed: false,
    total: 2,
    passedCount: 1,
    createdAt: "2026-08-19T15:00:00.000Z",
    results: [
      { label: "Respecte un STOP", passed: true, severity: "block", reason: null, output: "" },
      {
        label: "Ne donne pas de prix",
        passed: false,
        severity: "block",
        reason: "motif interdit détecté",
        output: "Votre maison vaut environ 450 000 $",
      },
    ],
  },
};

function renderEditor(data: Partial<AssistantEditorData> = {}): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { assistants: assistantsFr, common: commonFr } as unknown as IntlMessages,
      children: createElement(AssistantEditor, { data: { ...DATA, ...data }, docs: DOCS }),
    }),
  );
}

/**
 * Base UI ne rend QUE le panneau actif : les onglets non sélectionnés n'existent
 * pas dans le balisage. On rend donc chaque onglet directement — c'est aussi ce
 * qui prouve qu'il tient debout isolément.
 */
function renderTab(
  element: React.ReactElement,
  data: Partial<AssistantEditorData> = {},
): string {
  void data;
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { assistants: assistantsFr, common: commonFr } as unknown as IntlMessages,
      // eslint-disable-next-line react/no-children-prop
      children: createElement(ParamDocsProvider, { docs: DOCS, children: element }),
    }),
  );
}

const tabProps = { config: CONFIG, update: () => {}, data: DATA };

function renderList(items: Parameters<typeof AssistantsListClient>[0]["items"]): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { assistants: assistantsFr, common: commonFr } as unknown as IntlMessages,
      children: createElement(AssistantsListClient, { items, archivedCount: 0 }),
    }),
  );
}

describe("liste des assistants", () => {
  it("montre les trois états côte à côte", () => {
    const html = renderList([
      {
        id: DATA.id,
        name: "Acheteur FB",
        description: "Leads Facebook",
        status: "active",
        version: 3,
        goalType: "video_meeting",
        suitePassed: true,
        needsRecompile: true,
        everCompiled: true,
        hasWritten: true,
        updatedAt: "2026-08-19T15:00:00.000Z",
      },
    ]);
    expect(html).toContain("Acheteur FB");
    expect(html).toContain("Actif");
    // Le cas qui compte : actif ET prompt périmé, visible sans cliquer.
    expect(html).toContain("À recompiler");
    expect(html).toContain("Suite verte");
    expect(html).toContain("Rencontre vidéo");
  });

  it("un état vide reste lisible", () => {
    const html = renderList([]);
    expect(html).toContain("Aucun assistant");
    expect(html).not.toContain("MISSING_MESSAGE");
  });
});

describe("éditeur d'assistant", () => {
  it("rend les onze onglets", () => {
    const html = renderEditor();
    for (const label of [
      "Identité",
      "Objectif",
      "Approche",
      "Connaissances",
      "Objections",
      "Outils",
      "Garde-fous",
      "Modèle",
      "Prompt",
      "Test",
      "JSON",
    ]) {
      expect(html, label).toContain(label);
    }
  });

  it("l'avertissement de prompt périmé est visible d'emblée", () => {
    const html = renderEditor();
    expect(html).toContain("Prompt périmé");
  });

  it("un assistant ACTIF et périmé reçoit le texte qui parle des conversations en cours", () => {
    const html = renderEditor({ status: "active" });
    expect(html).toContain("conversations en cours");
  });

  it("affiche la configuration réelle, pas des valeurs par défaut", () => {
    const html = renderEditor();
    expect(html).toContain("Acheteur FB");
  });

  it("aucune clé i18n non résolue ne fuit à l'écran", () => {
    const html = renderEditor();
    expect(html).not.toContain("MISSING_MESSAGE");
    expect(html).not.toMatch(/editor\.[a-zA-Z]+\./);
    expect(html).not.toMatch(/goalType\.[a-z_]+/);
    expect(html).not.toMatch(/qualificationField\.[a-z_]+/);
    expect(html).not.toMatch(/\btool\.[a-z_]+/);
  });

  it("un assistant à jour n'affiche pas l'avertissement", () => {
    const html = renderEditor({ needsRecompile: false });
    expect(html).not.toContain("Prompt périmé");
  });

  it("un assistant jamais compilé n'affiche pas l'avertissement de péremption", () => {
    // Rien n'a jamais été compilé : il n'y a pas de décalage à signaler, juste
    // un prompt absent — c'est l'onglet Prompt qui le dit.
    const html = renderEditor({ compiledPrompt: null, needsRecompile: true });
    expect(html).not.toContain("Prompt périmé");
  });
});

describe("onglets rendus isolément", () => {
  it("Approche : l'aide en ligne de chaque paramètre atteint l'écran", () => {
    const html = renderTab(createElement(ApproachTab, tabProps));
    // Le bouton d'aide porte le libellé du paramètre : la preuve que le
    // registre est branché sur les champs, et pas seulement importé.
    expect(html).toContain("Aide — Persistance");
    expect(html).toContain("Aide — Budget de questions");
    expect(html).toContain("Aide — Longueur maximale");
  });

  it("Connaissances : les faits autorisés et l'avertissement OACIQ sont visibles", () => {
    const html = renderTab(createElement(KnowledgeTab, tabProps));
    expect(html).toContain("Nous couvrons Québec et Lévis.");
    // React échappe les apostrophes : on compare sur un fragment qui n'en a pas.
    expect(html).toContain("titulaire");
    expect(html).toContain("courtier");
  });

  it("Outils : « stop » et « handoff » ne sont pas décochables", () => {
    const html = renderTab(createElement(ToolsTab, tabProps));
    expect(html).toContain("Arrêter et désabonner");
    expect(html).toContain("Passer à un humain");
    // Deux outils marqués requis — la garantie qu'un refus reste respectable.
    expect(html.split("Requis").length - 1).toBe(2);
  });

  it("Prompt : un assistant jamais compilé le dit au lieu d'un cadre vide", () => {
    const html = renderTab(
      createElement(PromptTab, { ...tabProps, data: { ...DATA, compiledPrompt: null } }),
    );
    expect(html).toContain("Pas encore compilé");
  });

  it("Prompt : le prompt compilé est affiché quand il existe", () => {
    const html = renderTab(createElement(PromptTab, tabProps));
    expect(html).toContain("Tu écris pour Groupe Nexus.");
  });

  it("Test : les résultats de la dernière suite sont lisibles, échecs compris", () => {
    const html = renderTab(
      createElement(TestTab, { ...tabProps, onRunSuite: () => {}, running: false }),
    );
    expect(html).toContain("Respecte un STOP");
    expect(html).toContain("motif interdit détecté");
    // La réponse fautive est montrée : sans elle on ne sait pas quoi corriger.
    expect(html).toContain("450 000");
    expect(html).toContain("1/2");
  });

  it("aucun onglet ne laisse fuir une clé i18n", () => {
    for (const html of [
      renderTab(createElement(ApproachTab, tabProps)),
      renderTab(createElement(KnowledgeTab, tabProps)),
      renderTab(createElement(ToolsTab, tabProps)),
      renderTab(createElement(PromptTab, tabProps)),
      renderTab(createElement(TestTab, { ...tabProps, onRunSuite: () => {}, running: false })),
    ]) {
      expect(html).not.toContain("MISSING_MESSAGE");
      expect(html).not.toMatch(/editor\.[a-zA-Z]+\./);
    }
  });
});
