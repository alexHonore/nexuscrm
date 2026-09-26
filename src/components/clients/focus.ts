import type { SavedViewState } from "./saved-views";

/** Named work queues use the existing server-side list filters and permissions. */
export const CLIENT_FOCUS_KEYS = ["all", "overdue", "today", "never", "none"] as const;

export type ClientFocus = (typeof CLIENT_FOCUS_KEYS)[number];

export function clientFocus(value: string | null): ClientFocus | null {
  return CLIENT_FOCUS_KEYS.find((key) => key === value) ?? null;
}

export type ClientFilterState = Omit<SavedViewState, "view">;

/**
 * An explicit deep link describes a whole search, never an extra filter on
 * yesterday's queue. Null means ordinary workspace navigation: keep local
 * edits and saved criteria. Empty q/categoryId parameters explicitly reset.
 * The display preference is deliberately absent so links retain cards/table.
 */
export function clientRouteFilters(route: {
  q?: string | null;
  categoryId?: string | null;
  focus?: string | null;
}): ClientFilterState | null {
  const focus = clientFocus(route.focus ?? null);
  if (route.q == null && route.categoryId == null && !focus) return null;

  const categoryIds = [...new Set(
    (route.categoryId ?? "").split(",").slice(0, 50).flatMap((token): Array<number | "none"> => {
      const value = token.trim();
      if (value === "none") return ["none"];
      if (!/^[1-9]\d{0,9}$/.test(value)) return [];
      const id = Number(value);
      return id <= 2_147_483_647 ? [id] : [];
    }),
  )];
  const chronological = focus === "overdue" || focus === "today";

  return {
    q: route.q ?? "",
    categoryIds,
    sourceIds: [],
    assignedToIds: [],
    statuses: focus && focus !== "all" ? [focus] : [],
    languages: [],
    campaignIds: [],
    createdMode: "none",
    createdFrom: "",
    createdTo: "",
    updatedMode: "none",
    updatedFrom: "",
    updatedTo: "",
    // Une recherche arrive classée par pertinence : le meilleur résultat en
    // tête, comme dans la palette qui a ouvert ce lien. Sans terme (`q` vide,
    // file de travail), l'activité récente reste l'ordre naturel.
    sortKey: chronological ? "followupAt" : route.q ? "relevance" : "activity",
    sortDir: chronological ? "asc" : "desc",
  };
}

/** Retire an obsolete deep link once the user edits the local workspace. */
export function localClientWorkspaceUrl(href: string): string | null {
  const url = new URL(href);
  if (url.pathname !== "/clients" && !url.pathname.startsWith("/clients/")) return null;
  const keys = ["q", "categoryId", "focus"];
  if (!keys.some((key) => url.searchParams.has(key))) return null;
  for (const key of keys) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}
