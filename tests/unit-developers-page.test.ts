/**
 * Unitaire — la référence développeurs publique.
 *
 * C'est la seule page de l'application qu'une personne sans compte peut lire.
 * Deux choses peuvent mal tourner, et aucune ne se voit à la relecture :
 *
 * 1. Elle publie quelque chose qui vient de la BASE. Le registre des
 *    paramètres a deux lectures — `listParamDocs()` (le code) et
 *    `getParamDocs()` (le code FUSIONNÉ avec les réécritures administrateur).
 *    La seconde contient du texte interne écrit pour l'exploitant. Se tromper
 *    de fonction est une fuite silencieuse : la page s'affiche parfaitement.
 *
 * 2. Elle ment. Les alias de champs viennent du même module que la route qui
 *    les lit ; si quelqu'un les recopie dans la doc, l'intégrateur envoie un
 *    champ qui n'existe plus et son lead entre sans téléphone, sans erreur.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DevelopersContent, type DevData } from "@/components/developers/developers-content";
import { TOOL_DEFS } from "@/lib/agent/tools";
import { CAMPAIGN_FIELD_DOCS, campaignFieldText } from "@/lib/campaigns/docs";
import { API_ENDPOINTS, apiEndpointText, pageText } from "@/lib/docs/api";
import { API_TEXT_EN } from "@/lib/docs/api.en";
import { exampleAssistantFile, exampleCampaignFile } from "@/lib/docs/examples";
import { resolveParamDoc } from "@/lib/docs/locale";
import { listParamDocs } from "@/lib/docs/params";
import type { DocLocale } from "@/lib/docs/types";
import {
  GUARDRAIL_KIND_DOCS,
  GUARDRAIL_SEVERITY_DOCS,
  kindText,
  severityText,
} from "@/lib/guardrails/docs";
import { LEAD_FIELD_ALIASES } from "@/lib/webhooks/lead-fields";

const NOW = new Date("2026-01-01T12:00:00.000Z");

function data(locale: DocLocale): DevData {
  return {
    baseUrl: "https://crm.example.com",
    endpoints: API_ENDPOINTS.map((e) => apiEndpointText(e, locale)),
    params: listParamDocs().map((d) => resolveParamDoc({ ...d, overridden: false }, locale)),
    campaignFields: CAMPAIGN_FIELD_DOCS.map((f) => ({
      ...campaignFieldText(f, locale),
      path: f.path,
    })),
    guardrailKinds: Object.values(GUARDRAIL_KIND_DOCS).map((k) => ({
      ...kindText(k, locale),
      kind: k.kind,
    })),
    severities: Object.values(GUARDRAIL_SEVERITY_DOCS).map((s) => ({
      ...severityText(s, locale),
      severity: s.severity,
    })),
    tools: Object.values(TOOL_DEFS).map((d) => ({ name: d.name, description: d.description })),
    examples: {
      assistant: exampleAssistantFile(NOW, locale),
      campaign: exampleCampaignFile(NOW, locale),
    },
  };
}

function render(locale: DocLocale): string {
  return renderToStaticMarkup(
    createElement(DevelopersContent, { text: pageText(locale), data: data(locale) }),
  );
}

const source = (path: string) => readFileSync(path, "utf8");

/**
 * Le code, sans les commentaires.
 *
 * Le garde ci-dessous cherche `getParamDocs` — et le fichier surveillé
 * explique en toutes lettres pourquoi il ne l'appelle PAS. Une vérification
 * qui interdit de nommer le piège qu'elle surveille se fait désarmer par la
 * première personne qui documente son choix.
 */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("référence développeurs — ce qui ne doit JAMAIS sortir", () => {
  it("ni la page ni la spécification ne lisent la base", () => {
    // `getParamDocs` fusionne les réécritures administrateur : du texte
    // interne, sur une page publique, sans que rien ne le signale à l'écran.
    for (const file of [
      "src/app/developers/page.tsx",
      "src/app/api/docs/public/route.ts",
      "src/components/developers/developers-content.tsx",
    ]) {
      const body = code(file);
      expect(body, `${file} — docs-server`).not.toContain("docs-server");
      expect(body, `${file} — getParamDocs`).not.toContain("getParamDocs");
      expect(body, `${file} — @/db`).not.toContain('from "@/db"');
    }
  });

  it("la page est bien ouverte sans session dans le garde de routage", () => {
    // Sans cette ligne, /developers redirige vers /login : une documentation
    // d'intégration réservée à ceux qui ont déjà un accès ne sert à rien.
    expect(source("src/proxy.ts")).toContain('pathname === "/developers"');
  });

  it("chaque surface publique mène à la référence", () => {
    // Une page publique qu'aucun lien public n'atteint est une page privée
    // avec une adresse devinable : celui qui la cherche n'a pas de compte, et
    // n'a donc que ces trois pieds de page pour tomber dessus.
    for (const file of [
      "src/app/landing.tsx",
      "src/app/(legal)/legal-shell.tsx",
      "src/app/(auth)/layout.tsx",
    ]) {
      expect(source(file), file).toContain('href="/developers"');
    }
  });

  it("le libellé du lien existe dans les deux langues, dans les deux namespaces", () => {
    // Deux pieds de page, deux namespaces : `home` pour l'accueil, `legal`
    // pour les pages légales et la connexion. Un seul traduit laisserait fuir
    // une clé brute sur la moitié des écrans publics.
    for (const ns of ["home", "legal"]) {
      for (const locale of ["fr", "en"]) {
        const messages = JSON.parse(source(`messages/${locale}/${ns}.json`)) as Record<
          string,
          unknown
        >;
        expect(messages.developers, `${locale}/${ns}.developers`).toBeTruthy();
      }
    }
  });

  it("la référence n'est pas un cul-de-sac : son pied ramène au reste du site", () => {
    const page = source("src/app/developers/page.tsx");
    for (const href of ["/privacy", "/terms", "/login"]) {
      expect(page, href).toContain(`href="${href}"`);
    }
  });

  it("aucun exemple ne porte de secret ressemblant à une vraie clé", () => {
    // Un exemple se copie-colle. Celui qui contient une clé plausible finit
    // dans un dépôt public, et personne ne se demande d'où elle venait.
    const html = render("fr") + render("en");
    expect(html).toContain("$NEXUS_API_KEY");
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(html).not.toMatch(/\bAC[0-9a-f]{32}\b/);
  });
});

