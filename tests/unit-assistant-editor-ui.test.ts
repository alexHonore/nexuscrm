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
import assistantsEn from "../messages/en/assistants.json";
import commonFr from "../messages/fr/common.json";
import { ASSISTANT_TOOLS, assistantConfigSchema } from "@/lib/assistants/schema";
import { resolveParamDoc } from "@/lib/docs/locale";
import { PARAM_DOCS } from "@/lib/docs/params";
import type { AssistantEditorData } from "@/components/admin/assistant-editor/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { AssistantEditor } = await import("@/components/admin/assistant-editor");
const { AssistantsListClient } = await import("@/components/admin/assistants-list-client");
const { ParamDocsProvider } = await import("@/components/admin/assistant-editor/param-help");
const { ApproachTab, KnowledgeTab, ObjectionsTab, ToolsTab } = await import(
  "@/components/admin/assistant-editor/tabs-basic"
);
const { PromptTab, TestTab } = await import("@/components/admin/assistant-editor/tabs-advanced");
const { GoalTab, IdentityTab } = await import("@/components/admin/assistant-editor/tabs-basic");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

// Le serveur envoie des fiches DÉJÀ résolues dans la langue de la requête.
const DOCS = Object.fromEntries(
  PARAM_DOCS.map((d) => [d.path, resolveParamDoc({ ...d, overridden: false }, "fr")]),
);

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
  packs: [
    {
      id: "buyer_fr",
      label: "Objections acheteur",
      language: "fr-CA",
      isBuiltin: true,
      items: [
        {
          key: "deja_courtier",
          triggerHint: "j'ai déjà un courtier",
          acknowledge: "c'est correct de commencer par regarder",
          reframe: "un deuxième avis ne vous engage à rien",
          ask: "quinze minutes cette semaine?",
        },
      ],
    },
  ],
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

  it("chaque pastille de la carte porte un pictogramme À CÔTÉ de son libellé", () => {
    // Cinq lectures — objectif, service, compilation, suite — et pas une qui
    // repose sur la seule teinte du texte : chacune est un dessin distinct
    // doublé du mot. Le compte tombe si quelqu'un enlève un `LookIcon` ou
    // recycle le même sur deux lectures.
    const html = renderList([
      {
        id: DATA.id,
        name: "Acheteur FB",
        description: null,
        status: "active",
        version: 3,
        goalType: "in_person_meeting",
        suitePassed: false,
        needsRecompile: true,
        everCompiled: true,
        hasWritten: true,
        updatedAt: "2026-08-19T15:00:00.000Z",
      },
    ]);
    // Les libellés arrivent ENTIERS : rien n'est remplacé par une pastille.
    for (const label of ["Rencontre en personne", "Actif", "À recompiler", "Suite rouge"]) {
      expect(html, label).toContain(label);
    }
    // …et chaque pastille est muette pour un lecteur d'écran, qui entend déjà
    // le libellé juste à côté.
    const glyphs = html.match(/<svg[^>]*/g) ?? [];
    expect(glyphs.filter((g) => !g.includes('aria-hidden="true"')), "pictogramme annoncé").toEqual(
      [],
    );
    // Quatre dessins DIFFÉRENTS : les quatre lectures ne se confondent pas.
    const paths = new Set((html.match(/<path d="[^"]+"/g) ?? []).map((p) => p));
    expect(paths.size).toBeGreaterThanOrEqual(4);
  });

  it("un objectif inconnu venu de la base n'abat pas la page", () => {
    // `goalType` est un cast, pas une validation : la colonne `goal` est du
    // JSON libre. Un type qu'aucun pictogramme ne connaît doit dégrader la
    // pastille, pas faire tomber toute la liste des assistants.
    const html = renderList([
      {
        id: DATA.id,
        name: "Acheteur FB",
        description: null,
        status: "active",
        version: 1,
        goalType: "objectif_venu_du_futur" as never,
        suitePassed: true,
        needsRecompile: false,
        everCompiled: true,
        hasWritten: false,
        updatedAt: "2026-08-19T15:00:00.000Z",
      },
    ]);
    expect(html).toContain("Acheteur FB");
    expect(html).toContain("Actif");
  });

  it("un statut inconnu venu de la base reste une pastille lisible", () => {
    const html = renderList([
      {
        id: DATA.id,
        name: "Acheteur FB",
        description: null,
        status: "statut_venu_du_futur",
        version: 1,
        goalType: "video_meeting",
        suitePassed: true,
        needsRecompile: false,
        everCompiled: true,
        hasWritten: false,
        updatedAt: "2026-08-19T15:00:00.000Z",
      },
    ]);
    expect(html).toContain("Acheteur FB");
    expect(html).toContain("Rencontre vidéo");
  });

  it("un état vide reste lisible", () => {
    const html = renderList([]);
    expect(html).toContain("Aucun assistant");
    expect(html).not.toContain("MISSING_MESSAGE");
  });
});

