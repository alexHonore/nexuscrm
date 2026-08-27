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
import { fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { describe, expect, it, vi } from "vitest";
import conversationsFr from "../messages/fr/conversations.json";
import dashboardEn from "../messages/en/dashboard.json";
import dashboardFr from "../messages/fr/dashboard.json";
import {
  APP_TZ,
  torontoDayRange,
  torontoDayStart,
  torontoMonthStart,
} from "@/components/clients/timezone";
import type { FollowupItemData } from "@/app/(app)/dashboard/followup-item";
import type { FollowupDayGroup } from "@/app/(app)/dashboard/upcoming-followups";
import type { AttentionRowData } from "@/app/(app)/dashboard/attention-list";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/clients/actions", () => ({ completeFollowupAction: vi.fn() }));
vi.mock("@/components/telephony/telephony-context", () => ({
  useTelephony: () => ({ dial: vi.fn(), ready: true }),
}));

const { UpcomingFollowups } = await import("@/app/(app)/dashboard/upcoming-followups");
const { AttentionList } = await import("@/app/(app)/dashboard/attention-list");
const { FollowupItem } = await import("@/app/(app)/dashboard/followup-item");

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
    aiScheduled: false,
  };
}

const ITEM_BASE = item("f1");

/** Une ligne de suivi seule — les deux modules de messages, comme à l'écran. */
function renderItem(data: FollowupItemData): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      timeZone: APP_TZ,
      messages: { dashboard: dashboardFr } as unknown as IntlMessages,
      children: createElement(FollowupItem, { item: data }),
    }),
  );
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

/** La carte « SMS IA — à reprendre », rendue avec les VRAIS messages des deux modules. */
function renderAttention(rows: AttentionRowData[], hidden = 0): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      timeZone: APP_TZ,
      messages: {
        dashboard: dashboardFr,
        conversations: conversationsFr,
      } as unknown as IntlMessages,
      children: createElement(AttentionList, { rows, hidden }),
    }),
  );
}

const attentionRow = (over: Partial<AttentionRowData> = {}): AttentionRowData => ({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  clientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  clientName: "Marie Tremblay",
  clientPhone: "+14185551234",
  attentionReason: "handoff",
  lastAtLabel: "21 août 11:00",
  ...over,
});

describe("§ horizon des suivis — trois mois CIVILS", () => {
  it("compte des mois, pas des multiples de 30 jours", () => {
    // « + 90 jours » depuis le 31 janvier tombe le 1er mai ; trois mois civils
    // valent le 30 avril. Un horizon en jours dérape d'un jour à chaque mois
    // court, et la borne ne tombe plus sur un minuit attendu.
    const jan31 = new Date("2026-01-31T17:00:00.000Z"); // midi à Toronto
    expect(formatInTimeZone(torontoMonthStart(jan31, 3), APP_TZ, "yyyy-MM-dd")).toBe("2026-04-30");
  });

  it("la borne est un minuit de Toronto, même à travers un changement d'heure", () => {
    // Décembre → mars traverse le passage à l'heure avancée.
    const dec = new Date("2025-12-15T17:00:00.000Z");
    const end = torontoMonthStart(dec, 3);
    expect(formatInTimeZone(end, APP_TZ, "yyyy-MM-dd HH:mm")).toBe("2026-03-15 00:00");
  });

  it("l'horizon englobe bien un rappel lointain que sept jours cachaient", () => {
    const now = new Date("2026-08-27T15:00:00.000Z");
    const inTwoMonths = torontoDayStart(now, 60);
    expect(inTwoMonths.getTime()).toBeLessThan(torontoMonthStart(now, 3).getTime());
    expect(inTwoMonths.getTime()).toBeGreaterThan(torontoDayStart(now, 8).getTime());
  });
});

describe("suivi programmé par l'assistant", () => {
  it("§ porte une marque qui le distingue d'un rappel humain", () => {
    // Les deux familles partagent la liste : sans la marque, « rappeler en
    // septembre » promis par l'assistant se lit comme une note qu'on aurait
    // prise soi-même.
    const ai = renderItem({ ...ITEM_BASE, aiScheduled: true });
    const human = renderItem({ ...ITEM_BASE, aiScheduled: false });
    expect(ai).toContain('aria-label="IA"');
    expect(human).not.toContain('aria-label="IA"');
  });
});

describe("tableau de bord — les fils rendus par l'assistant SMS", () => {
  it("nomme la personne, le motif, et mène à sa fiche", () => {
    const html = renderAttention([attentionRow()]);
    expect(html).toContain("Marie Tremblay");
    // Le motif est TRADUIT, et il vient du module des conversations.
    expect(html).toContain("Passé à un humain");
    expect(html).toContain('href="/clients/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"');
  });

  it("§ un motif inconnu s'affiche tel quel plutôt qu'en clé i18n", () => {
    // Le moteur peut écrire un motif qu'aucune traduction ne connaît encore ;
    // « inbox.reason.quelque_chose » à l'écran serait pire que le mot brut.
    const html = renderAttention([attentionRow({ attentionReason: "motif_futur" })]);
    expect(html).toContain("motif_futur");
    expect(html).not.toContain("inbox.reason.");
  });

  it("sans fiche rattachée, la ligne mène quand même quelque part", () => {
    const html = renderAttention([attentionRow({ clientId: null, clientName: null })]);
    expect(html).toContain('href="/conversations"');
    // Faute de nom, le numéro — jamais une ligne vide.
    expect(html).toContain("418");
  });

  it("ce qui n'est pas montré est compté ET atteignable", () => {
    const html = renderAttention([attentionRow()], 4);
    expect(html).toContain("et 4 autres");
    expect(html).toContain('href="/conversations"');
  });

  it("un seul de plus se dit au singulier", () => {
    expect(renderAttention([attentionRow()], 1)).toContain("et 1 autre");
  });
});

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