describe("référence développeurs — le contrat qu'elle promet", () => {
  it("documente le webhook des leads, sa clé et son seul champ obligatoire", () => {
    const html = render("fr");
    expect(html).toContain("/api/webhooks/leads");
    expect(html).toContain("x-api-key");
    expect(html).toContain("POST");
    // « phone » est le seul champ sans lequel l'appel échoue.
    expect(html).toContain("obligatoire");
    expect(html).toContain("invalid_phone");
  });

  it("les alias affichés sont CEUX de la route, pas une copie", () => {
    const html = render("fr");
    // Facebook envoie ses libellés de question accentués : c'est exactement ce
    // qu'un intégrateur cherche mot pour mot dans une doc.
    for (const alias of LEAD_FIELD_ALIASES.phone) {
      expect(html, alias).toContain(alias);
    }
    // …et tout champ documenté est un champ que la route sait vraiment lire.
    const documented = API_ENDPOINTS.flatMap((e) => e.fields.map((f) => f.name));
    for (const name of documented) {
      expect(Object.keys(LEAD_FIELD_ALIASES), name).toContain(name);
    }
  });

  it("le schéma de configuration descend en entier, groupé par section", () => {
    const html = render("fr");
    const params = listParamDocs();
    expect(params.length).toBeGreaterThan(50);
    // Trois chemins de trois sections différentes : la preuve que le tableau
    // n'est pas tronqué à la première section.
    for (const path of ["identity.mode", "goal.primary.type", "approach.persistence"]) {
      expect(html, path).toContain(path);
    }
  });

  it("les neuf outils de l'agent sont listés", () => {
    const html = render("fr");
    for (const tool of Object.values(TOOL_DEFS)) {
      expect(html, tool.name).toContain(tool.name);
    }
  });
});

describe("référence développeurs — les deux langues", () => {
  it("chaque point d'entrée est traduit, champ par champ et code par code", () => {
    // Le français est la source ; l'anglais retomberait dessus en silence.
    for (const e of API_ENDPOINTS) {
      const en = API_TEXT_EN[e.id];
      expect(en, `endpoint ${e.id}`).toBeDefined();
      expect(en.label.length, `${e.id}.label`).toBeGreaterThan(0);
      for (const f of e.fields) {
        expect(en.fields[f.name], `${e.id}.fields.${f.name}`).toBeTruthy();
      }
      for (const r of e.responses) {
        expect(en.responses[r.code ?? String(r.status)], `${e.id}.responses.${r.code}`).toBeTruthy();
      }
      expect(en.notes.length, `${e.id}.notes`).toBe(e.notesFr.length);
    }
  });

  it("la page anglaise ne retombe pas sur le français", () => {
    const en = render("en");
    expect(en).toContain("Getting started");
    expect(en).toContain("What this page covers");
    expect(en).not.toContain("Pour commencer");
    expect(en).not.toContain("Ce que couvre cette page");
  });

  it("les noms de champs et les codes machine ne sont PAS traduits", () => {
    // Traduire « phone » en « téléphone » documenterait un point d'entrée qui
    // n'existe pas.
    const en = render("en");
    expect(en).toContain("phone");
    expect(en).toContain("invalid_phone");
    expect(en).toContain("/api/webhooks/leads");
  });
});
