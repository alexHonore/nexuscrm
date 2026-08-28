/**
 * Unitaire — le catalogue de délivrabilité existe dans les DEUX langues.
 *
 * Même discipline que `tests/unit-docs-locale.test.ts`, appliquée au registre
 * des constats : le français est la SOURCE (il décide quels constats
 * existent, leur famille, leur gravité, l'indicateur qui les déclenche),
 * l'anglais n'est qu'une surcouche de MOTS par identifiant, exactement comme
 * `messages/<locale>/<ns>.json`.
 *
 * Ce que ce fichier empêche, et pourquoi il vaut la peine : un constat ajouté
 * au catalogue part avec ses trois textes français et rien d'autre. Personne ne
 * s'en aperçoit — l'écran s'affiche, la page est verte — jusqu'au jour où
 * l'administrateur bascule en anglais et tombe sur un bloc de français au
 * milieu de sa page. Sur un tableau de bord de conformité, ce bloc est
 * précisément celui qu'il devait lire.
 *
 * Deux gardes de plus, propres à ce registre :
 *  · `sourceUrl` n'est JAMAIS traduite. C'est une pièce à conviction, pas de
 *    la prose : traduire un lien vers la doc Twilio ou vers les principes du
 *    CTIA enverrait le lecteur sur un document qui n'existe pas.
 *  · Aucun texte ne parle de CONSENTEMENT (règle 12 du dépôt, décision de
 *    l'exploitant du 2026-08-22). Il n'y a ni porte, ni registre, ni réglage
 *    de consentement dans ce produit : les seules barrières sont le
 *    désabonnement (STOP / `suppressions`) et `doNotCall`. Un conseil qui dit
 *    « vérifiez le consentement » envoie l'opérateur chercher un écran qui
 *    n'existe pas, et lui fait croire qu'il lui manque une permission.
 *
 * Ce que ce test NE vérifie PAS, délibérément : la langue de l'ASSISTANT. Rien
 * de ce registre n'entre dans un prompt — ce sont des mots pour
 * l'administrateur qui regarde l'écran, jamais pour le contact qui reçoit un
 * SMS (règle 13, et `tests/unit-agent-locale.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { FINDING_DOCS, findingText, type FindingDoc } from "@/lib/deliverability/findings";
import { FINDING_TEXT_EN } from "@/lib/deliverability/findings.en";
import { FINDING_IDS, type FindingId } from "@/lib/deliverability/types";

/**
 * Recopié À L'IDENTIQUE de `tests/unit-docs-locale.test.ts` — volontairement,
 * plutôt que partagé : un détecteur mis en commun serait un jour assoupli pour
 * débloquer UN fichier, et relâcherait du même geste tous les autres. Un texte
 * encore français, reconnu sans dictionnaire : les guillemets français, et les
 * mots-outils qui n'existent pas en anglais. « Québec », « Lévis » et
 * « Alex-Honoré » restent évidemment permis.
 */
function looksFrench(text: string): boolean {
  if (/[«»]/.test(text)) return true;
  return /\b(le|la|les|une|des|du|aux|et|ou|pour|avec|sans|dans|sur|par|est|sont|pas|plus|vous|votre|nous|cette|qui|que|quand|aucun|aucune|tout|tous|ce|ça)\b/i.test(
    text,
  );
}

const DOCS: FindingDoc[] = FINDING_IDS.map((id) => FINDING_DOCS[id]);

// ── Parité ───────────────────────────────────────────────────────────────────

