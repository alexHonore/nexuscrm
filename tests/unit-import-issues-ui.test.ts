/**
 * Unitaire — le panneau qui explique un import refusé.
 *
 * Ce qui compte : la personne doit repartir avec de quoi corriger le fichier —
 * le champ, la ligne, ce qui était attendu — dans SA langue, sans jamais voir
 * une clé de traduction ni un message de schéma brut.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import commonEn from "../messages/en/common.json";
import commonFr from "../messages/fr/common.json";
import type { ImportIssue } from "@/lib/import-diagnostics";

const { ImportIssues } = await import("@/components/admin/import-issues");
type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

function render(
  locale: "fr" | "en",
  props: ComponentProps<typeof ImportIssues>,
): string {
  const html = renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale,
      messages: { common: locale === "fr" ? commonFr : commonEn } as unknown as IntlMessages,
      children: createElement(ImportIssues, props),
    }),
  );
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

const enumIssue: ImportIssue = {
  path: "assistant.goal.primary.type",
  segments: ["assistant", "goal", "primary", "type"],
  code: "not_allowed",
  raw: 'Invalid option: expected one of "video_meeting"|"phone_call"',
  options: ["video_meeting", "phone_call"],
  value: "rencontre",
  line: 12,
  field: { label: "Objectif principal — type", what: "Ce que l'assistant cherche à obtenir." },
};

const missingIssue: ImportIssue = {
  path: "assistant.goal",
  segments: ["assistant", "goal"],
  code: "missing",
  raw: "Invalid input: expected object, received undefined",
  line: 3,
};

describe("panneau de diagnostic", () => {
  it("rien à dire → rien à l'écran", () => {
    expect(render("fr", { issues: [] })).toBe("");
  });

  it("nomme le champ, montre le chemin, la ligne et les valeurs permises", () => {
    const html = render("fr", { issues: [enumIssue] });
    expect(html).toContain("Objectif principal — type");
    expect(html).toContain("assistant.goal.primary.type");
    expect(html).toContain("ligne 12");
    expect(html).toContain("Valeurs permises");
    expect(html).toContain("video_meeting");
    // Ce que le fichier disait, pour ne pas avoir à le rechercher.
    expect(html).toContain("rencontre");
  });

  it("« il manque » se lit comme une consigne, pas comme un type invalide", () => {
    const html = render("fr", { issues: [missingIssue] });
    expect(html).toContain("absent du fichier");
    expect(html).toContain("ligne 3");
  });

  it("compte les problèmes, au singulier comme au pluriel", () => {
    expect(render("fr", { issues: [missingIssue] })).toContain("1 problème");
    expect(render("fr", { issues: [missingIssue, enumIssue] })).toContain("2 problèmes");
    expect(render("en", { issues: [missingIssue] })).toContain("1 problem");
    expect(render("en", { issues: [missingIssue, enumIssue] })).toContain("2 problems");
  });

  it("un JSON illisible est une AUTRE erreur, avec sa ligne et l'extrait fautif", () => {
    const html = render("fr", {
      issues: [],
      syntax: { line: 7, column: 12, excerpt: '"b": 2,,', raw: "Unexpected token" },
    });
    expect(html).toContain("JSON lisible");
    expect(html).toContain("Ligne 7");
    expect(html).toContain('"b": 2,,');
    // Le diagnostic de forme n'a aucun sens tant que le texte ne se lit pas.
    expect(html).not.toContain("assistant.goal");
  });

  it("aucune clé de traduction ne fuit, dans les deux langues", () => {
    for (const locale of ["fr", "en"] as const) {
      const html = render(locale, {
        issues: [
          enumIssue,
          missingIssue,
          { path: "x", segments: ["x"], code: "wrong_type", raw: "r", expected: "array", received: "string" },
          { path: "y", segments: ["y"], code: "too_big", raw: "r" },
          { path: "z", segments: ["z"], code: "other", raw: "un message que seul le schéma sait écrire" },
        ],
      });
      expect(html, locale).not.toContain("importIssues.");
      expect(html, locale).not.toContain("MISSING_MESSAGE");
      // Le fourre-tout « other » montre le message du schéma plutôt qu'un vide.
      expect(html, locale).toContain("un message que seul le schéma sait écrire");
    }
  });

  it("le type attendu et le type trouvé sont TOUS LES DEUX nommés", () => {
    const html = render("en", {
      issues: [
        {
          path: "assistant.tools",
          segments: ["assistant", "tools"],
          code: "wrong_type",
          raw: "r",
          expected: "array",
          received: "string",
          value: "get_slots,stop",
        },
      ],
    });
    // La phrase parle de TYPES…
    expect(html).toContain("expected array, found string");
    // …et la valeur du fichier se lit à part, sans brouiller la phrase.
    expect(html).toContain("get_slots,stop");
  });
});
