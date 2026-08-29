/**
 * Unitaire — le français et l'anglais disent la MÊME chose.
 *
 * Ce que ce test protège : rien, jusqu'ici, ne comparait `messages/fr` et
 * `messages/en`. Une clé ajoutée d'un seul côté ne casse pas la compilation,
 * ne fait pas rougir un écran en développement (l'interface est en français par
 * défaut) et n'apparaît qu'aux utilisateurs anglophones, sous la forme d'un
 * `MISSING_MESSAGE` en plein milieu d'un écran — découvert par eux, pas par
 * nous.
 *
 * La règle 2 dit « chaque module remplit SON namespace, en fr ET en ». Ce
 * fichier est ce qui la rend vérifiable, et il devient indispensable
 * maintenant que certaines de ces chaînes s'affichent sur un écran verrouillé,
 * où l'on ne peut pas les corriger après coup.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const FR = join(ROOT, "messages/fr");
const EN = join(ROOT, "messages/en");

type Json = { [key: string]: unknown };

function load(dir: string, file: string): Json {
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as Json;
}

/** Aplatit « content.smsInboundTitle » — on compare des chemins, pas des objets. */
function paths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Json)) {
    out.push(...paths(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

const frFiles = readdirSync(FR).filter((f) => f.endsWith(".json")).sort();
const enFiles = readdirSync(EN).filter((f) => f.endsWith(".json")).sort();

describe("les deux langues ont les mêmes fichiers", () => {
  it("aucun namespace n'existe d'un seul côté", () => {
    expect(frFiles).toEqual(enFiles);
  });
});

describe.each(frFiles)("%s", (file) => {
  const fr = load(FR, file);
  const en = load(EN, file);
  const frPaths = paths(fr).sort();
  const enPaths = paths(en).sort();

  it("chaque clé française a sa traduction", () => {
    const missing = frPaths.filter((p) => !enPaths.includes(p));
    expect(
      missing,
      `Clés présentes en français et absentes en anglais dans ${file} :\n  ${missing.join("\n  ")}\n` +
        `Le français est la source (règle 2) : ajoutez-les dans messages/en/${file}.`,
    ).toEqual([]);
  });

  it("aucune clé anglaise orpheline", () => {
    // L'inverse compte aussi : une clé qui ne survit qu'en anglais est du code
    // mort qu'on traduira encore dans dix ans.
    const orphans = enPaths.filter((p) => !frPaths.includes(p));
    expect(
      orphans,
      `Clés présentes en anglais et absentes en français dans ${file} :\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });

  it("aucune traduction perdue en route", () => {
    // Une chaîne vide passe la comparaison de clés et rend un écran muet. Mais
    // une clé vide DES DEUX CÔTÉS est un choix — `importIssues.code.other` est
    // le repli d'un code d'erreur inconnu, et il ne doit rien afficher. C'est
    // l'ASYMÉTRIE qu'on traque : traduite d'un côté, oubliée de l'autre.
    const at = (obj: Json, p: string) =>
      p.split(".").reduce<unknown>((acc, k) => (acc as Json)?.[k], obj);
    const lost = paths(fr).filter((p) => {
      const frValue = at(fr, p);
      const enValue = at(en, p);
      if (typeof frValue !== "string" || typeof enValue !== "string") return false;
      return (frValue.trim() === "") !== (enValue.trim() === "");
    });
    expect(
      lost,
      `Chaînes remplies d'un seul côté dans ${file} :\n  ${lost.join("\n  ")}`,
    ).toEqual([]);
  });
});