describe("constats de délivrabilité — parité fr/en", () => {
  it("le catalogue n'est pas vide", () => {
    // Un registre vide ferait passer TOUS les cas suivants sans rien vérifier.
    expect(FINDING_IDS.length, "catalogue vide ?").toBeGreaterThan(20);
    expect(DOCS.length).toBe(FINDING_IDS.length);
  });

  it("CHAQUE constat a une traduction anglaise", () => {
    const missing = FINDING_IDS.filter((id) => !FINDING_TEXT_EN[id]);
    expect(
      missing,
      `Constats sans traduction dans src/lib/deliverability/findings.en.ts :\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("aucune traduction ne pointe vers un constat disparu du registre", () => {
    // Une entrée orpheline est du texte mort : elle survit au constat qu'elle
    // décrivait et fait croire, à la relecture, que le cas est encore couvert.
    const known = new Set<string>(FINDING_IDS);
    const orphans = Object.keys(FINDING_TEXT_EN).filter((id) => !known.has(id));
    expect(orphans, `Traductions orphelines : ${orphans.join(", ")}`).toEqual([]);
  });

  it("les trois textes existent et disent quelque chose, dans les deux langues", () => {
    // Un libellé sans « pourquoi » laisse l'opérateur devant un voyant rouge
    // qu'il ne sait pas interpréter ; un « pourquoi » sans geste le laisse
    // devant un problème qu'il ne sait pas corriger. Les seuils de longueur
    // sont ceux du registre des paramètres : ils n'attrapent pas une mauvaise
    // phrase, ils attrapent un champ rempli à la va-vite (« À corriger. »).
    const thin: string[] = [];
    for (const doc of DOCS) {
      for (const [locale, text] of [
        ["fr", findingText(doc, "fr")],
        ["en", findingText(doc, "en")],
      ] as const) {
        if (text.label.trim().length <= 3) thin.push(`${doc.id}.label (${locale})`);
        if (text.why.trim().length <= 20) thin.push(`${doc.id}.why (${locale})`);
        if (text.fix.trim().length <= 15) thin.push(`${doc.id}.fix (${locale})`);
      }
    }
    expect(thin, `Textes absents ou trop maigres :\n  ${thin.join("\n  ")}`).toEqual([]);
  });

  it("l'anglais du registre n'apporte QUE des mots", () => {
    // Une traduction qui glisserait une `severity`, une `family` ou un
    // `metric` ferait diverger les deux langues sur la GRAVITÉ d'un même fait,
    // et une seule des deux pourrait avoir raison. Le type l'interdit déjà ;
    // ce cas le vérifie sur les données réelles.
    for (const [id, text] of Object.entries(FINDING_TEXT_EN)) {
      expect(Object.keys(text).sort(), `${id} porte autre chose que du texte`).toEqual([
        "fix",
        "label",
        "why",
      ]);
    }
  });
});

// ── Le détecteur, dans les deux sens ─────────────────────────────────────────

describe("le texte anglais est en ANGLAIS", () => {
  it("aucun texte rendu en anglais ne reste français", () => {
    const french: string[] = [];
    for (const doc of DOCS) {
      const text = findingText(doc, "en");
      for (const [field, value] of Object.entries(text)) {
        if (value && looksFrench(value)) french.push(`${doc.id}.${field}`);
      }
    }
    expect(french, `Texte encore français :\n  ${french.join("\n  ")}`).toEqual([]);
  });

  it("… et le détecteur reconnaît bien le français quand il en voit", () => {
    // Contre-épreuve indispensable : un détecteur cassé (une expression
    // régulière qui ne correspond plus à rien) rendrait le cas précédent vert
    // pour toujours, y compris sur quarante-cinq constats jamais traduits.
    // On le passe donc sur les quatre-vingt-dix textes FRANÇAIS du registre —
    // « pourquoi » et « geste », des phrases entières, où un mot-outil est
    // certain d'apparaître.
    const undetected: string[] = [];
    for (const doc of DOCS) {
      if (!looksFrench(doc.whyFr)) undetected.push(`${doc.id}.whyFr`);
      if (!looksFrench(doc.fixFr)) undetected.push(`${doc.id}.fixFr`);
    }
    expect(undetected, `Français non reconnu — détecteur cassé :\n  ${undetected.join("\n  ")}`).toEqual([]);
    // Les LIBELLÉS sont hors du contre-test à dessein : « Trop de gens
    // répondent STOP » ne contient aucun mot-outil de la liste. Un titre de
    // cinq mots peut légitimement passer au travers d'un détecteur sans
    // dictionnaire — c'est le prix de n'avoir pas de dictionnaire, pas un
    // défaut du registre.
    expect(looksFrench("Trop de gens répondent STOP")).toBe(false);
  });

  it("le français reste la source : le registre fr est rendu tel quel", () => {
    for (const doc of DOCS) {
      const fr = findingText(doc, "fr");
      expect(fr.label, doc.id).toBe(doc.labelFr);
      expect(fr.why, doc.id).toBe(doc.whyFr);
      expect(fr.fix, doc.id).toBe(doc.fixFr);
    }
  });
});

// ── Le repli ─────────────────────────────────────────────────────────────────

describe("une traduction manquante retombe sur le français", () => {
  /** Un constat qui n'a délibérément aucune entrée dans le registre anglais. */
  const UNTRANSLATED = "constat_sans_traduction" as unknown as FindingId;

  it("un constat sans surcouche anglaise rend le français, pas du vide", () => {
    // Lire le constat dans l'autre langue reste infiniment plus utile que de
    // lire une carte vide : un titre vide sur un écran de conformité ressemble
    // à un bogue d'affichage, et l'opérateur passe à la ligne suivante.
    const orphan: FindingDoc = { ...FINDING_DOCS.kill_switch_on, id: UNTRANSLATED };
    const text = findingText(orphan, "en");
    expect(FINDING_TEXT_EN[UNTRANSLATED], "le fixture doit vraiment être absent").toBeUndefined();
    expect(text.label).toBe(orphan.labelFr);
    expect(text.why).toBe(orphan.whyFr);
    expect(text.fix).toBe(orphan.fixFr);
    expect(text.label.trim().length).toBeGreaterThan(3);
  });

  it("un CHAMP anglais vide retombe champ par champ", () => {
    // Le cas réel d'une traduction commencée puis abandonnée : le titre est
    // écrit, le geste est resté vide. Rendre un geste vide serait pire que de
    // rendre le geste français — l'opérateur verrait un constat sans action.
    const doc = FINDING_DOCS.kill_switch_on;
    const half = { ...FINDING_TEXT_EN, [doc.id]: { label: "Kill switch is down", why: "", fix: "" } };
    const en = half[doc.id];
    const rendered = {
      label: en.label || doc.labelFr,
      why: en.why || doc.whyFr,
      fix: en.fix || doc.fixFr,
    };
    expect(rendered.label).toBe("Kill switch is down");
    expect(rendered.why).toBe(doc.whyFr);
    // Et le vrai registre, lui, ne contient aucun champ vide de ce genre.
    for (const [id, text] of Object.entries(FINDING_TEXT_EN)) {
      for (const [field, value] of Object.entries(text)) {
        expect(value.trim().length, `${id}.${field} est vide`).toBeGreaterThan(0);
      }
    }
  });
});

// ── Les pièces à conviction ──────────────────────────────────────────────────

describe("`sourceUrl` est une preuve, pas de la prose", () => {
  it("elle ne vit que dans le registre français, donc elle est identique partout", () => {
    // Une référence recopiée dans la surcouche anglaise deviendrait deux
    // adresses différentes à la première mise à jour de la doc Twilio, et
    // personne ne saurait laquelle était la bonne.
    const serializedEn = JSON.stringify(FINDING_TEXT_EN);
    const sourced = DOCS.filter((d) => d.sourceUrl);
    expect(sourced.length, "aucune référence ? le cas ne vérifierait rien").toBeGreaterThan(5);
    for (const doc of sourced) {
      expect(doc.sourceUrl, `${doc.id} — référence non https`).toMatch(/^https:\/\//);
      expect(serializedEn, `${doc.id} — référence recopiée en anglais`).not.toContain(doc.sourceUrl);
    }
    // Plus large : AUCUNE adresse dans la surcouche anglaise, quelle qu'elle
    // soit. Un lien traduit envoie sur un document qui n'existe pas.
    expect(serializedEn, "une adresse s'est glissée dans les mots anglais").not.toMatch(/https?:\/\//);
  });

  it("le rendu d'un constat ne porte JAMAIS la référence dans ses mots", () => {
    // `findingText` rend trois champs, et trois seulement : l'adresse est
    // affichée à part par l'écran, comme une note de bas de page.
    for (const doc of DOCS) {
      for (const locale of ["fr", "en"] as const) {
        expect(Object.keys(findingText(doc, locale)).sort(), `${doc.id} (${locale})`).toEqual([
          "fix",
          "label",
          "why",
        ]);
      }
    }
  });
});

// ── Règle 12 ─────────────────────────────────────────────────────────────────

describe("aucun texte ne parle de consentement", () => {
  it("aucun geste français n'envoie chercher un consentement", () => {
    // Décision de l'exploitant du 2026-08-22 : toute fiche entrée dans ce CRM
    // est réputée joignable. Il n'existe ni porte, ni registre, ni réglage de
    // consentement — seulement STOP / `suppressions` et « ne pas appeler ».
    // Un conseil du type « vérifiez le consentement avant d'envoyer » envoie
    // l'opérateur chercher un écran qui n'existe pas, et le laisse croire
    // qu'une permission lui manque alors que le vrai geste est ailleurs.
    const offenders = DOCS.filter((d) => /consentement/i.test(d.fixFr)).map((d) => d.id);
    expect(offenders, `Gestes qui invoquent un consentement : ${offenders.join(", ")}`).toEqual([]);
  });

  it("ni le libellé, ni le pourquoi, ni l'anglais", () => {
    // La famille s'appelle « consent » — c'est un RANGEMENT (« qui a dit
    // stop ? »), pas une barrière, et elle ne s'affiche jamais telle quelle.
    // Ce sont les mots lus par l'opérateur qui sont interdits.
    const offenders: string[] = [];
    for (const doc of DOCS) {
      for (const [field, value] of Object.entries(findingText(doc, "fr"))) {
        if (/consentement/i.test(value)) offenders.push(`fr ${doc.id}.${field}`);
      }
      for (const [field, value] of Object.entries(findingText(doc, "en"))) {
        if (/\bconsent(ed|ing|s)?\b/i.test(value)) offenders.push(`en ${doc.id}.${field}`);
      }
    }
    expect(offenders, `Textes qui réintroduisent le consentement :\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
