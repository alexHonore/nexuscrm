/**
 * Unitaire — l'écran « Rôles et droits ».
 *
 * C'est l'écran le plus dangereux du produit : on y coche des cases qui
 * décident de ce que chacun voit. Trois choses doivent donc être vraies avant
 * qu'il s'affiche, et le typage n'en voit aucune :
 *
 *   1. Il PARLE — pas une clé de traduction nue, dans aucune des deux langues.
 *   2. Il dit ce qu'une case fait (le registre est rendu, pas ignoré).
 *   3. Il refuse de laisser croire qu'on peut retirer ses droits à
 *      l'administrateur ou en donner les clés à un autre rôle.
 */
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import adminFr from "../messages/fr/admin.json";
import adminEn from "../messages/en/admin.json";
import commonFr from "../messages/fr/common.json";
import commonEn from "../messages/en/common.json";
import { GRANT_KEYS, LOCKED_TO_ADMIN, PERMISSION_GROUPS, PERMISSION_KEYS } from "@/lib/permissions/catalog";
import { defaultPermissionsConfig } from "@/lib/permissions/defaults";
import { PERMISSION_DOCS, GRANT_DOCS, GROUP_DOCS, resolveDoc } from "@/lib/permissions/docs";
import { PERMISSION_TEXT_EN, GRANT_TEXT_EN, GROUP_TEXT_EN } from "@/lib/permissions/docs.en";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { RolesClient } = await import("@/components/admin/roles-client");
type RolesDocs = ComponentProps<typeof RolesClient>["docs"];
type IntlMessages = ComponentProps<typeof NextIntlClientProvider>["messages"];

function docsFor(locale: "fr" | "en"): RolesDocs {
  return {
    permissions: Object.fromEntries(
      PERMISSION_KEYS.map((k) => [k, resolveDoc(PERMISSION_DOCS[k], PERMISSION_TEXT_EN[k], locale)]),
    ),
    grants: Object.fromEntries(
      GRANT_KEYS.map((k) => [k, resolveDoc(GRANT_DOCS[k], GRANT_TEXT_EN[k], locale)]),
    ),
    groups: Object.fromEntries(
      PERMISSION_GROUPS.map((k) => [k, resolveDoc(GROUP_DOCS[k], GROUP_TEXT_EN[k], locale)]),
    ),
  };
}

const CONFIG = defaultPermissionsConfig();

/** `renderToStaticMarkup` échappe les apostrophes — les attentes aussi. */
function esc(text: string): string {
  return text.replaceAll("'", "&#x27;");
}

function render(locale: "fr" | "en" = "fr"): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop
    createElement(NextIntlClientProvider, {
      locale,
      messages: {
        admin: locale === "en" ? adminEn : adminFr,
        common: locale === "en" ? commonEn : commonFr,
      } as unknown as IntlMessages,
      children: createElement(RolesClient, {
        config: CONFIG,
        counts: { admin: 1, caller: 3, supervisor: 1, observer: 0 },
        members: { admin: ["Alex-Honoré"], caller: ["Luc", "Marie", "Nathalie"], supervisor: ["Chef"] },
        docs: docsFor(locale),
        locale,
      }),
    }),
  );
}

describe("écran des rôles — il parle", () => {
  for (const locale of ["fr", "en"] as const) {
    it(`aucune clé de traduction nue en ${locale}`, () => {
      const html = render(locale);
      expect(html).not.toContain("MISSING_MESSAGE");
      // Une clé non résolue se rend en « admin.roles.quelqueChose ».
      expect(html).not.toMatch(/admin\.roles\.[a-zA-Z]/);
      expect(html).not.toMatch(/common\.[a-zA-Z]+\.[a-zA-Z]/);
    });
  }

  it("les quatre rôles livrés sont là, chacun avec ses comptes", () => {
    const html = render("fr");
    for (const name of ["Administrateur", "Superviseur", "Téléphoniste", "Observateur"]) {
      expect(html, name).toContain(name);
    }
    expect(html).toContain("Alex-Honor");
  });

  it("l'écran anglais nomme les rôles en anglais", () => {
    const html = render("en");
    expect(html).toContain("Supervisor");
    expect(html).toContain("Observer");
  });
});

