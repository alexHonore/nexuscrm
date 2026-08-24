/**
 * Unitaire — rendu de la liste et de l'éditeur de campagnes.
 *
 * Le typage ne voit ni une clé i18n manquante, ni un composant Base UI mal
 * composé, ni un chiffre qui n'atteint jamais l'écran. On rend donc pour de
 * vrai avec les messages fr-CA réels.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import campaignsFr from "../messages/fr/campaigns.json";
import commonFr from "../messages/fr/common.json";
import { campaignConfigSchema } from "@/lib/campaigns/schema";
import type { CampaignEditorData } from "@/components/admin/campaign-editor/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { CampaignEditor } = await import("@/components/admin/campaign-editor");
const { buildClientSearchQuery, hasAnyFilter } = await import(
  "@/components/admin/campaign-editor/add-clients-dialog"
);
const { CampaignsListClient } = await import("@/components/admin/campaigns-list-client");
const { LadderTab, VariantsTab, EnrollmentsTab, AudienceTab, TriggerTab } = await import(
  "@/components/admin/campaign-editor/tabs"
);

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

const CONFIG = campaignConfigSchema.parse({
  name: "Réactivation 90 j",
  description: "Vieux leads qui dorment",
  trigger: { kind: "scheduled", everyHours: 24 },
  audience: { notContactedForDays: 90 },
  ladder: [
    { delayHours: 0, body: "Bonjour, ici Groupe Nexus. Toujours un projet?", label: "ouverture" },
    { delayHours: 48, body: null, label: "l'assistant relance" },
  ],
  variants: [
    { key: "direct", weight: 70, body: "Avez-vous 15 minutes cette semaine?" },
    { key: "doux", weight: 30, body: "Toujours un projet immobilier en tête?" },
  ],
});

const DATA: CampaignEditorData = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  config: CONFIG,
  status: "active",
  assistants: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Vendeur FB", status: "active" }],
  numbers: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", e164: "+15815551234", label: "Ligne SMS" }],
  categories: [{ id: 1, name: "À rappeler" }],
  sources: [{ id: 1, name: "Facebook" }],
  users: [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Alex-Honoré" }],
  enrollments: [
    {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      clientId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      clientName: "Marie Tremblay",
      variant: "direct",
      status: "stopped",
      step: 1,
      nextTouchAt: null,
      endedAt: "2026-08-21T15:00:00.000Z",
      endReason: "suppressed",
    },
  ],
  variantStats: [
    { variant: "direct", enrolled: 70, replied: 9, stopped: 3 },
    { variant: "doux", enrolled: 30, replied: 5, stopped: 0 },
  ],
};

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

const tabProps = { config: CONFIG, update: () => {}, data: DATA };

describe("liste des campagnes", () => {
  it("montre réponses ET arrêts côte à côte", () => {
    const html = wrap(
      createElement(CampaignsListClient, {
        items: [
          {
            id: DATA.id,
            name: "Réactivation 90 j",
            description: "Vieux leads",
            status: "active",
            triggerKind: "scheduled",
            enrolled: 100,
            active: 60,
            replied: 14,
            stopped: 3,
            updatedAt: "2026-08-21T15:00:00.000Z",
          },
        ],
        archivedCount: 0,
      }),
    );
    expect(html).toContain("Réactivation 90 j");
    expect(html).toContain("Active");
    expect(html).toContain("Balayage périodique");
    // Un bon taux de réponse avec beaucoup d'arrêts n'est pas un succès : les
    // deux chiffres doivent être visibles ensemble.
    expect(html).toContain("14 réponses");
    expect(html).toContain("3 arrêts");
  });

  it("un état vide reste lisible", () => {
    const html = wrap(createElement(CampaignsListClient, { items: [], archivedCount: 0 }));
    expect(html).toContain("Aucune campagne");
    expect(html).not.toContain("MISSING_MESSAGE");
  });
});

describe("éditeur de campagne", () => {
  it("rend les six onglets", () => {
    const html = wrap(createElement(CampaignEditor, { data: DATA }));
    for (const label of ["Général", "Déclencheur", "Audience", "Échelle", "A/B", "Inscriptions"]) {
      expect(html, label).toContain(label);
    }
  });

  it("une échelle vide est signalée d'emblée", () => {
    const empty = { ...DATA, config: { ...CONFIG, ladder: [] } };
    const html = wrap(createElement(CampaignEditor, { data: empty }));
    expect(html).toContain("sans jamais leur écrire");
  });

  it("aucune clé i18n non résolue", () => {
    const html = wrap(createElement(CampaignEditor, { data: DATA }));
    expect(html).not.toContain("MISSING_MESSAGE");
    expect(html).not.toMatch(/editor\.[a-zA-Z]+\./);
    expect(html).not.toMatch(/list\.(status|trigger)\./);
  });
});

describe("onglets rendus isolément", () => {
  it("Échelle : le coût en segments est affiché, et « l'assistant rédige » aussi", () => {
    const html = wrap(createElement(LadderTab, tabProps));
    expect(html).toContain("Bonjour, ici Groupe Nexus");
    // Le nombre de segments décide du coût réel de l'envoi.
    expect(html).toMatch(/segment/);
    // Le barreau sans texte dit explicitement qui écrit.
    expect(html).toContain("Laisser l'assistant rédiger".replace(/'/g, "&#x27;"));
  });

  it("Échelle : le délai du barreau 1 est présenté comme cumulatif", () => {
    const html = wrap(createElement(LadderTab, tabProps));
    expect(html).toContain("après le barreau précédent");
    expect(html).toContain("après l&#x27;inscription");
  });

  it("A/B : les parts et les résultats par variante sont lisibles", () => {
    const html = wrap(createElement(VariantsTab, tabProps));
    expect(html).toContain("direct");
    expect(html).toContain("doux");
    // 70/(70+30) = 70 %
    expect(html).toContain("70");
    expect(html).toContain("Résultats");
  });

  it("Audience : le piège du « jamais contacté » est écrit à l'écran", () => {
    const html = wrap(createElement(AudienceTab, tabProps));
    expect(html).toContain("Jamais contacté".replace(/é/g, "é"));
    expect(html).toContain("90");
  });

  it("Inscriptions : un arrêt affiche son motif", () => {
    const html = wrap(
      createElement(EnrollmentsTab, { ...tabProps, onEnroll: () => {}, enrolling: false, onAction: () => {}, actingId: null, onBulk: () => {}, bulkBusy: false, onAdded: () => {} }),
    );
    expect(html).toContain("Marie Tremblay");
    expect(html).toContain("Arrêtée");
    // Le motif est TRADUIT : « suppressed » nu à l'écran n'explique rien.
    expect(html).toContain("Numéro désabonné");
    expect(html).not.toContain(">suppressed<");
    // Et la colonne « Terminé » existe vraiment (la clé existait, pas la colonne).
    expect(html).toContain("Terminé");
  });

  it("Inscriptions : le client mène à sa fiche, et une inscription en vol s'actionne", () => {
    const data: CampaignEditorData = {
      ...DATA,
      enrollments: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          clientId: "22222222-2222-4222-8222-222222222222",
          clientName: "Jean Bouchard",
          variant: "direct",
          status: "active",
          step: 1,
          nextTouchAt: "2026-08-25T14:00:00.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    };
    const html = wrap(
      createElement(EnrollmentsTab, {
        ...tabProps,
        data,
        onEnroll: () => {},
        enrolling: false,
        onAction: () => {},
        actingId: null,
        onBulk: () => {},
        bulkBusy: false,
        onAdded: () => {},
      }),
    );
    // Le nom mène à la fiche.
    expect(html).toContain('href="/clients/22222222-2222-4222-8222-222222222222"');
    // Un fil en vol propose pause et retrait.
    expect(html).toContain("Mettre en pause");
    expect(html).toContain("Retirer");
  });

  it("Inscriptions : une pause manuelle s'affiche « En pause » et propose « Reprendre »", () => {
    const data: CampaignEditorData = {
      ...DATA,
      enrollments: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          clientId: "44444444-4444-4444-8444-444444444444",
          clientName: "Paul Côté",
          variant: "direct",
          // L'état de pause : vivant, hors file, marqué — sans être terminé.
          status: "active",
          step: 1,
          nextTouchAt: null,
          endedAt: null,
          endReason: "paused_by_admin",
        },
      ],
    };
    const html = wrap(
      createElement(EnrollmentsTab, {
        ...tabProps,
        data,
        onEnroll: () => {},
        enrolling: false,
        onAction: () => {},
        actingId: null,
        onBulk: () => {},
        bulkBusy: false,
        onAdded: () => {},
      }),
    );
    expect(html).toContain("En pause");
    expect(html).toContain("Reprendre");
    // Le marqueur machine ne fuit jamais à l'écran, et la colonne « Terminé »
    // reste vide (une pause n'est pas une fin).
    expect(html).not.toContain("paused_by_admin");
  });

  it("Déclencheur : les QUATRE options sont visibles, chacune expliquée", () => {
    // Une liste déroulante cachait trois options sur quatre et n'expliquait le
    // choix qu'une fois fait — sur le réglage qui décide QUI reçoit un SMS.
    const html = wrap(createElement(TriggerTab, tabProps));
    for (const label of [
      "Nouveau lead",
      "Changement de catégorie",
      "Balayage périodique",
      "Manuelle",
    ]) {
      expect(html, label).toContain(label);
    }
    // La pastille colorée est la même qu'à la création.
    expect(html).toContain("#F59E0B");
  });

  it("aucun onglet ne laisse fuir une clé i18n", () => {
    for (const html of [
      wrap(createElement(TriggerTab, tabProps)),
      wrap(createElement(LadderTab, tabProps)),
      wrap(createElement(VariantsTab, tabProps)),
      wrap(createElement(AudienceTab, tabProps)),
      wrap(createElement(EnrollmentsTab, { ...tabProps, onEnroll: () => {}, enrolling: false, onAction: () => {}, actingId: null, onBulk: () => {}, bulkBusy: false, onAdded: () => {} })),
    ]) {
      expect(html).not.toContain("MISSING_MESSAGE");
      expect(html).not.toMatch(/editor\.[a-zA-Z]+\./);
    }
  });
});

describe("AddClientsDialog — recherche par filtres (pas seulement le nom)", () => {
  it("hasAnyFilter est faux à vide, vrai dès qu'UN filtre est posé", () => {
    const empty = { q: "", cats: [], srcs: [], assignees: [], never: false };
    expect(hasAnyFilter(empty)).toBe(false);
    expect(hasAnyFilter({ ...empty, cats: [3] })).toBe(true);
    expect(hasAnyFilter({ ...empty, q: "  " })).toBe(false); // espaces seuls ≠ recherche
    expect(hasAnyFilter({ ...empty, never: true })).toBe(true);
  });

  it("construit la requête /api/clients/list avec catégorie, source, assigné, statut", () => {
    const query = buildClientSearchQuery({
      q: "bouchard",
      cats: [3, 7],
      srcs: [2],
      assignees: ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
      never: true,
    });
    const p = new URLSearchParams(query);
    expect(p.get("q")).toBe("bouchard");
    expect(p.get("categoryId")).toBe("3,7"); // le « statut » du pipeline
    expect(p.get("sourceId")).toBe("2");
    expect(p.get("assignedToId")).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(p.get("filter")).toBe("never");
  });

  it("un filtre vide n'ajoute pas son paramètre", () => {
    const p = new URLSearchParams(
      buildClientSearchQuery({ q: "", cats: [], srcs: [], assignees: [], never: false }),
    );
    expect(p.get("categoryId")).toBeNull();
    expect(p.get("sourceId")).toBeNull();
    expect(p.get("filter")).toBeNull();
  });
});
