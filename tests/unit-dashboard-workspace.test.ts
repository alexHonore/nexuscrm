import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import dashboardFr from "../messages/fr/dashboard.json";
import dashboardEn from "../messages/en/dashboard.json";
import type { FollowupItemData } from "@/app/(app)/dashboard/followup-item";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/clients/actions", () => ({ completeFollowupAction: vi.fn() }));
vi.mock("@/components/telephony/telephony-context", () => ({
  useTelephony: () => ({ dial: vi.fn(), ready: true }),
}));

const { FollowupWorkspace } = await import("@/app/(app)/dashboard/followup-workspace");

function followup(index: number, overdue = false): FollowupItemData {
  return {
    id: `task-${index}`,
    clientId: `client-${index}`,
    clientName: `Client ${index}`,
    phone: "+14185551234",
    phoneDisplay: "418 555-1234",
    note: null,
    dueLabel: "09:00",
    overdue,
    doNotCall: false,
    aiScheduled: false,
  };
}

function render(overrides: Partial<Parameters<typeof FollowupWorkspace>[0]> = {}, locale: "fr" | "en" = "fr") {
  // eslint-disable-next-line react/no-children-prop
  return renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale,
    timeZone: "America/Toronto",
    messages: { dashboard: locale === "fr" ? dashboardFr : dashboardEn },
    children: createElement(FollowupWorkspace, {
      overdue: [], today: [], upcoming: [], overdueCount: 0, todayCount: 0,
      upcomingCount: 0, truncated: 0, months: 3,
      ...overrides,
    }),
  }));
}

describe("dashboard work queue", () => {
  it("keeps overdue work ahead of today's tasks within the initial eight rows", () => {
    const html = render({
      overdue: Array.from({ length: 6 }, (_, index) => followup(index, true)),
      today: Array.from({ length: 4 }, (_, index) => followup(index + 6)),
      overdueCount: 6,
      todayCount: 4,
    });
    expect((html.match(/aria-label="Ouvrir la fiche"/g) ?? []).length).toBe(8);
    expect(html).toContain("Client 7");
    expect(html).not.toContain("Client 8");
    expect(html).toContain("Voir les 2 suivants");
    expect(html.indexOf("Client 0")).toBeLessThan(html.indexOf("Client 6"));
  });

  it("opens planned work when nothing is due today", () => {
    const html = render({
      upcoming: [{ key: "2026-09-19", label: "Demain", items: [followup(12)] }],
      upcomingCount: 1,
    });
    expect(html).toContain("Client 12");
    expect(html).toContain("Demain");
    expect(html).not.toContain("Votre journée est à jour");
  });

  it("states that the server's loaded subset is incomplete", () => {
    const html = render({ overdue: [followup(0, true)], overdueCount: 501, truncated: 500 });
    expect(html).toContain("500 autres suivis ne sont pas chargés");
    expect(html).toContain("501");
    expect((html.match(/aria-label="Ouvrir la fiche"/g) ?? []).length).toBe(1);
  });

  it("renders the empty queue and both periods in English", () => {
    const html = render({}, "en");
    expect(html).toContain("caught up today");
    expect(html).toContain("Today");
    expect(html).toContain("Upcoming");
    expect(html).not.toContain("followups.");
  });
});
