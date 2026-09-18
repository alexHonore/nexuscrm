import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { ClientLaunchpad } from "@/components/clients/client-launchpad";
import { ClientListNavContext, type ClientListNav } from "@/components/clients/client-list-nav";
import { clientFocus } from "@/components/clients/focus";
import fr from "../messages/fr/clients.json";
import en from "../messages/en/clients.json";

const BASE: ClientListNav = {
  ids: ["first-visible", "second-visible"],
  total: 2,
  hasMore: false,
  loadingMore: false,
  loading: false,
  failed: false,
  focus: vi.fn(),
  indexOf: () => 0,
  loadMore: async () => [],
};

function render(nav: ClientListNav | null, locale: "fr" | "en" = "fr") {
  // eslint-disable-next-line react/no-children-prop -- the typed provider requires children in its props
  const content = createElement(ClientListNavContext.Provider, {
    value: nav,
    children: createElement(ClientLaunchpad, {
      counts: { all: 100, overdue: 3, today: 2, never: 50, none: 20 },
    }),
  });
  // eslint-disable-next-line react/no-children-prop -- the typed provider requires children in its props
  return renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale,
    timeZone: "America/Toronto",
    messages: { clients: locale === "fr" ? fr : en } as unknown as ComponentProps<typeof NextIntlClientProvider>["messages"],
    children: content,
  }));
}

describe("client work queues", () => {
  it("opens the first visible result and reports the filtered count, separate from the portfolio", () => {
    const html = render(BASE);
    expect(html).toContain('href="/clients/first-visible"');
    expect(html).not.toContain('href="/clients/second-visible"');
    expect(html).toContain("2 fiches dans cette vue");
    expect(html).toContain("100 clients");
  });

  it("does not offer a stale record while a new queue loads", () => {
    const html = render({ ...BASE, loading: true });
    expect(html).not.toContain('href="/clients/first-visible"');
    expect(html).toContain("Chargement");
    expect(html).toMatch(/<button[^>]*\sdisabled/);
  });

  it("handles an empty filtered queue and a missing workspace", () => {
    expect(render({ ...BASE, ids: [], total: 0 })).toContain("Aucune fiche dans cette vue");
    expect(render(null)).not.toContain('href="/clients/');
  });

  it("reports a failed list load without offering an old record", () => {
    const html = render({ ...BASE, failed: true });
    expect(html).toContain("Impossible de charger la liste.");
    expect(html).not.toContain('href="/clients/first-visible"');
  });

  it("renders the same workspace in English", () => {
    const html = render(BASE, "en");
    expect(html).toContain("Every relationship deserves a next step.");
    expect(html).toContain("2 records in this view");
    expect(html).toContain("First conversations");
  });

  it("accepts only recognized queue deep links", () => {
    expect(clientFocus("overdue")).toBe("overdue");
    expect(clientFocus("today")).toBe("today");
    expect(clientFocus("all")).toBe("all");
    expect(clientFocus("never")).toBe("never");
    expect(clientFocus("none")).toBe("none");
    expect(clientFocus("overdue,today")).toBeNull();
    expect(clientFocus("invalid")).toBeNull();
    expect(clientFocus(null)).toBeNull();
  });
});
