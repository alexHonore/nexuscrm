/**
 * Unitaire — la référence des droits existe dans les DEUX langues, en entier.
 *
 * Même discipline que `unit-docs-locale.test.ts` : le français décide quelles
 * fiches existent, l'anglais les traduit, et une fiche qui part sans traduction
 * fait échouer le build. Un écran de droits est le pire endroit où laisser une
 * moitié d'explication : on y coche des cases dont on ne comprend pas la
 * portée, et on les coche toutes.
 *
 * Ce test vérifie AUSSI la couverture : chaque droit du catalogue et chaque
 * case de relation a sa fiche. Un droit ajouté au catalogue sans texte est un
 * interrupteur anonyme dans une matrice de trente-quatre.
 */
import { describe, expect, it } from "vitest";
import {
  GRANT_KEYS,
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
} from "@/lib/permissions/catalog";
import {
  ASSIGNMENT_DOCS,
  GRANT_DOCS,
  GROUP_DOCS,
  PERMISSION_DOCS,
  resolveDoc,
  type DocEntry,
} from "@/lib/permissions/docs";
import {
  ASSIGNMENT_TEXT_EN,
  GRANT_TEXT_EN,
  GROUP_TEXT_EN,
  PERMISSION_TEXT_EN,
} from "@/lib/permissions/docs.en";

/** Les règles d'assignation documentées — quatre par rôle, quatre communes. */
const ASSIGNMENT_ENTRIES = [
  "claimPool",
  "release",
  "assignToOthers",
  "takeFromOthers",
  "maxOwned",
  "staleDays",
  "claimOnCall",
  "notifyAssignee",
  "notifyPreviousOwner",
] as const;

/**
 * Un texte encore français, reconnu sans dictionnaire — mêmes mots-outils que
 * `unit-docs-locale.test.ts`, pour que les deux tests jugent pareil.
 */
function looksFrench(text: string): boolean {
  if (/[«»]/.test(text)) return true;
  return /\b(le|la|les|une|des|du|aux|et|ou|pour|avec|sans|dans|sur|par|est|sont|pas|plus|vous|votre|nous|cette|qui|que|quand|aucun|aucune|tout|tous|ce|ça|fiche|fiches|droit|droits)\b/i.test(
    text,
  );
}

type Registry = {
  name: string;
  fr: Record<string, DocEntry>;
  en: Record<string, { label: string; what: string; why?: string; pitfalls?: string }>;
  keys: readonly string[];
};

const REGISTRIES: Registry[] = [
  { name: "droits", fr: PERMISSION_DOCS, en: PERMISSION_TEXT_EN, keys: PERMISSION_KEYS },
  { name: "cases de relation", fr: GRANT_DOCS, en: GRANT_TEXT_EN, keys: GRANT_KEYS },
  { name: "familles", fr: GROUP_DOCS, en: GROUP_TEXT_EN, keys: PERMISSION_GROUPS },
  { name: "assignation", fr: ASSIGNMENT_DOCS, en: ASSIGNMENT_TEXT_EN, keys: ASSIGNMENT_ENTRIES },
];

for (const reg of REGISTRIES) {
  describe(`référence des ${reg.name}`, () => {
    it("chaque clé du catalogue a sa fiche française", () => {
      const missing = reg.keys.filter((k) => !reg.fr[k]);
      expect(missing, `Fiches manquantes dans docs.ts :\n  ${missing.join("\n  ")}`).toEqual([]);
    });

    it("aucune fiche ne documente une clé qui n'existe pas", () => {
      const known = new Set<string>(reg.keys);
      const orphans = Object.keys(reg.fr).filter((k) => !known.has(k));
      expect(orphans, `Fiches orphelines : ${orphans.join(", ")}`).toEqual([]);
    });

    it("chaque fiche dit CE QUE c'est, assez pour être utile", () => {
      for (const key of reg.keys) {
        const doc = reg.fr[key];
        if (!doc) continue;
        expect(doc.labelFr.trim().length, `${key}.labelFr`).toBeGreaterThan(0);
        expect(doc.whatFr.trim().length, `${key}.whatFr`).toBeGreaterThan(20);
      }
    });

    it("chaque fiche est traduite", () => {
      const missing = reg.keys.filter((k) => reg.fr[k] && !reg.en[k]);
      expect(missing, `Sans traduction dans docs.en.ts :\n  ${missing.join("\n  ")}`).toEqual([]);
    });

    it("aucune traduction orpheline", () => {
      const known = new Set<string>(reg.keys);
      const orphans = Object.keys(reg.en).filter((k) => !known.has(k));
      expect(orphans, `Traductions orphelines : ${orphans.join(", ")}`).toEqual([]);
    });

    it("la traduction porte les MÊMES champs que le français", () => {
      for (const key of reg.keys) {
        const doc = reg.fr[key];
        const en = reg.en[key];
        if (!doc || !en) continue;
        expect(en.label.trim().length, `${key}.label`).toBeGreaterThan(0);
        expect(en.what.trim().length, `${key}.what`).toBeGreaterThan(20);
        // Un « pourquoi » ou un « piège » qui disparaît en anglais est une
        // information perdue, pas une traduction.
        expect(Boolean(en.why), `${key} — why`).toBe(Boolean(doc.whyFr));
        expect(Boolean(en.pitfalls), `${key} — pitfalls`).toBe(Boolean(doc.pitfallsFr));
      }
    });

    it("le texte anglais est en ANGLAIS", () => {
      const french: string[] = [];
      for (const key of reg.keys) {
        const doc = reg.fr[key];
        if (!doc) continue;
        const text = resolveDoc(doc, reg.en[key], "en");
        for (const [field, value] of Object.entries(text)) {
          if (value && looksFrench(value)) french.push(`${key}.${field}`);
        }
      }
      expect(french, `Texte encore français :\n  ${french.join("\n  ")}`).toEqual([]);
    });

    it("le français reste la source : il est rendu tel quel", () => {
      for (const key of reg.keys) {
        const doc = reg.fr[key];
        if (!doc) continue;
        const fr = resolveDoc(doc, reg.en[key], "fr");
        expect(fr.label).toBe(doc.labelFr);
        expect(fr.what).toBe(doc.whatFr);
        expect(fr.why).toBe(doc.whyFr);
      }
    });
  });
}

describe("repli", () => {
  it("une traduction absente retombe sur le français, jamais sur du vide", () => {
    const doc = PERMISSION_DOCS[PERMISSION_KEYS[0]];
    if (!doc) return;
    const text = resolveDoc(doc, undefined, "en");
    expect(text.label).toBe(doc.labelFr);
    expect(text.what).toBe(doc.whatFr);
  });
});
