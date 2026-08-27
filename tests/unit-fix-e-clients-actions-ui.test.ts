/**
 * Unitaire — la ligne de relance du tableau de bord respecte `doNotCall`
 * comme l'en-tête de la fiche et la carte du pipeline : bouton d'appel
 * désactivé et pictogramme « Ne pas appeler » à côté du nom.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import dashboardFr from "../messages/fr/dashboard.json";
import type { FollowupItemData } from "@/app/(app)/dashboard/followup-item";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/clients/actions", () => ({ completeFollowupAction: vi.fn() }));
// Ligne prête : seul `doNotCall` doit pouvoir désactiver le bouton.
vi.mock("@/components/telephony/telephony-context", () => ({
  useTelephony: () => ({ dial: vi.fn(), ready: true }),
}));

const { FollowupItem } = await import("@/app/(app)/dashboard/followup-item");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

function render(item: FollowupItemData): string {
  return renderToStaticMarkup(
    // Le type de NextIntlClientProvider EXIGE `children` dans les props (pas
    // de surcharge createElement à 3 arguments) — même motif que int-analytics.
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      timeZone: "America/Toronto",
      messages: { dashboard: dashboardFr } as unknown as IntlMessages,
      children: createElement(FollowupItem, { item }),
    }),
  );
}

const BASE: FollowupItemData = {
  id: "f1",
  clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  clientName: "Marie Tremblay",
  phone: "+14185551234",
  phoneDisplay: "(418) 555-1234",
  note: null,
  dueLabel: "10:00",
  overdue: false,
  doNotCall: false,
  aiScheduled: false,
};

function callButton(html: string): string {
  const m = /<button[^>]*aria-label="(Appeler|Ne pas appeler)"[^>]*>/.exec(html);
  if (!m) throw new Error("bouton d'appel introuvable");
  return m[0];
}

/** L'ATTRIBUT disabled — pas la classe utilitaire `disabled:` du bouton. */
const DISABLED_ATTR = /\sdisabled(=""|\s|>)/;

describe("FollowupItem et doNotCall", () => {
  it("fiche joignable : bouton « Appeler » actif, pas de pictogramme", () => {
    const html = render(BASE);
    const button = callButton(html);
    expect(button).toContain('aria-label="Appeler"');
    expect(button).not.toMatch(DISABLED_ATTR);
    expect(html).not.toContain('aria-label="Ne pas appeler"');
  });

  it("fiche « Ne pas appeler » : bouton désactivé et pictogramme à côté du nom", () => {
    const html = render({ ...BASE, doNotCall: true });
    const button = callButton(html);
    expect(button).toContain('aria-label="Ne pas appeler"');
    expect(button).toMatch(DISABLED_ATTR);
    // Le pictogramme double le libellé (aria-label) à côté du nom.
    expect(html.indexOf('aria-label="Ne pas appeler"')).toBeLessThan(html.indexOf("Marie Tremblay"));
  });
});
