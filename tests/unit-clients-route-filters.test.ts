import { describe, expect, it } from "vitest";
import { clientRouteFilters, localClientWorkspaceUrl, type ClientFilterState } from "@/components/clients/focus";

describe("client directory URL searches", () => {
  it("replaces every stale saved criterion when global search opens all results", () => {
    const previous: ClientFilterState = {
      q: "ancienne recherche",
      categoryIds: [4],
      sourceIds: ["12"],
      assignedToIds: ["colleague"],
      statuses: ["overdue"],
      languages: ["fr"],
      campaignIds: ["old-campaign"],
      createdMode: "before",
      createdFrom: "",
      createdTo: "2026-01-01",
      updatedMode: "custom",
      updatedFrom: "2026-02-01",
      updatedTo: "2026-02-28",
      sortKey: "followupAt",
      sortDir: "asc",
    };
    const next = { ...previous, ...clientRouteFilters({ q: "Marie" }) };
    expect(next).toEqual({
      q: "Marie",
      categoryIds: [],
      sourceIds: [],
      assignedToIds: [],
      statuses: [],
      languages: [],
      campaignIds: [],
      createdMode: "none",
      createdFrom: "",
      createdTo: "",
      updatedMode: "none",
      updatedFrom: "",
      updatedTo: "",
      sortKey: "activity",
      sortDir: "desc",
    });
    expect(next).not.toHaveProperty("view");
  });

  it("supports pipeline category links and intentional combined searches", () => {
    expect(clientRouteFilters({ categoryId: "3,none" })).toMatchObject({
      q: "", categoryIds: [3, "none"], statuses: [],
    });
    expect(clientRouteFilters({ q: "Québec", categoryId: "3" })).toMatchObject({
      q: "Québec", categoryIds: [3], statuses: [],
    });
  });

  it("keeps queue ordering for explicit focus routes without inheriting older criteria", () => {
    expect(clientRouteFilters({ focus: "today" })).toMatchObject({
      q: "", categoryIds: [], statuses: ["today"], sortKey: "followupAt", sortDir: "asc",
    });
    expect(clientRouteFilters({ focus: "all" })?.statuses).toEqual([]);
    expect(clientRouteFilters({ focus: "never" })?.statuses).toEqual(["never"]);
  });

  it("distinguishes explicit empty searches from ordinary detail/back navigation", () => {
    expect(clientRouteFilters({ q: "" })).toMatchObject({ q: "", categoryIds: [], statuses: [] });
    expect(clientRouteFilters({ categoryId: "" })?.categoryIds).toEqual([]);
    expect(clientRouteFilters({})).toBeNull();
    expect(clientRouteFilters({ q: null, categoryId: null, focus: null })).toBeNull();
    expect(clientRouteFilters({ focus: "unknown" })).toBeNull();
  });

  it("accepts only complete, bounded category IDs and deduplicates them", () => {
    expect(clientRouteFilters({ categoryId: "4, 4,none,4oops,-1,0,2147483648,2" })?.categoryIds)
      .toEqual([4, "none", 2]);
  });

  it("does not mutate an earlier URL state when a later search is resolved", () => {
    const first = clientRouteFilters({ q: "Marie", categoryId: "4" });
    const second = clientRouteFilters({ q: "Alex" });
    expect(first).toMatchObject({ q: "Marie", categoryIds: [4] });
    expect(second).toMatchObject({ q: "Alex", categoryIds: [] });
    expect(clientRouteFilters({ q: "Marie", categoryId: "4" })).toEqual(first);
  });

  it("retires stale route criteria after local edits so an identical palette search is new navigation", () => {
    expect(localClientWorkspaceUrl("https://nexus.test/clients?q=Marie&categoryId=4&focus=overdue"))
      .toBe("/clients");
    expect(localClientWorkspaceUrl("https://nexus.test/clients/record?q=Marie&tab=notes#history"))
      .toBe("/clients/record?tab=notes#history");
    expect(localClientWorkspaceUrl("https://nexus.test/clients?tab=notes")).toBeNull();
    expect(localClientWorkspaceUrl("https://nexus.test/dashboard?q=Marie")).toBeNull();
  });
});