describe("écran des rôles — il explique", () => {
  it("chaque famille de droits porte son titre du registre", () => {
    const html = render("fr");
    for (const group of PERMISSION_GROUPS) {
      const label = resolveDoc(GROUP_DOCS[group], GROUP_TEXT_EN[group], "fr").label;
      expect(html, group).toContain(esc(label));
    }
  });

  it("les libellés des droits viennent du registre, pas du code de l'écran", () => {
    const html = render("fr");
    // Un échantillon suffit : si le registre est branché, il l'est pour tous.
    for (const key of ["clients.delete", "clients.contact", "admin.audit"] as const) {
      expect(html, key).toContain(esc(resolveDoc(PERMISSION_DOCS[key], PERMISSION_TEXT_EN[key], "fr").label));
    }
  });
});

describe("écran des rôles — ce qu'il refuse de laisser croire", () => {
  it("les clés de la maison sont annoncées comme verrouillées", () => {
    // Deux droits, deux mentions : « comptes utilisateurs » et « rôles et
    // droits » portent chacun l'explication, à côté d'un interrupteur éteint.
    const html = render("fr");
    expect(LOCKED_TO_ADMIN).toHaveLength(2);
    expect(html.split(esc(adminFr.roles.permissionsLocked)).length - 1).toBe(LOCKED_TO_ADMIN.length);
  });

  // Les deux avertissements suivants vivent dans un onglet ou sur un rôle qui
  // n'est pas celui ouvert au premier rendu (Base UI ne rend pas un panneau
  // fermé). On vérifie donc qu'ils sont CÂBLÉS, pas qu'ils sont peints — les
  // supprimer par mégarde reste attrapé.
  it("le rôle administrateur a sa bannière de lecture seule", () => {
    expect(SOURCE).toContain("roles.adminLocked");
  });

  it("un compartiment fermé prévient de ce que « invisible » veut dire", () => {
    expect(SOURCE).toContain("roles.invisibleWarning");
  });
});

const SOURCE = readFileSync("src/components/admin/roles-client.tsx", "utf8");

/**
 * Les clés que l'écran construit à l'exécution, dérivées du MOTEUR : chaque
 * règle d'assignation, par rôle et commune, a son libellé.
 */
const CONSTRUCTED = [
  ...Object.keys(CONFIG.roles[0].assignment),
  ...Object.keys(CONFIG.assignment),
].map((key) => `roles.${key}`);

describe("écran des rôles — parité des clés", () => {
  /** Les clés « admin.… » écrites en toutes lettres dans l'écran. */
  function literalKeys(source: string): string[] {
    return [...source.matchAll(/\bt(?:\.\w+)?\(\s*"(roles\.[^"$]+)"/g)].map((m) => m[1]);
  }

  function lookup(bundle: unknown, key: string): unknown {
    return key.split(".").reduce<unknown>((node, part) => {
      if (node === null || typeof node !== "object") return undefined;
      return (node as Record<string, unknown>)[part];
    }, bundle);
  }

  it("chaque clé utilisée existe dans les DEUX langues", () => {
    const keys = [...new Set([...literalKeys(SOURCE), ...CONSTRUCTED])];
    expect(keys.length).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const key of keys) {
      if (typeof lookup(adminFr, key) !== "string") missing.push(`fr:${key}`);
      if (typeof lookup(adminEn, key) !== "string") missing.push(`en:${key}`);
    }
    expect(missing, `Clés absentes :\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("les clés BÂTIES à l'exécution sont toutes connues", () => {
    // L'écran écrit `t(`roles.${key}`)` pour les interrupteurs d'assignation :
    // c'est légitime (la liste des clés est celle du moteur), mais ça échappe
    // au test ci-dessus. CONSTRUCTED les rattrape en les dérivant du moteur
    // lui-même — impossible d'oublier d'y ajouter une règle nouvelle.
    const templates = [...SOURCE.matchAll(/\bt\(\s*`roles\.\$\{(\w+)\}`/g)].map((m) => m[1]);
    expect(templates.length).toBeGreaterThan(0);
    expect(new Set(templates)).toEqual(new Set(["key"]));
  });
});
