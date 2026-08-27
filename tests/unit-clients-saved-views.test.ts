/**
 * Unitaire — les vues enregistrées survivent à l'ajout d'un filtre.
 *
 * Ces vues dorment dans le `localStorage` du navigateur : elles ont été
 * écrites par des versions antérieures de l'écran et ne connaissent pas les
 * filtres ajoutés depuis. Une vue d'hier doit continuer de montrer EXACTEMENT
 * ce qu'elle montrait — un filtre inconnu se lit « aucun », jamais « vide donc
 * rien ne correspond ».
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { normalizeSavedView } = await import("@/components/clients/saved-views");
type SavedView = Parameters<typeof normalizeSavedView>[0];

/** Une vue telle qu'écrite AVANT l'existence du filtre de campagne. */
const legacyView = {
  id: "v1",
  name: "Mes chauds",
  q: "tremblay",
  categoryIds: [3],
  sourceIds: ["1"],
  assignedToIds: [],
  statuses: ["overdue"],
  languages: ["fr"],
  createdMode: "none",
  createdFrom: "",
  createdTo: "",
  updatedMode: "none",
  updatedFrom: "",
  updatedTo: "",
  sortKey: "activity",
  sortDir: "desc",
  view: "list",
} as unknown as SavedView;

describe("vues enregistrées", () => {
  it("§ une vue d'avant le filtre de campagne ne filtre AUCUNE campagne", () => {
    const state = normalizeSavedView(legacyView);
    // Liste vide = « toutes », par la convention de l'écran (« ne rien cocher
    // = tout voir »). Le reste de la vue est intact.
    expect(state.campaignIds).toEqual([]);
    expect(state.q).toBe("tremblay");
    expect(state.categoryIds).toEqual([3]);
    expect(state.statuses).toEqual(["overdue"]);
  });

  it("une vue qui porte des campagnes les rend telles quelles", () => {
    const state = normalizeSavedView({
      ...legacyView,
      campaignIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "none"],
    } as unknown as SavedView);
    expect(state.campaignIds).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "none"]);
  });

  it("une valeur corrompue ne fait pas planter la restauration", () => {
    // Le localStorage peut contenir n'importe quoi.
    const state = normalizeSavedView({
      ...legacyView,
      campaignIds: "pas-une-liste",
    } as unknown as SavedView);
    expect(state.campaignIds).toEqual([]);
  });
});
