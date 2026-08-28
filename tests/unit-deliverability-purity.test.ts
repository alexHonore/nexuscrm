/**
 * Unitaire — la frontière du module de délivrabilité tient.
 *
 * Tout ce qui décide « ce chiffre est-il inquiétant » vit dans
 * `src/lib/deliverability` : pur, sans base, sans réseau, sans horloge
 * implicite. C'est ce qui rend la règle « 30007 au-dessus de 1 % = danger »
 * vérifiable sans monter un Postgres — et c'est exactement la propriété qu'on
 * perd le jour où quelqu'un importe `db` « juste pour un compte de plus ».
 *
 * Le sens de la frontière compte aussi : ces modules sont lus par
 * `src/lib/deliverability-server`, qui lui touche la base ET le réseau. Un
 * `import "server-only"` égaré du mauvais côté ferait planter la page en
 * production, pas ici.
 *
 * Un garde qui ne peut pas échouer ne protège rien : le dernier cas plante un
 * fautif imaginaire et exige que le détecteur le voie.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PURE_DIR = "src/lib/deliverability";
const SERVER_DIR = "src/lib/deliverability-server";

/** Tout ce qui ferait sortir un module pur de sa pureté. */
const FORBIDDEN_IN_PURE = [
  { pattern: /from\s+["']next-intl/, why: "next-intl (la langue arrive en paramètre)" },
  { pattern: /\bNEXT_LOCALE\b/, why: "le cookie NEXT_LOCALE" },
  { pattern: /from\s+["']next\/headers["']/, why: "next/headers" },
  { pattern: /\buseLocale\s*\(/, why: "useLocale()" },
  { pattern: /\bgetLocale\s*\(/, why: "getLocale()" },
  { pattern: /from\s+["']@\/db/, why: "un accès base de données" },
  { pattern: /import\s+["']server-only["']/, why: "server-only (ce module doit rester isomorphe)" },
  { pattern: /\bprocess\.env\b/, why: "une lecture d'environnement" },
  { pattern: /\bfetch\s*\(/, why: "un appel réseau" },
  { pattern: /\bDate\.now\s*\(/, why: "une horloge implicite (`facts.now` est fourni)" },
  { pattern: /\bnew Date\s*\(\s*\)/, why: "une horloge implicite (`facts.now` est fourni)" },
];

/**
 * Le code SANS les commentaires.
 *
 * Ces modules documentent longuement POURQUOI ils n'ont pas le droit
 * d'importer `server-only` ni `@/db` — un garde qui lirait les commentaires
 * accuserait précisément les fichiers les mieux expliqués.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("frontière du module de délivrabilité", () => {
  it("les modules de calcul restent purs", () => {
    const offenders: string[] = [];
    for (const file of walk(PURE_DIR)) {
      const source = codeOnly(readFileSync(file, "utf8"));
      for (const { pattern, why } of FORBIDDEN_IN_PURE) {
        if (pattern.test(source)) offenders.push(`${file} → ${why}`);
      }
    }
    expect(
      offenders,
      "Ces modules doivent pouvoir être testés sans base ni réseau :\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("chaque module serveur s'annonce comme serveur", () => {
    const offenders = walk(SERVER_DIR).filter(
      (file) => !readFileSync(file, "utf8").startsWith('import "server-only";'),
    );
    expect(
      offenders,
      "Sans `import \"server-only\"` en première ligne, un de ces modules peut être " +
        "embarqué dans un paquet client — avec l'URL de la base dedans :\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  it("le détecteur voit encore un fautif", () => {
    const planted = [
      'import { db } from "@/db";',
      'const now = Date.now();',
      'import { useTranslations } from "next-intl";',
    ];
    for (const line of planted) {
      const seen = FORBIDDEN_IN_PURE.some(({ pattern }) => pattern.test(line));
      expect(seen, `Le garde ne reconnaît plus « ${line} » — il ne protège plus rien.`).toBe(true);
    }
  });
});