describe("éditeur d'assistant", () => {
  it("rend tous les onglets, en vocabulaire d'affaires", () => {
    const html = renderEditor();
    // « Prompt », « Test » et « JSON » ne disent rien à un courtier : les
    // libellés décrivent ce qu'on y fait.
    for (const label of [
      "Identité",
      "Objectif",
      "Approche",
      "Connaissances",
      "Objections",
      "Outils",
      "Garde-fous",
      "Modèle",
      "Texte final",
      "Essayer",
      "Vérification",
      "Avancé (JSON)",
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

  it("l'en-tête dit QUEL assistant on édite, et dans quel état", () => {
    // L'écran n'affichait le nom nulle part : il vivait dans le champ « Nom »
    // du premier onglet, et l'état (en service? prompt à jour? suite verte?)
    // n'apparaissait pas du tout. On ouvrait un assistant sans savoir lequel.
    const html = renderEditor({ status: "active", suitePassed: false, needsRecompile: true });
    expect(html).toContain("Acheteur FB");
    expect(html).toContain("Actif");
    expect(html).toContain("À recompiler");
    expect(html).toContain("Suite rouge");
    expect(html).toContain("v1");
  });

  it("les douze onglets sont rangés par famille, chaque famille titrée", () => {
    // Une barre d'une seule ligne montrait trois onglets et demi, le quatrième
    // coupé au bord, sans rien qui dise qu'il y en avait huit de plus.
    const html = renderEditor();
    for (const group of ["Ce qu", "Ce qui le fait marcher", "Ce qui le vérifie", "Matière brute"]) {
      expect(html, group).toContain(group);
    }
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

  it("Approche : les heures de travail (fenêtre d'envoi) sont réglables par jour", () => {
    const html = renderTab(createElement(ApproachTab, tabProps));
    expect(html).toContain("Heures de travail");
    for (const day of ["Semaine (lun.–ven.)", "Samedi", "Dimanche"]) {
      expect(html, day).toContain(day);
    }
    // Aucune clé i18n nue de la section.
    expect(html).not.toContain("MISSING_MESSAGE");
    expect(html).not.toMatch(/editor\.approach\.hours/);
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

  it("Objectif : le type choisi est EXPLIQUÉ sous le sélecteur", () => {
    // Base UI ne rend les options qu'à l'ouverture : c'est la ligne visible
    // sous le champ qu'on vérifie ici. Choisir entre sept objectifs sur leur
    // seul nom demanderait de deviner.
    const html = renderTab(createElement(GoalTab, tabProps));
    expect(html).toContain("Réserve une visioconférence");

    const qualify = {
      ...tabProps,
      config: {
        ...CONFIG,
        goal: { primary: { ...CONFIG.goal.primary, type: "qualify_only" as const }, fallbacks: [] },
      },
    };
    expect(renderTab(createElement(GoalTab, qualify))).toContain("Ne propose JAMAIS");
  });

  it("Objectif : on ne demande PLUS où la rencontre a lieu — le type le dit déjà", () => {
    // « Rencontre vidéo » et « Rencontre en personne » sont déjà la réponse à
    // « où ». Poser la question à côté du type, c'était demander deux fois la
    // même chose et permettre de se contredire. La valeur reste dérivée du
    // type dans le schéma ; c'est le CHAMP qui disparaît.
    const html = renderTab(createElement(GoalTab, tabProps));
    expect(html).not.toContain("Où la rencontre a lieu");
    expect(html).not.toContain("En visioconférence");
  });

  it("Objectif : une exigence LIBRE s'ajoute à côté des huit connues", () => {
    // Les huit clés ne couvrent pas « nombre de chambres ».
    const custom = {
      ...tabProps,
      config: {
        ...CONFIG,
        goal: {
          ...CONFIG.goal,
          primary: {
            ...CONFIG.goal.primary,
            requiredFields: ["project_type", "nombre de chambres"],
          },
        },
      },
    };
    const html = renderTab(createElement(GoalTab, custom));
    expect(html).toContain("nombre de chambres");
    // …et le champ pour en ajouter une est là.
    expect(html).toContain("Autre information à obtenir");
  });

  it("Objectif : chaque cran porte sa consigne de formulation", () => {
    // L'objectif dit CE QU'ON CHERCHE ; la consigne dit COMMENT le demander.
    const html = renderTab(createElement(GoalTab, tabProps));
    expect(html).toContain("présente-le comme un appel court");
  });

  it("Identité : choisir un compte remplit le nom, et l'aperçu de signature se voit", () => {
    const html = renderTab(createElement(IdentityTab, tabProps));
    expect(html).toContain("Saisir librement");
    expect(html).toContain("Alex-Honoré");
    // Aperçu de ce qui sera réellement ajouté aux messages.
    expect(html).toContain("Aperçu de la signature");
  });

  it("Identité : la signature libre ouvre un champ de texte", () => {
    const custom = {
      ...tabProps,
      config: {
        ...CONFIG,
        identity: { ...CONFIG.identity, signature: "custom" as const, signatureText: "— L'équipe" },
      },
    };
    const html = renderTab(createElement(IdentityTab, custom));
    expect(html).toContain("L&#x27;équipe");
  });

  it("aucun onglet ne laisse fuir une clé i18n", () => {
    for (const html of [
      renderTab(createElement(ApproachTab, tabProps)),
      renderTab(createElement(KnowledgeTab, tabProps)),
      renderTab(createElement(ToolsTab, tabProps)),
      renderTab(createElement(PromptTab, tabProps)),
      renderTab(createElement(TestTab, { ...tabProps, onRunSuite: () => {}, running: false })),
      renderTab(createElement(GoalTab, tabProps)),
      renderTab(createElement(IdentityTab, tabProps)),
    ]) {
      expect(html).not.toContain("MISSING_MESSAGE");
      expect(html).not.toMatch(/editor\.[a-zA-Z]+\./);
      // Les huit champs de qualification (dont « sector » et
      // « preferred_time », renommés sans que les libellés ne suivent).
      expect(html).not.toMatch(/qualificationField\.[a-z_]+/);
      // …et les outils. Le contrôle ne portait que sur l'éditeur complet, qui
      // n'affiche QUE l'onglet actif : « set_category » a donc vécu plusieurs
      // versions en montrant sa clé brute dans l'onglet Outils.
      expect(html).not.toMatch(/\btool\.[a-z_]+/);
    }
  });

  it("chaque outil du schéma porte un libellé dans LES DEUX langues", () => {
    // Ajouter un outil, c'est toucher au schéma ; les deux fichiers de
    // messages sont ailleurs et restent en arrière sans que rien ne le dise.
    for (const tool of ASSISTANT_TOOLS) {
      expect(assistantsFr.tool, `fr — ${tool}`).toHaveProperty(tool);
      expect(assistantsEn.tool, `en — ${tool}`).toHaveProperty(tool);
    }
  });

  it("chaque onglet annonce CE QU'ON Y RÈGLE, dans les deux langues", () => {
    // Douze onglets nommés d'un mot : « Approche » ou « Objectif » ne disent
    // pas ce qu'on y trouve avant de l'avoir ouvert. L'aide d'en-tête le dit,
    // et un onglet ajouté sans elle ne doit pas passer.
    for (const id of Object.keys(assistantsFr.editor.tabs)) {
      expect(assistantsFr.editor.tabHint, `fr — ${id}`).toHaveProperty(id);
      expect(assistantsEn.editor.tabHint, `en — ${id}`).toHaveProperty(id);
    }
  });

  it("Objectif : chaque champ de qualification a un libellé, et les champs imposés sont verrouillés", () => {
    const html = renderTab(createElement(GoalTab, tabProps));
    expect(html).toContain("Secteur");
    expect(html).toContain("Moment préféré");
    // « type de projet » est imposé par une rencontre vidéo : coché, non décochable.
    expect(html).toMatch(/imposé par l(&#x27;|')objectif/);

    const email = {
      ...tabProps,
      config: {
        ...CONFIG,
        goal: {
          primary: { ...CONFIG.goal.primary, type: "collect_email" as const, requiredFields: [] },
          fallbacks: [],
        },
      },
    };
    const emailHtml = renderTab(createElement(GoalTab, email));
    // Le courriel est coché d'office pour « obtenir le courriel », même si la
    // config (non normalisée) ne le liste pas.
    expect(emailHtml).toMatch(/imposé par l(&#x27;|')objectif/);
  });

  it("Test : un vert dont le drapeau a été effacé est signalé comme périmé", () => {
    const green = { ...DATA.lastRun!, passed: true, passedCount: 2 };
    const stale = renderTab(
      createElement(TestTab, {
        ...tabProps,
        data: { ...DATA, lastRun: green, suitePassed: false },
        onRunSuite: () => {},
        running: false,
      }),
    );
    expect(stale).toContain("Résultat périmé");
    const fresh = renderTab(
      createElement(TestTab, {
        ...tabProps,
        data: { ...DATA, lastRun: green, suitePassed: true },
        onRunSuite: () => {},
        running: false,
      }),
    );
    expect(fresh).not.toContain("Résultat périmé");
    expect(fresh).toContain("Dernière exécution");
  });
});

describe("paquets d'objections — un éditeur, pas des cases", () => {
  it("ouvre le contenu : les quatre temps d'une objection sont éditables", () => {
    // C'était le manque : on cochait un paquet écrit par quelqu'un d'autre
    // sans pouvoir en lire une ligne, alors qu'une objection est ce qu'un
    // courtier reformule sans arrêt.
    const html = renderTab(createElement(ObjectionsTab, tabProps));
    expect(html).toContain("Objections acheteur");
    // La case reste : elle décide de ce que CET assistant mobilise.
    expect(html).toContain('type="checkbox"');
    // …et le paquet s'ouvre pour être corrigé.
    expect(html).toContain("Nouveau paquet");
    expect(html).toContain("1 objection");
  });

  it("dit que le contenu est PARTAGÉ — cocher et corriger ne font pas la même chose", () => {
    // Corriger un paquet change ce que répondent tous les assistants qui
    // l'utilisent ; le laisser croire local serait le piège.
    const html = renderTab(createElement(ObjectionsTab, tabProps));
    expect(html).toContain("partagé");
  });

  it("aucune clé de traduction ne fuit", () => {
    const html = renderTab(createElement(ObjectionsTab, tabProps));
    expect(html).not.toContain("editor.objections.");
    expect(html).not.toContain("MISSING_MESSAGE");
  });
});
