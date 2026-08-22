/**
 * Unitaire — les dialogues d'import ne peuvent pas afficher une clé brute.
 *
 * Le corps d'un dialogue Base UI n'existe pas dans un rendu serveur : ces
 * composants échappent aux tests de rendu, et une clé mal orthographiée ne se
 * verrait qu'à l'ouverture, en production, au pire moment — pendant qu'on
 * essaie de comprendre pourquoi un import a échoué.
 *
 * On vérifie donc les clés STATIQUEMENT, dans les deux langues.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import assistantsEn from "../messages/en/assistants.json";
import assistantsFr from "../messages/fr/assistants.json";
import campaignsEn from "../messages/en/campaigns.json";
import campaignsFr from "../messages/fr/campaigns.json";
import commonEn from "../messages/en/common.json";
import commonFr from "../messages/fr/common.json";
import { IMPORT_ISSUE_CODES } from "@/lib/import-diagnostics";

const BUNDLES = {
  assistants: { fr: assistantsFr, en: assistantsEn },
  campaigns: { fr: campaignsFr, en: campaignsEn },
  common: { fr: commonFr, en: commonEn },
} as const;

function lookup(bundle: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[part];
  }, bundle);
}

/** Les clés littérales `t("…")` d'un fichier — les gabarits sont traités à part. */
function literalKeys(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*"([^"$]+)"/g)].map((m) => m[1]);
}

const FILES: { path: string; namespace: keyof typeof BUNDLES; extra?: string[] }[] = [
  { path: "src/components/admin/assistant-import-dialog.tsx", namespace: "assistants" },
  { path: "src/components/admin/campaign-import-dialog.tsx", namespace: "campaigns" },
  {
    path: "src/components/admin/import-issues.tsx",
    namespace: "common",
    // Clé construite : `importIssues.code.${issue.code}`.
    extra: IMPORT_ISSUE_CODES.map((code) => `importIssues.code.${code}`),
  },
];

describe("clés des dialogues d'import", () => {
  for (const { path, namespace, extra = [] } of FILES) {
    it(`${path} n'emploie que des clés qui existent, en fr ET en en`, () => {
      const source = readFileSync(path, "utf8");
      const keys = [...new Set([...literalKeys(source), ...extra])];
      expect(keys.length, "aucune clé trouvée — l'extracteur est cassé").toBeGreaterThan(3);

      for (const locale of ["fr", "en"] as const) {
        const missing = keys.filter((key) => typeof lookup(BUNDLES[namespace][locale], key) !== "string");
        expect(
          missing,
          `${path} (${locale}) : clés absentes de messages/${locale}/${namespace}.json —\n  ${missing.join("\n  ")}`,
        ).toEqual([]);
      }
    });
  }

  it("chaque catégorie d'échec a une phrase, sauf le fourre-tout", () => {
    // « other » est volontairement vide : on montre alors le message du schéma,
    // qui en dit plus qu'une phrase générique.
    for (const locale of ["fr", "en"] as const) {
      for (const code of IMPORT_ISSUE_CODES) {
        const text = lookup(BUNDLES.common[locale], `importIssues.code.${code}`);
        expect(typeof text, `${locale} ${code}`).toBe("string");
        if (code !== "other") expect((text as string).length, `${locale} ${code}`).toBeGreaterThan(10);
      }
    }
  });

  it("le lien d'exemple pointe une route qui existe vraiment", () => {
    // Un « télécharger un exemple » qui donne un 404 est pire que rien.
    for (const { path } of FILES.slice(0, 2)) {
      const source = readFileSync(path, "utf8");
      const href = /href="(\/api\/docs\/examples\/[a-z]+)"/.exec(source)?.[1];
      expect(href, path).toBeTruthy();
      expect(["/api/docs/examples/assistant", "/api/docs/examples/campaign"]).toContain(href);
    }
  });
});
