/**
 * Unitaire — les règles d'HONNÊTETÉ de la page de consommation, rendues.
 *
 * Cette page montre de l'argent. Ce que ces tests protègent n'est pas la
 * beauté du graphique, c'est la distinction entre trois états que le typage ne
 * voit pas et qu'un rendu peut confondre :
 *
 *   « on ne sait pas »  ≠  « rien dépensé »  ≠  « voici la facture ».
 *
 * Une source injoignable doit se DESSINER autrement qu'une source à zéro ; un
 * total amputé ne s'affiche pas ; une part ne se calcule pas contre un tout
 * incomplet ; une autonomie qu'on ne peut pas calculer n'est pas infinie.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { PhoneCall } from "lucide-react";
import { describe, expect, it } from "vitest";
import adminFr from "../messages/fr/admin.json";
import commonFr from "../messages/fr/common.json";
import type { SpendDayDatum, SpendSource } from "@/components/admin/billing-charts";
import type { BalanceTile } from "@/components/admin/billing-balances";

const { SpendShareBar, SpendPerDayChart, RankedBarChart, niceCeil } = await import(
  "@/components/admin/billing-charts"
);
const { BalanceTiles } = await import("@/components/admin/billing-balances");

type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

const money = (n: number | null) => (n === null ? "—" : n.toFixed(2));
const moneyAxis = (n: number) => String(n);

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale: "fr",
      messages: { admin: adminFr, common: commonFr } as unknown as IntlMessages,
      children: node,
    }),
  );
}

const LABELS: Record<SpendSource, string> = {
  sms: "SMS",
  telephony: "Téléphonie",
  ai: "Assistants",
  notes: "Notes",
};

const ALL: Record<SpendSource, boolean> = { sms: true, telephony: true, ai: true, notes: true };

function days(n: number, per: Partial<SpendDayDatum> = {}): SpendDayDatum[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `2026-08-${String(i + 1).padStart(2, "0")}`,
    label: `${i + 1} août`,
    sms: 1,
    telephony: 2,
    ai: 0.5,
    notes: 0.25,
    total: 3.75,
    peakLabel: "",
    ...per,
  }));
}

// ── La barre de répartition ─────────────────────────────────────────────────

describe("SpendShareBar", () => {
  const data = [
    { key: "sms" as const, label: "SMS", amount: 10 },
    { key: "telephony" as const, label: "Téléphonie", amount: 30 },
    { key: "ai" as const, label: "Assistants", amount: 5 },
    { key: "notes" as const, label: "Notes", amount: 5 },
  ];

  it("période complète : la barre et les pourcentages", () => {
    const html = render(createElement(SpendShareBar, { data, money, complete: true }));
    expect(html).toContain("20 %"); // 10 / 50
    expect(html).toContain("60 %"); // 30 / 50
    expect(html).toContain("--viz-src-sms");
  });

  it("une source manque : NI barre NI pourcentage, seulement les montants", () => {
    // Un tout amputé gonfle mécaniquement les survivants : sans la téléphonie,
    // le SMS passerait de 20 % à 50 % du seul fait d'une panne.
    const partial = data.map((d) => (d.key === "telephony" ? { ...d, amount: null } : d));
    const html = render(createElement(SpendShareBar, { data: partial, money, complete: false }));
    expect(html).not.toMatch(/\d+ %/);
    // La BARRE n'est pas dessinée du tout (les pastilles de légende, elles,
    // gardent leur teinte : c'est la proportion qui est indéfendable).
    expect(html).not.toContain('role="img"');
    expect(html).toContain("10.00"); // les montants CONNUS restent
    expect(html).toContain("indisponible");
  });

  it("une source injoignable porte une pastille CREUSE, pas une couleur à zéro", () => {
    const partial = data.map((d) => (d.key === "telephony" ? { ...d, amount: null } : d));
    const html = render(createElement(SpendShareBar, { data: partial, money, complete: false }));
    expect(html).toContain("border-dashed");
    // et surtout : jamais « 0,00 » à la place de « indisponible ».
    expect(html).not.toMatch(/Téléphonie<\/span><span[^>]*>0\.00/);
  });
});

// ── La pile par journée ─────────────────────────────────────────────────────

describe("SpendPerDayChart", () => {
  const base = {
    labels: LABELS,
    money,
    moneyAxis,
    totals: { sms: 30, telephony: 60, ai: 15, notes: 7.5 } as Record<SpendSource, number | null>,
  };

  it("aucune source n'a répondu : le dit, au lieu d'annoncer « aucune dépense »", () => {
    const html = render(
      createElement(SpendPerDayChart, {
        ...base,
        data: days(30, { sms: 0, telephony: 0, ai: 0, notes: 0, total: 0 }),
        available: { sms: false, telephony: false, ai: false, notes: false },
        totals: { sms: null, telephony: null, ai: null, notes: null },
      }),
    );
    expect(html).toContain("Aucune source n&#x27;a répondu");
    expect(html).not.toContain("Aucune dépense");
  });

  it("rien dépensé : le dit, et ce n'est pas la même phrase", () => {
    const html = render(
      createElement(SpendPerDayChart, {
        ...base,
        data: days(30, { sms: 0, telephony: 0, ai: 0, notes: 0, total: 0 }),
        available: ALL,
        totals: { sms: 0, telephony: 0, ai: 0, notes: 0 },
      }),
    );
    expect(html).toContain("Aucune dépense");
  });

  it("une seule journée : pas de graphique à une barre", () => {
    const html = render(
      createElement(SpendPerDayChart, { ...base, data: days(1), available: ALL }),
    );
    expect(html).toContain("Une seule journée");
    expect(html).not.toContain("recharts-responsive-container");
  });

  it("une source injoignable : « indisponible » dans la légende, pas 0,00", () => {
    const html = render(
      createElement(SpendPerDayChart, {
        ...base,
        data: days(30, { sms: 0, total: 2.75 }),
        available: { ...ALL, sms: false },
        totals: { ...base.totals, sms: null },
      }),
    );
    expect(html).toContain("indisponible");
    expect(html).toContain("border-dashed");
    // Le graphique se dessine quand même pour les trois autres.
    expect(html).toContain("recharts-responsive-container");
  });

  it("la légende porte les MONTANTS : aucune valeur n'est réservée au survol", () => {
    const html = render(
      createElement(SpendPerDayChart, { ...base, data: days(30), available: ALL }),
    );
    expect(html).toContain("60.00");
    expect(html).toContain("30.00");
    expect(html).toContain("7.50");
  });
});

// ── Le classement (téléphonistes, modèles) ──────────────────────────────────

describe("RankedBarChart", () => {
  const common = { color: "var(--x)", format: money, formatAxis: moneyAxis, seriesName: "Coût" };

  it("une seule valeur : rien — un graphique à UNE barre est une tuile de chiffre", () => {
    const html = render(
      createElement(RankedBarChart, { ...common, data: [{ key: "a", label: "A", value: 5 }] }),
    );
    expect(html).toBe("");
  });

  it("deux valeurs et plus : le graphique s'affiche", () => {
    const html = render(
      createElement(RankedBarChart, {
        ...common,
        data: [
          { key: "a", label: "A", value: 5 },
          { key: "b", label: "B", value: 2 },
        ],
      }),
    );
    expect(html).toContain("recharts-responsive-container");
  });

  it("les lignes à zéro ne comptent pas dans le seuil de deux barres", () => {
    const html = render(
      createElement(RankedBarChart, {
        ...common,
        data: [
          { key: "a", label: "A", value: 5 },
          { key: "b", label: "B", value: 0 },
        ],
      }),
    );
    expect(html).toBe("");
  });
});

// ── Les graduations ─────────────────────────────────────────────────────────

describe("niceCeil", () => {
  it("arrondit le plafond de l'axe à un chiffre rond", () => {
    expect(niceCeil(3.61)).toBe(4);
    expect(niceCeil(0.42)).toBeCloseTo(0.5, 10);
    expect(niceCeil(12)).toBe(20);
    expect(niceCeil(1)).toBe(1);
  });

  it("un maximum absent, nul ou infini ne casse pas l'axe", () => {
    // `Math.max(...[])` vaut -Infinity : une série vide ne doit pas produire
    // un axe NaN qui efface le graphique.
    expect(niceCeil(Math.max(...([] as number[])))).toBe(1);
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(Number.NaN)).toBe(1);
  });
});

// ── L'ordre de la pile ──────────────────────────────────────────────────────

describe("SPEND_SOURCES", () => {
  it("l'orange et le jaune ne sont JAMAIS voisins dans la pile", async () => {
    // Ces quatre teintes ne passent le validateur dataviz que sur la liste des
    // paires VOISINES : orange (SMS) et jaune (notes d'appel) mesurent ΔE 13,7
    // en vision normale, sous le plancher de 15. L'ordre les sépare par DEUX
    // séries — il faudrait une journée sans téléphonie ET sans assistant pour
    // qu'elles se touchent. Un réordonnancement innocent casserait ça en
    // silence : le test le refuse.
    const { SPEND_SOURCES } = await import("@/components/admin/billing-charts");
    const sms = SPEND_SOURCES.indexOf("sms");
    const notes = SPEND_SOURCES.indexOf("notes");
    expect(Math.abs(sms - notes)).toBeGreaterThanOrEqual(3);
  });
});

// ── Les réservoirs ──────────────────────────────────────────────────────────

describe("BalanceTiles", () => {
  const tile = (over: Partial<BalanceTile>): BalanceTile => ({
    key: "voipms",
    label: "voip.ms",
    Icon: PhoneCall,
    balance: 100,
    periodCost: 30,
    lowBelow: 25,
    ...over,
  });

  it("solde connu et consommation connue : une autonomie en jours", () => {
    // 100 $ / (30 $ sur 30 j) = 100 jours.
    const html = render(
      createElement(BalanceTiles, { tiles: [tile({})], dayCount: 30, money }),
    );
    expect(html).toContain("100 j restants");
    expect(html).toContain("Suffisant");
  });

  it("consommation nulle : autonomie INCONNUE, surtout pas infinie", () => {
    const html = render(
      createElement(BalanceTiles, { tiles: [tile({ periodCost: 0 })], dayCount: 30, money }),
    );
    expect(html).toContain("Autonomie inconnue");
    expect(html).not.toContain("Infinity");
  });

  it("consommation indisponible : autonomie inconnue, pas un calcul sur zéro", () => {
    const html = render(
      createElement(BalanceTiles, { tiles: [tile({ periodCost: null })], dayCount: 30, money }),
    );
    expect(html).toContain("Autonomie inconnue");
  });

  it("solde injoignable : « — » et « Indisponible », jamais 0 $", () => {
    const html = render(
      createElement(BalanceTiles, { tiles: [tile({ balance: null })], dayCount: 30, money }),
    );
    expect(html).toContain("Indisponible");
    expect(html).not.toContain("0.00");
  });

  it("solde NÉGATIF : annoncé comme un découvert, signe conservé", () => {
    const html = render(
      createElement(BalanceTiles, { tiles: [tile({ balance: -3.41 })], dayCount: 30, money }),
    );
    expect(html).toContain("-3.41");
    expect(html).toContain("À découvert");
  });

  it("solde bas : le mot ET le pictogramme, pas la seule couleur", () => {
    const html = render(
      createElement(BalanceTiles, { tiles: [tile({ balance: 10 })], dayCount: 30, money }),
    );
    expect(html).toContain("Solde bas");
    expect(html).toContain("<svg"); // le pictogramme double le libellé
  });
});
