/**
 * Unitaire — la vue des tâches du tableau de bord : en retard, aujourd'hui,
 * et les sept jours qui viennent.
 *
 * Deux choses à protéger, et une seule est visible à l'œil nu :
 *
 * 1. **L'horizon compte des jours CIVILS.** Toronto a une nuit de 23 h en mars
 *    et une de 25 h en novembre. « Maintenant + 8 × 24 h » y tombe à 23 h ou à
 *    01 h au lieu de minuit : un jour se coupe en deux, et une relance
 *    disparaît de la carte sans que personne ne sache pourquoi. Ces tests
 *    traversent les deux bascules de l'heure.
 *
 * 2. **Rien n'est caché sans porte de sortie.** La carte replie les suivis à
 *    venir ; ce qui est replié doit rester atteignable, et le compte annoncé
 *    doit être le vrai.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { formatInTimeZone } from "date-fns-tz";
import { describe, expect, it, vi } from "vitest";
import dashboardEn from "../messages/en/dashboard.json";
import dashboardFr from "../messages/fr/dashboard.json";
import { APP_TZ, torontoDayRange, torontoDayStart } from "@/components/clients/timezone";
import type { FollowupItemData } from "@/app/(app)/dashboard/followup-item";
import type { FollowupDayGroup } from "@/app/(app)/dashboard/upcoming-followups";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/clients/actions", () => ({ completeFollowupAction: vi.fn() }));
vi.mock("@/components/telephony/telephony-context", () => ({
  useTelephony: () => ({ dial: vi.fn(), ready: true }),
}));

const { UpcomingFollowups } = await import("@/app/(app)/dashboard/upcoming-followups");

// ── L'horizon ────────────────────────────────────────────────────────────────

describe("horizon des suivis — jours civils de Toronto", () => {
  it("recolle exactement sur la fin de journée que la page utilise déjà", () => {
    const now = new Date("2026-08-26T18:00:00Z");
    expect(torontoDayStart(now, 1).getTime()).toBe(torontoDayRange(now).end.getTime());
  });

  it("tombe toujours à minuit, heure de Toronto — y compris en traversant novembre", () => {
    // 2026-11-01 : retour à l'heure normale, journée de 25 h.
    const now = new Date("2026-10-30T14:00:00Z");
    for (let d = 0; d <= 8; d += 1) {
      const at = torontoDayStart(now, d);
      expect(formatInTimeZone(at, APP_TZ, "HH:mm")).toBe("00:00");
    }
  });

  it("tombe toujours à minuit en traversant mars (journée de 23 h)", () => {
    // 2027-03-14 : passage à l'heure avancée.
    const now = new Date("2027-03-10T14:00:00Z");
    for (let d = 0; d <= 8; d += 1) {
      const at = torontoDayStart(now, d);
      expect(formatInTimeZone(at, APP_TZ, "HH:mm")).toBe("00:00");
    }
  });

  it("couvre huit journées DISTINCTES — aucune sautée, aucune répétée", () => {
    for (const iso of ["2026-10-30T14:00:00Z", "2027-03-10T14:00:00Z", "2026-08-26T03:30:00Z"]) {
      const now = new Date(iso);
      const days = Array.from({ length: 9 }, (_, d) =>
        formatInTimeZone(torontoDayStart(now, d), APP_TZ, "yyyy-MM-dd"),
      );
      expect(new Set(days).size).toBe(9);
    }
  });

  it("n'est PAS « + 168 h » quand l'heure change — c'est bien le piège évité", () => {
    const now = new Date("2026-10-30T14:00:00Z"); // novembre est dans la fenêtre
    const day1 = torontoDayStart(now, 1);
    const day8 = torontoDayStart(now, 8);
    expect(day8.getTime() - day1.getTime()).toBe(7 * 24 * 3600_000 + 3600_000); // 25 h une fois
  });

  it("range une relance de fin de soirée dans SA journée, pas la suivante", () => {
    const now = new Date("2026-08-26T18:00:00Z"); // 14 h à Toronto
    // 23 h 30 ce soir, heure de Toronto = 03:30Z le lendemain en UTC.
    const tonight = new Date("2026-08-27T03:30:00Z");
    expect(tonight.getTime()).toBeLessThan(torontoDayStart(now, 1).getTime());
    expect(formatInTimeZone(tonight, APP_TZ, "yyyy-MM-dd")).toBe("2026-08-26");
  });
});

// ── La carte ─────────────────────────────────────────────────────────────────

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

function item(id: string): FollowupItemData {
  return {
    id,
    clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    clientName: `Client ${id}`,
    phone: "+14185551234",
    phoneDisplay: "(418) 555-1234",
    note: null,
    dueLabel: "10:00",
    overdue: false,
    doNotCall: false,
  };
}

function groups(perDay: number[]): FollowupDayGroup[] {
  let n = 0;
  return perDay.map((count, d) => ({
    key: `2026-09-0${d + 1}`,
    label: d === 0 ? "Demain" : `jour ${d + 1}`,
    items: Array.from({ length: count }, () => item(`f${(n += 1)}`)),
  }));
}

function render(dayGroups: FollowupDayGroup[], locale: "fr" | "en" = "fr"): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: APP_TZ,
      messages: { dashboard: locale === "en" ? dashboardEn : dashboardFr } as unknown as IntlMessages,
      children: createElement(UpcomingFollowups, { groups: dayGroups }),
    }),
  );
}

const rowCount = (html: string) => (html.match(/aria-label="Ouvrir la fiche"/g) ?? []).length;

describe("suivis à venir — repliage", () => {
  it("montre tout tant que la semaine tient dans la carte", () => {
    const html = render(groups([2, 2]));
    expect(rowCount(html)).toBe(4);
    expect(html).not.toContain("Voir les");
  });

  it("replie au-delà de six et annonce le nombre EXACT de suivis cachés", () => {
    const html = render(groups([3, 3, 3, 1])); // 10 au total
    expect(rowCount(html)).toBe(6);
    expect(html).toContain("Voir les 4 suivants");
  });

  it("garde l'en-tête du jour coupé en deux — sinon une ligne flotte sans date", () => {
    // 4 + 4 : le second jour n'est montré qu'à moitié.
    const html = render(groups([4, 4]));
    expect(rowCount(html)).toBe(6);
    expect(html).toContain("jour 2"); // l'en-tête du jour tronqué survit
  });

  it("n'affiche pas les journées entièrement hors budget", () => {
    const html = render(groups([6, 2]));
    expect(rowCount(html)).toBe(6);
    expect(html).not.toContain("jour 2");
  });

  it("accorde le singulier — « Voir le suivant », pas « Voir les 1 suivants »", () => {
    const html = render(groups([7]));
    expect(html).toContain("Voir le suivant");
    expect(html).not.toContain("Voir les 1");
  });

  it("parle anglais aussi", () => {
    const html = render(groups([3, 3, 3, 1]), "en");
    expect(html).toContain("Show 4 more");
  });
});

// ── i18n ─────────────────────────────────────────────────────────────────────

describe("clés de traduction des suivis", () => {
  it("existent dans les DEUX langues, à l'identique", () => {
    const fr = Object.keys(dashboardFr.followups).sort();
    const en = Object.keys(dashboardEn.followups).sort();
    expect(fr).toEqual(en);
    for (const key of ["upcoming", "upcomingRange", "tomorrow", "showMore", "showLess"]) {
      expect(fr).toContain(key);
    }
  });
});
