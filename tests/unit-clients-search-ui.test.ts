/**
 * Unitaire — ce que l'INTERFACE de la recherche fait des réponses du serveur.
 *
 * Le moteur (tests `unit-clients-search-*`) décide quoi trouver et quoi
 * montrer ; l'écran, lui, ne recalcule rien : il découpe le texte selon les
 * tranches reçues, suit le lien reçu, écrit les puces reçues. Ce qui casserait
 * sans ces cas :
 * - une tranche abîmée (hors bornes, à cheval sur un emoji) couperait un
 *   caractère en deux ou ferait planter la ligne ;
 * - un `href` trafiqué (`javascript:`, autre domaine) partirait dans
 *   `router.push` ;
 * - un champ cherchable sans libellé traduit apparaîtrait en clé brute ;
 * - une puce de portée à zéro resterait cliquable, pour une liste vide.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import commonFr from "../messages/fr/common.json";
import commonEn from "../messages/en/common.json";
import dashboardFr from "../messages/fr/dashboard.json";
import dashboardEn from "../messages/en/dashboard.json";
import { MATCH_FIELDS, MATCH_GROUPS, type ClientMatch } from "@/lib/clients-search/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { Highlighted, segments } = await import("@/components/search/highlighted");
const { SearchReason, chipFields } = await import("@/components/search/match-line");
const { ScopeChips } = await import("@/components/search/scope-chips");
const { resultHref } = await import("@/components/search/use-client-search");
const { QuickSearch } = await import("@/app/(app)/dashboard/quick-search");

function render(node: ReactNode, locale: "fr" | "en" = "fr"): string {
  // eslint-disable-next-line react/no-children-prop
  return renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale,
    timeZone: "America/Toronto",
    messages: locale === "fr"
      ? { common: commonFr, dashboard: dashboardFr }
      : { common: commonEn, dashboard: dashboardEn },
    children: node,
  }));
}

function match(overrides: Partial<ClientMatch> = {}): ClientMatch {
  return {
    score: 100,
    reasons: [{ field: "name", level: "whole", terms: [0] }],
    nameRanges: [[0, 4]],
    cityRanges: [],
    snippet: null,
    href: "/clients/c1",
    ...overrides,
  };
}

describe("surlignage : les tranches du serveur, jamais un recalcul", () => {
  it("découpe, trie et fusionne les tranches qui se chevauchent", () => {
    expect(segments("Marc-André Côté", [[11, 15], [0, 4], [2, 6]])).toEqual([
      { start: 0, text: "Marc-A", hit: true },
      { start: 6, text: "ndré ", hit: false },
      { start: 11, text: "Côté", hit: true },
    ]);
    // Deux tranches qui se touchent : une seule marque.
    expect(segments("Tremblay", [[0, 4], [4, 8]])).toEqual([{ start: 0, text: "Tremblay", hit: true }]);
  });

  it("ignore une tranche vide, à l'envers ou hors bornes, et rend le texte intact", () => {
    expect(segments("Laval", [[3, 3], [4, 2], [-5, -1]])).toEqual([{ start: 0, text: "Laval", hit: false }]);
    expect(segments("Laval", [[3, 99]])).toEqual([
      { start: 0, text: "Lav", hit: false },
      { start: 3, text: "al", hit: true },
    ]);
    expect(segments("", [])).toEqual([{ start: 0, text: "", hit: false }]);
  });

  it("ne coupe jamais un emoji en deux", () => {
    const text = "Ok 🏠 maison";
    // 3 = début de l'emoji (2 unités UTF-16) ; 4 tombe ENTRE ses moitiés.
    const parts = segments(text, [[4, 5]]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.find((p) => p.hit)?.text).toBe("🏠");
  });

  it("rend un <mark> teinté par jeton, et échappe le texte", () => {
    const html = renderToStaticMarkup(
      createElement(Highlighted, { text: "<b>Tremblay</b>", ranges: [[3, 11]] }),
    );
    expect(html).toContain('<mark class="rounded-[3px] bg-primary/15 px-px text-inherit">Tremblay</mark>');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
});

describe("le lien d'un résultat", () => {
  it("garde l'ancre d'un commentaire de LA fiche", () => {
    expect(resultHref({ id: "c1", match: match({ href: "/clients/c1#comment-k9" }) })).toBe("/clients/c1#comment-k9");
    expect(resultHref({ id: "c1", match: match({ href: "/clients/c1" }) })).toBe("/clients/c1");
  });

  it("retombe sur la fiche pour tout autre lien", () => {
    for (const href of ["javascript:alert(1)", "https://exemple.com/clients/c1", "/clients/c2", "/clients/c1/../admin"]) {
      expect(resultHref({ id: "c1", match: match({ href }) }), href).toBe("/clients/c1");
    }
    expect(resultHref({ id: "c1" })).toBe("/clients/c1");
  });
});

describe("la ligne « pourquoi »", () => {
  it("n'ajoute pas de puce pour le nom et la ville, surlignés sur place, ni pour le champ de l'extrait", () => {
    const reasons: ClientMatch["reasons"] = [
      { field: "name", level: "infix", terms: [0] },
      { field: "comment", level: "match", terms: [1] },
      { field: "city", level: "whole", terms: [2] },
      { field: "followup", level: "match", terms: [1] },
    ];
    expect(chipFields(reasons)).toEqual(["comment", "followup"]);
    expect(chipFields(reasons, "comment")).toEqual(["followup"]);
  });

  it("trouvée par le nom seulement : aucune puce visible, mais une phrase pour le lecteur d'écran", () => {
    const html = render(createElement(SearchReason, { match: match() }));
    expect(html).toContain('class="sr-only"');
    expect(html).toContain("Trouvé dans : Nom");
    expect(html).not.toContain("rounded-full border");
  });

  it("un extrait : la puce de son champ, l'auteur, le badge d'origine, le texte surligné", () => {
    const html = render(createElement(SearchReason, {
      match: match({
        reasons: [
          { field: "comment", level: "match", terms: [0] },
          { field: "notes", level: "match", terms: [0] },
        ],
        snippet: {
          field: "comment",
          text: "Veut une piscine creusée",
          ranges: [[9, 16]],
          clippedStart: true,
          clippedEnd: false,
          origin: "ai",
          at: "2026-09-20T14:00:00.000Z",
          author: "Marie Côté",
          commentId: "k9",
        },
      }),
    }));
    expect(html).toContain("Commentaire");
    expect(html).toContain("Notes de la fiche");
    expect(html).toContain("Marie Côté");
    expect(html).toContain("Note IA");
    expect(html).toContain(">piscine</mark>");
    expect(html).toContain("Trouvé dans : Commentaire et Notes de la fiche");
    // L'horodatage passe par RelativeTime (stable au rendu serveur).
    expect(html).toContain('dateTime="2026-09-20T14:00:00.000Z"');
  });

  it("parle anglais sous l'interface anglaise", () => {
    const html = render(createElement(SearchReason, {
      match: match({ reasons: [{ field: "sms", level: "match", terms: [0] }] }),
    }), "en");
    expect(html).toContain("Text message");
    expect(html).toContain("Found in: Text message");
  });

  it("compact : une seule ligne, tronquée", () => {
    const html = render(createElement(SearchReason, {
      compact: true,
      match: match({
        reasons: [
          { field: "phone", level: "suffix", terms: [0] },
          { field: "email", level: "prefix", terms: [1] },
        ],
      }),
    }));
    expect(html).toContain("Téléphone");
    expect(html).toContain("+1");
    expect(html).not.toContain("line-clamp");
  });
});

describe("les puces de portée", () => {
  const facets = { all: 5, contact: 2, profile: 0, notes: 3 };

  it("un groupe radio : une portée cochée, les comptes écrits, zéro désactivé", () => {
    const html = render(createElement(ScopeChips, { facets, scope: "notes", onPick: () => {} }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Chercher dans"');
    expect((html.match(/role="radio"/g) ?? []).length).toBe(4);
    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(1);
    expect(html).toContain("Notes et commentaires · 3");
    expect(html).toContain("Tout · 5");
    // « Lieu et projet » ne trouverait rien : désactivée.
    expect(html).toMatch(/disabled=""[^>]*>(?:(?!<\/button>).)*Lieu et projet · 0/);
  });

  it("une portée à zéro reste active quand c'est celle qu'on a choisie", () => {
    const html = render(createElement(ScopeChips, { facets, scope: "profile", onPick: () => {} }));
    expect(html).not.toMatch(/disabled=""[^>]*>(?:(?!<\/button>).)*Lieu et projet · 0/);
  });

  it("sans facettes encore : les libellés seuls, rien de désactivé", () => {
    const html = render(createElement(ScopeChips, { facets: null, scope: null, onPick: () => {} }));
    expect(html).toContain("Nom et coordonnées");
    expect(html).not.toContain(" · ");
    expect(html).not.toContain('disabled=""');
  });
});

describe("le bouton du tableau de bord", () => {
  it("est un bouton qui ouvre la palette, plus un formulaire", () => {
    const html = render(createElement(QuickSearch));
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-keyshortcuts="Meta+K Control+K /"');
    expect(html).toContain("Recherche rapide");
    expect(html).toContain("Rechercher un client, un numéro, une note…");
    expect(html).not.toContain("<form");
    // La touche affichée dépend de la plateforme : jamais au rendu serveur.
    expect(html).not.toContain("<kbd");
  });
});

describe("chaque champ et chaque portée a son libellé, dans les deux langues", () => {
  it("aucune clé brute à l'écran", () => {
    for (const messages of [commonFr, commonEn]) {
      const search = messages.search as unknown as {
        field: Record<string, string>;
        scope: Record<string, string>;
      };
      for (const field of MATCH_FIELDS) expect(search.field[field], field).toBeTruthy();
      for (const group of MATCH_GROUPS) expect(search.scope[group], group).toBeTruthy();
      expect(search.scope.all).toBeTruthy();
    }
  });
});

describe("les recherches récentes", () => {
  /**
   * Un `window` minimal : un stockage (qui peut refuser d'écrire, dès le départ
   * ou en cours de route via `fail.writes`) et un bus d'événements.
   */
  function fakeWindow(failWrites = false) {
    const store = new Map<string, string>();
    const target = new EventTarget();
    const fail = { writes: failWrites };
    return {
      store,
      fail,
      window: Object.assign(target, {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => {
            if (fail.writes) throw new Error("QuotaExceededError");
            store.set(k, v);
          },
          removeItem: (k: string) => {
            if (fail.writes) throw new Error("SecurityError");
            store.delete(k);
          },
        },
      }),
    };
  }

  it("garde des CHAÎNES de requête, par personne, les plus récentes d'abord et sans doublon", async () => {
    const { store, window } = fakeWindow();
    vi.stubGlobal("window", window);
    try {
      const recent = await import("@/components/search/recent-searches");
      recent.rememberSearch("u1", "  Côté   laval ");
      recent.rememberSearch("u1", "piscine");
      recent.rememberSearch("u1", "cote LAVAL");
      recent.rememberSearch("u2", "tremblay");
      expect(recent.readRecentSearches("u1")).toEqual(["cote LAVAL", "piscine"]);
      expect(recent.readRecentSearches("u2")).toEqual(["tremblay"]);
      expect(JSON.parse(store.get("nexus.search.recent.v1:u1") ?? "[]")).toEqual(["cote LAVAL", "piscine"]);
      for (let i = 0; i < 12; i++) recent.rememberSearch("u1", `terme ${i}`);
      expect(recent.readRecentSearches("u1")).toHaveLength(8);
      expect(recent.readRecentSearches("u1")[0]).toBe("terme 11");
      recent.clearRecentSearches("u1");
      expect(recent.readRecentSearches("u1")).toEqual([]);
      expect(recent.readRecentSearches("u2")).toEqual(["tremblay"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("données trafiquées : seulement des chaînes, bornées", async () => {
    const { store, window } = fakeWindow();
    store.set("nexus.search.recent.v1:u3", JSON.stringify([{ id: "c1", name: "Marie" }, 42, "", "ok", "x".repeat(500)]));
    vi.stubGlobal("window", window);
    try {
      const recent = await import("@/components/search/recent-searches");
      const list = recent.readRecentSearches("u3");
      expect(list).toEqual(["ok", "x".repeat(200)]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stockage bloqué : un relais mémoire pour la session, sans erreur", async () => {
    const { window } = fakeWindow(true);
    vi.stubGlobal("window", window);
    try {
      const recent = await import("@/components/search/recent-searches");
      expect(() => recent.rememberSearch("u4", "condo")).not.toThrow();
      expect(recent.readRecentSearches("u4")).toEqual(["condo"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stockage plein APRÈS une première écriture : la mémoire fait foi, l'ancienne liste ne revient pas", async () => {
    const { store, fail, window } = fakeWindow();
    vi.stubGlobal("window", window);
    try {
      const recent = await import("@/components/search/recent-searches");
      recent.rememberSearch("u5", "tremblay");
      expect(JSON.parse(store.get("nexus.search.recent.v1:u5") ?? "[]")).toEqual(["tremblay"]);
      // D'autres clés ont rempli le stockage : l'écriture échoue, la clé garde
      // la vieille liste — c'est la mémoire qu'on doit relire, pas elle.
      fail.writes = true;
      recent.rememberSearch("u5", "gagnon");
      expect(recent.readRecentSearches("u5")).toEqual(["gagnon", "tremblay"]);
      recent.rememberSearch("u5", "roy");
      expect(recent.readRecentSearches("u5")).toEqual(["roy", "gagnon", "tremblay"]);
      // Le stockage revient : l'écriture suivante y range TOUT, la mémoire s'efface.
      fail.writes = false;
      recent.rememberSearch("u5", "côté");
      expect(recent.readRecentSearches("u5")).toEqual(["côté", "roy", "gagnon", "tremblay"]);
      expect(JSON.parse(store.get("nexus.search.recent.v1:u5") ?? "[]")).toEqual(["côté", "roy", "gagnon", "tremblay"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("la palette : Entrée n'ouvre jamais une fiche qu'on n'a pas vue", () => {
  it("au toucher, la touche « Rechercher » range le clavier et n'ouvre rien — résultats là ou pas", async () => {
    const { paletteEnterAction } = await import("@/components/search/palette-keys");
    // « tremblay », puis « Rechercher » pour VOIR la liste : la palette sautait
    // dans le premier des 57 Tremblay avant d'en avoir montré un seul.
    expect(paletteEnterAction({ moved: false, touch: true, awaiting: true })).toBe("dismiss");
    expect(paletteEnterAction({ moved: false, touch: true, awaiting: false })).toBe("dismiss");
  });

  it("une ligne choisie aux flèches s'ouvre TOUT DE SUITE, même grisée pendant un chargement — comme au clic", async () => {
    const { paletteEnterAction } = await import("@/components/search/palette-keys");
    // Bob choisi sous « tremblay », « j » tapé : Entrée ouvrait Julie, arrivée après.
    for (const touch of [false, true]) {
      expect(paletteEnterAction({ moved: true, touch, awaiting: true })).toBe("select");
      expect(paletteEnterAction({ moved: true, touch, awaiting: false })).toBe("select");
    }
  });

  it("au clavier sans flèches : la ligne sélectionnée si les résultats de CE terme sont là, sinon on attend", async () => {
    const { paletteEnterAction } = await import("@/components/search/palette-keys");
    expect(paletteEnterAction({ moved: false, touch: false, awaiting: false })).toBe("select");
    expect(paletteEnterAction({ moved: false, touch: false, awaiting: true })).toBe("wait");
  });
});

describe("la palette : ce qu'un Entrée tapé trop tôt ouvre à l'arrivée", () => {
  const row = (id: string) => ({ id });
  const meta = (over: { approximate?: boolean; degraded?: null | "busy" | "timeout" } = {}) => ({
    approximate: false,
    degraded: null,
    ...over,
  });

  it("plusieurs fiches : aucune — on montre la liste, on ne devine pas", async () => {
    const { pendingOpenTarget } = await import("@/components/search/palette-keys");
    expect(pendingOpenTarget({ failed: false, total: 57, items: [row("a"), row("b")], search: meta() })).toBeNull();
    // Une seule ligne reçue mais d'autres au-delà de la page : toujours une devinette.
    expect(pendingOpenTarget({ failed: false, total: 2, items: [row("a")], search: meta() })).toBeNull();
  });

  it("l'unique fiche, exacte : elle — il n'y a rien à deviner (un numéro tapé, puis Entrée)", async () => {
    const { pendingOpenTarget } = await import("@/components/search/palette-keys");
    expect(pendingOpenTarget({ failed: false, total: 1, items: [row("a")], search: meta() })).toEqual(row("a"));
    expect(pendingOpenTarget({ failed: false, total: 1, items: [row("a")], search: null })).toEqual(row("a"));
  });

  it("une unique fiche APPROCHÉE ou d'une recherche dégradée n'est pas une certitude", async () => {
    const { pendingOpenTarget } = await import("@/components/search/palette-keys");
    expect(pendingOpenTarget({ failed: false, total: 1, items: [row("a")], search: meta({ approximate: true }) })).toBeNull();
    expect(pendingOpenTarget({ failed: false, total: 1, items: [row("a")], search: meta({ degraded: "busy" }) })).toBeNull();
    expect(pendingOpenTarget({ failed: false, total: 1, items: [row("a")], search: meta({ degraded: "timeout" }) })).toBeNull();
  });

  it("rien trouvé ou échec : rien ne s'ouvre (plus de saut vers une liste vide)", async () => {
    const { pendingOpenTarget } = await import("@/components/search/palette-keys");
    expect(pendingOpenTarget({ failed: false, total: 0, items: [], search: meta() })).toBeNull();
    expect(pendingOpenTarget({ failed: true, total: 0, items: [], search: null })).toBeNull();
  });
});

describe("la palette : la ligne sélectionnée d'office, sans dépendre de l'écran d'avant", () => {
  const ok = (ids: string[]) => ({ failed: false, items: ids.map((id) => ({ id })) });

  it("un échec : « Réessayer » ; des fiches : la meilleure", async () => {
    const { autoSelection, RETRY } = await import("@/components/search/palette-keys");
    expect(autoSelection({ failed: true, items: [] }, [])).toBe(RETRY);
    expect(autoSelection(ok(["g", "h"]), [])).toBe("client-g");
  });

  it("rien trouvé : la PREMIÈRE proposition cliquable, qu'il y ait eu des fiches à l'écran avant ou non", async () => {
    const { autoSelection } = await import("@/components/search/palette-keys");
    // Avant : « suggest-0 » si une fiche était affichée juste avant, « Voir tous
    // (0) » sur une recherche neuve — le même Entrée ne faisait pas la même chose.
    expect(autoSelection(ok([]), [
      { kind: "only", term: "tremblay", query: "tremblay" },
      { kind: "only", term: "zzz", query: "zzz" },
    ])).toBe("suggest-0");
    expect(autoSelection(ok([]), [
      { kind: "everywhere", query: "piscine" },
      { kind: "shortHint" },
    ])).toBe("suggest-0");
  });

  it("rien trouvé et seulement des aides écrites : « Voir tous les résultats »", async () => {
    const { autoSelection, ALL_RECORDS } = await import("@/components/search/palette-keys");
    expect(autoSelection(ok([]), [])).toBe(ALL_RECORDS);
    expect(autoSelection(ok([]), [{ kind: "contactHint" }, { kind: "shortHint" }])).toBe(ALL_RECORDS);
  });
});

describe("le panneau : un rafraîchissement de fond ne dégrade pas ce qui est affiché", () => {
  const full = { approximate: false, degraded: null };
  const busy = { approximate: false, degraded: "busy" as const };
  const timeout = { approximate: false, degraded: "timeout" as const };

  it("résultats complets à l'écran, sondage en recherche rapide : on garde l'écran", async () => {
    const { refreshDegradesShown } = await import("@/components/search/refresh");
    // « piscine » trouvé dans 3 notes ; le sondage de 20 s tombe sur un
    // limiteur plein et répond 0 fiche — la liste se vidait pour 20 s.
    expect(refreshDegradesShown(full, busy)).toBe(true);
    expect(refreshDegradesShown(full, timeout)).toBe(true);
  });

  it("écran déjà dégradé, ou réponse complète : la réponse passe", async () => {
    const { refreshDegradesShown } = await import("@/components/search/refresh");
    expect(refreshDegradesShown(busy, busy)).toBe(false);
    expect(refreshDegradesShown(timeout, busy)).toBe(false);
    expect(refreshDegradesShown(busy, full)).toBe(false);
    expect(refreshDegradesShown(full, full)).toBe(false);
  });

  it("sans recherche (pas de méta) : rien à protéger", async () => {
    const { refreshDegradesShown } = await import("@/components/search/refresh");
    expect(refreshDegradesShown(null, null)).toBe(false);
    expect(refreshDegradesShown(null, undefined)).toBe(false);
    expect(refreshDegradesShown(null, busy)).toBe(false);
  });
});

describe("l'ancre d'un commentaire sur la fiche déjà ouverte", () => {
  it("prévient le fil seulement pour la MÊME fiche", async () => {
    const target = new EventTarget();
    const seen: string[] = [];
    target.addEventListener("nexus:comment-anchor", (e) => seen.push((e as CustomEvent<{ id: string }>).detail.id));
    vi.stubGlobal("window", Object.assign(target, { location: new URL("https://crm.test/clients/c1") }));
    try {
      const { signalCommentAnchor } = await import("@/components/search/open-search");
      signalCommentAnchor("/clients/c1#comment-k9");
      signalCommentAnchor("/clients/c2#comment-k8");
      signalCommentAnchor("/clients/c1");
      signalCommentAnchor("https://ailleurs.test/clients/c1#comment-k7");
      expect(seen).toEqual(["k9"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
