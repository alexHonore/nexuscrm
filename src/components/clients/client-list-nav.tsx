"use client";

import { createContext, useContext } from "react";

/** One row of the left-panel client list (shape of GET /api/clients/list items). */
export type ClientListItem = {
  id: string;
  fullName: string;
  phone: string;
  categoryId: number | null;
  categoryColor: string | null;
  /** ISO string (UTC) or null. */
  nextFollowupAt: string | null;
  doNotCall: boolean;
  city: string | null;
};

/**
 * Quick-switching contract between the left panel (provider, lives in the
 * /clients layout so it survives navigation) and the detail-page switcher.
 */
export type ClientListNav = {
  /** Ordered ids of the loaded pages, in the panel's current filtered order. */
  ids: string[];
  /** Total matching the current panel filters (across all pages). */
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  indexOf: (id: string) => number;
  /** Loads the next page; resolves with the newly appended ids. */
  loadMore: () => Promise<string[]>;
};

export const ClientListNavContext = createContext<ClientListNav | null>(null);

/** Null outside the /clients workspace — consumers must degrade gracefully (deep links). */
export function useClientListNav(): ClientListNav | null {
  return useContext(ClientListNavContext);
}
