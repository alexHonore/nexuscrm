/**
 * Unitaire — rien d'INSÉRIALISABLE ne traverse la frontière serveur → client.
 *
 * Le bogue que ce fichier existe pour empêcher, rencontré en production le
 * 2026-08-27 sur le tableau de bord : une page serveur passait `dfnsLocale`
 * (une locale `date-fns`) en propriété d'un composant « use client ». Une
 * locale est un OBJET DE FONCTIONS — `preprocessor`, `ordinalNumber`, `era`,
 * `quarter`… — et React refuse de les sérialiser :
 *
 *     Functions cannot be passed directly to Client Components
 *
 * L'écran entier rendait « Une erreur de serveur s'est produite ».
 *
 * Pourquoi un test STATIQUE et pas un rendu : les tests de composants rendent
 * avec `renderToStaticMarkup`, sans frontière RSC. Ils passaient AVANT et
 * APRÈS le correctif — aucun rendu ne peut attraper ça. C'est le même genre
 * d'invariant que « pas de couleur en dur » (unit-look) ou « pas de next-intl
 * dans l'agent » (unit-agent-locale), et il se vérifie de la même façon : en
 * lisant les fichiers.
 *
 * La règle exacte : un fichier SERVEUR de `src/app` ne passe jamais une locale
 * `date-fns` en propriété JSX. Il la garde pour lui — `formatInTimeZone(…, {
 * locale })` sur le serveur — et transmet une CHAÎNE déjà mise en forme, comme
 * le fait `dueLabel` des suivis. Un composant client qui a besoin d'une locale
 * la dérive lui-même de `useLocale()`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = join(process.cwd(), "src", "app");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Une locale date-fns, sous les noms qu'elle porte dans ce dépôt. */
const LOCALE_PROP = /\b[\w-]+=\{\s*(dfnsLocale|dateLocale)\s*\}/;

describe("frontière serveur → client", () => {
  it("§ aucune page serveur ne passe une locale date-fns en propriété", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(APP_DIR)) {
      const source = readFileSync(file, "utf8");
      // Un fichier « use client » n'est pas concerné : de composant client à
      // composant client, une locale passe très bien.
      if (/^\s*["']use client["']/m.test(source)) continue;
      const line = source.split("\n").findIndex((l) => LOCALE_PROP.test(l));
      if (line >= 0) offenders.push(`${file.replace(process.cwd() + "/", "")}:${line + 1}`);
    }

    expect(
      offenders,
      `Une locale date-fns est un objet de FONCTIONS : React refuse de la sérialiser et la page rend « Une erreur de serveur s'est produite ».\n` +
        `Mettez la date en forme sur le serveur et passez la chaîne (voir « dueLabel » des suivis) :\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("le détecteur voit bien ce qu'il doit voir", () => {
    // Un test de garde qui ne peut pas échouer ne protège rien : on vérifie
    // que le motif attrape la forme exacte du bogue, et laisse passer l'usage
    // légitime (garder la locale pour soi, côté serveur).
    expect(LOCALE_PROP.test("<AttentionList rows={rows} dfnsLocale={dfnsLocale} />")).toBe(true);
    expect(LOCALE_PROP.test("        dfnsLocale={dfnsLocale}")).toBe(true);
    expect(LOCALE_PROP.test("formatInTimeZone(at, APP_TZ, fmt, { locale: dfnsLocale })")).toBe(
      false,
    );
    expect(LOCALE_PROP.test("const dfnsLocale = locale === \"en\" ? enUS : fr;")).toBe(false);
  });
});
