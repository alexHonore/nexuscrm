/**
 * Unitaire — le catalogue des codes d'erreur Twilio.
 *
 * Ce fichier protège trois choses, et une seule est du typage :
 *
 *  1. **Rien ne se perd.** `classifyErrorCode` est appelée sur une colonne
 *     `integer` nullable remplie par un tiers. `null`, `NaN`, un négatif, un
 *     code inventé demain : aucun ne doit lever, et aucun ne doit ressortir
 *     sans nom ni lien. Un code qui disparaît de l'écran est un incident qu'on
 *     ne verra jamais.
 *  2. **Les listes d'indicateurs ne se recouvrent pas.** `assess.ts` somme
 *     `errors[]` par liste (`sumCodes` fait un `codes.includes`) : un code
 *     présent deux fois dans une même liste se compterait deux fois, et un code
 *     présent dans deux listes ferait alarmer deux tuiles sur un seul incident.
 *     Un chiffre gonflé sur un tableau de bord de conformité est pire qu'un
 *     chiffre absent : il déclenche une correction qui n'avait pas lieu d'être.
 *  3. **Aucune tuile sur un code mort.** Le plan a écarté sept codes que Twilio
 *     n'émet plus ou n'émettra jamais ici. Les recataloguer poserait une
 *     surveillance qui affiche un zéro rassurant sans rien surveiller.
 *
 * Et un cas qui ne protège rien du tout — il DOCUMENTE : la contradiction C7,
 * en bas de ce fichier. Elle ne se corrige pas dans le module de calcul.
 */
import { describe, expect, it } from "vitest";
import {
  BLOCKED_CODES,
  ERROR_CLASSES,
  ERROR_FAMILIES,
  FILTERED_CODES,
  HARD_INVALID_CODES,
  KNOWN_ERROR_CODES,
  REGISTRATION_CODES,
  THROUGHPUT_CODES,
  TOTAL_ERROR_CODES,
  UNREACHABLE_CODES,
  classifyErrorCode,
  type ErrorFamily,
} from "@/lib/deliverability/error-classes";
import { HARD_FAILURE_CODES } from "@/lib/sms/status";

/** Les six listes qui nourrissent une tuile, avec le nom de leur indicateur. */
const METRIC_LISTS: readonly (readonly [string, readonly number[]])[] = [
  ["filtered_rate", FILTERED_CODES],
  ["blocked_rate", BLOCKED_CODES],
  ["hard_invalid_rate", HARD_INVALID_CODES],
  ["unreachable_delta", UNREACHABLE_CODES],
  ["registration_blocks", REGISTRATION_CODES],
  ["throughput_blocks", THROUGHPUT_CODES],
];

/**
 * Les codes écartés par le plan, avec la raison de leur mise à l'écart. 30038
 * n'est pas dans la consigne mais l'en-tête du module l'écarte pour le même
 * motif : il est ici pour que la liste du test et celle du module s'accordent.
 */
const DROPPED_CODES: readonly (readonly [number, string])[] = [
  [30026, "déprécié — 30023 le remplace"],
  [30027, "déprécié — 30023 le remplace"],
  [30010, "obsolète"],
  [30044, "comptes d'essai uniquement"],
  [30045, "validation de requête"],
  [63024, "WhatsApp uniquement"],
  [30452, "formulaire de vérification sans frais"],
  [30038, "corps OTP, comptes d'essai"],
];

// ── Le catalogue ────────────────────────────────────────────────────────────

describe("catalogue des codes d'erreur", () => {
  it("chaque code catalogué a une famille, un lien et un nom", () => {
    // Une entrée incomplète ne casse rien au calcul : elle rend une carte vide
    // dans l'écran « erreurs par famille », donc un incident sans étiquette.
    const broken: string[] = [];
    for (const code of KNOWN_ERROR_CODES) {
      const entry = ERROR_CLASSES[code];
      if (entry.code !== code) broken.push(`${code} — la clé et le champ code divergent (${entry.code})`);
      if (!ERROR_FAMILIES.includes(entry.family)) broken.push(`${code} — famille inconnue « ${entry.family} »`);
      if (typeof entry.retryable !== "boolean") broken.push(`${code} — retryable n'est pas un booléen`);
      if (entry.name.trim().length < 3) broken.push(`${code} — sans nom`);
      // Le lien doit mener à LA page du code, pas au dictionnaire : un
      // opérateur qui clique tombe sinon sur mille pages à trier lui-même.
      if (entry.doc !== `https://www.twilio.com/docs/api/errors/${code}`) {
        broken.push(`${code} — lien inattendu « ${entry.doc} »`);
      }
    }
    expect(broken, `Entrées incomplètes :\n  ${broken.join("\n  ")}`).toEqual([]);
  });

  it("« other » reste la sortie de secours, jamais une case du catalogue", () => {
    // `other` veut dire « absent du catalogue ». Cataloguer un code sous cette
    // famille reviendrait à dire « je le connais, mais je ne sais pas ce que
    // c'est » — et l'écran ne pourrait plus distinguer les deux situations.
    const misfiled = KNOWN_ERROR_CODES.filter((c) => ERROR_CLASSES[c].family === "other");
    expect(misfiled, `codes catalogués en « other » : ${misfiled.join(", ")}`).toEqual([]);
  });

  it("aucun nom en double : deux codes ne peuvent pas se lire pareil", () => {
    // Deux lignes « Message blocked » dans le tableau des erreurs, c'est
    // l'opérateur qui croit voir un doublon et en ignore une.
    const seen = new Map<string, number[]>();
    for (const code of KNOWN_ERROR_CODES) {
      const name = ERROR_CLASSES[code].name;
      seen.set(name, [...(seen.get(name) ?? []), code]);
    }
    const collisions = [...seen.entries()]
      .filter(([, codes]) => codes.length > 1)
      .map(([name, codes]) => `${name} → ${codes.join(", ")}`);
    expect(collisions, `Noms partagés :\n  ${collisions.join("\n  ")}`).toEqual([]);
  });

  it("l'inventaire est trié et sans doublon", () => {
    // `KNOWN_ERROR_CODES` sert d'inventaire de lecture ; désordonné, il rend
    // toute comparaison de deux versions du catalogue illisible.
    expect([...KNOWN_ERROR_CODES].sort((a, b) => a - b)).toEqual([...KNOWN_ERROR_CODES]);
    expect(new Set(KNOWN_ERROR_CODES).size).toBe(KNOWN_ERROR_CODES.length);
    expect(KNOWN_ERROR_CODES.length, "un catalogue vide passerait tous les tests").toBeGreaterThan(30);
  });

  it("chaque famille déclarée porte au moins un code, sauf « other »", () => {
    // Une famille sans membre est une colonne vide dans la répartition par
    // famille : elle occupe de la place et n'apprend rien.
    const populated = new Set<ErrorFamily>(KNOWN_ERROR_CODES.map((c) => ERROR_CLASSES[c].family));
    const empty = ERROR_FAMILIES.filter((f) => f !== "other" && !populated.has(f));
    expect(empty, `familles sans aucun code : ${empty.join(", ")}`).toEqual([]);
  });
});

// ── Les listes d'indicateurs ────────────────────────────────────────────────

describe("les listes qui nourrissent les tuiles", () => {
  it("chaque code listé existe dans le catalogue", () => {
    // Le garde que l'en-tête du module réclame nommément : un chiffre tapé de
    // travers ne compterait RIEN, et un compteur à zéro se lit « tout va bien ».
    const orphans: string[] = [];
    for (const [metric, codes] of [...METRIC_LISTS, ["total_error_rate", TOTAL_ERROR_CODES] as const]) {
      for (const code of codes) {
        if (!ERROR_CLASSES[code]) orphans.push(`${metric} → ${code}`);
      }
    }
    expect(orphans, `Codes listés hors catalogue :\n  ${orphans.join("\n  ")}`).toEqual([]);
  });

  it("aucune liste ne contient deux fois le même code", () => {
    // `sumCodes` fait un `codes.includes(e.errorCode)` par rangée d'erreurs :
    // un doublon ne double PAS la somme aujourd'hui, mais il signale une liste
    // recopiée à la main qui a dérivé — et la prochaine réécriture en boucle
    // (`for (const c of codes)`) doublerait bel et bien le compte.
    const dupes: string[] = [];
    for (const [metric, codes] of [...METRIC_LISTS, ["total_error_rate", TOTAL_ERROR_CODES] as const]) {
      if (new Set(codes).size !== codes.length) dupes.push(metric);
    }
    expect(dupes, `Listes avec doublon : ${dupes.join(", ")}`).toEqual([]);
  });

  it("les six listes de tuiles sont deux à deux DISJOINTES", () => {
    // Un même code dans deux listes fait alarmer deux tuiles sur un incident
    // unique : l'opérateur cherche deux causes là où il n'y en a qu'une, et
    // `total_error_rate` — bâti sur l'union — le compterait deux fois le jour
    // où il serait dérivé de ces listes plutôt qu'écrit à la main.
    const overlaps: string[] = [];
    for (let i = 0; i < METRIC_LISTS.length; i += 1) {
      for (let j = i + 1; j < METRIC_LISTS.length; j += 1) {
        const [nameA, a] = METRIC_LISTS[i];
        const [nameB, b] = METRIC_LISTS[j];
        const shared = a.filter((c) => b.includes(c));
        if (shared.length) overlaps.push(`${nameA} ∩ ${nameB} = ${shared.join(", ")}`);
      }
    }
    expect(overlaps, `Recouvrements :\n  ${overlaps.join("\n  ")}`).toEqual([]);
  });

  it("`total_error_rate` compte chaque code UNE fois", () => {
    // Le taux global est la seule liste qui recouvre les autres par
    // construction. Ce qu'on épingle, c'est qu'il n'additionne pas deux
    // occurrences du même code — la définition littérale du double compte.
    expect(new Set(TOTAL_ERROR_CODES).size).toBe(TOTAL_ERROR_CODES.length);
    // Et son contenu exact, parce que déplacer un code ici déplace une barre
    // d'alerte calibrée (0,06 / 0,10) sans que personne ne recalibre.
    //
    // 30004 et 21610 y sont TOUS LES DEUX : ce sont les deux faces d'un même
    // fait — « ce destinataire ne recevra pas ». N'en compter qu'un laissait
    // un numéro dont tout le trafic revenait bloqué afficher un taux d'erreur
    // global sain, sur l'écran qui existe précisément pour l'empêcher.
    // 30002 (« Account suspended ») y est AUSSI, et n'est plus dans
    // `REGISTRATION_CODES` : un compte fermé n'est pas une marque non
    // enregistrée, et l'y ranger faisait proposer un formulaire d'inscription
    // A2P à quelqu'un dont le compte est simplement suspendu.
    expect([...TOTAL_ERROR_CODES].sort((a, b) => a - b)).toEqual([
      21610, 30002, 30003, 30004, 30005, 30006, 30007, 30008,
    ]);
    expect(REGISTRATION_CODES, "30002 n'est pas un défaut d'inscription").not.toContain(30002);
  });

  it("la famille NOMME, la liste COMPTE — et les deux divergent exprès", () => {
    // Les trois écarts documentés en tête du module. Les « corriger » en
    // alignant liste sur famille fabriquerait à chaque fois un taux faux.
    //
    // 30039 : filtrage d'un message ENTRANT. Le mettre dans `filtered_rate`,
    // dont le dénominateur est le sortant, invente un pourcentage.
    expect(ERROR_CLASSES[30039].family).toBe("filtered");
    expect(FILTERED_CODES).not.toContain(30039);
    expect(TOTAL_ERROR_CODES).not.toContain(30039);
    // 30017 : congestion MMS. Ce CRM n'envoie que du SMS — un compteur qui ne
    // bougera jamais est une surveillance qui n'existe pas.
    expect(ERROR_CLASSES[30017].family).toBe("throughput");
    expect(THROUGHPUT_CODES).not.toContain(30017);
    // 21614 : refus à la CRÉATION, jamais un accusé de livraison. Le
    // dénominateur de `hard_invalid_rate` est « ce que Twilio a accepté » : il
    // gonflerait le numérateur sans toucher au dénominateur.
    expect(ERROR_CLASSES[21614].family).toBe("invalid");
    expect(HARD_INVALID_CODES).not.toContain(21614);
  });

  it("les rejets de visa A2P n'entrent dans AUCUN taux de message", () => {
    // La famille `content` vit dans `errors[]` de la ressource Usa2p, jamais
    // sur une rangée `messages` : la compter dans un taux dont le dénominateur
    // est un nombre de messages mélangerait deux univers.
    const contentCodes = KNOWN_ERROR_CODES.filter((c) => ERROR_CLASSES[c].family === "content");
    expect(contentCodes.length, "la famille content a perdu ses membres").toBeGreaterThan(3);
    const leaked: string[] = [];
    for (const [metric, codes] of [...METRIC_LISTS, ["total_error_rate", TOTAL_ERROR_CODES] as const]) {
      for (const code of contentCodes) if (codes.includes(code)) leaked.push(`${metric} → ${code}`);
    }
    expect(leaked, `Codes de visa A2P dans un taux de message :\n  ${leaked.join("\n  ")}`).toEqual([]);
  });
});

// ── Les codes écartés ───────────────────────────────────────────────────────

describe("les codes que le plan a écartés", () => {
  it("aucun ne revient dans le catalogue", () => {
    // Une tuile posée sur un code qui ne peut jamais se déclencher affiche un
    // zéro rassurant sur une surveillance qui n'existe pas — pire que pas de
    // tuile du tout, parce qu'elle se lit comme une preuve.
    const resurrected = DROPPED_CODES.filter(([code]) => Boolean(ERROR_CLASSES[code])).map(
      ([code, why]) => `${code} (${why})`,
    );
    expect(resurrected, `Codes morts recatalogués :\n  ${resurrected.join("\n  ")}`).toEqual([]);
  });

  it("aucun ne se glisse dans une liste d'indicateur", () => {
    const leaked: string[] = [];
    for (const [metric, codes] of [...METRIC_LISTS, ["total_error_rate", TOTAL_ERROR_CODES] as const]) {
      for (const [code, why] of DROPPED_CODES) {
        if (codes.includes(code)) leaked.push(`${metric} → ${code} (${why})`);
      }
    }
    expect(leaked, `Codes morts comptés :\n  ${leaked.join("\n  ")}`).toEqual([]);
  });

  it("écarté du catalogue ne veut pas dire invisible à l'écran", () => {
    // Un code écarté qui APPARAÎTRAIT quand même doit rester nommé et
    // cliquable : c'est la différence entre « on ne surveille pas ça » et « on
    // le jette ». `classifyErrorCode` ne renvoie donc jamais rien de vide.
    for (const [code] of DROPPED_CODES) {
      const seen = classifyErrorCode(code);
      expect(seen.family, `${code}`).toBe("other");
      expect(seen.name, `${code}`).toBe(`Twilio ${code}`);
      expect(seen.doc, `${code}`).toBe(`https://www.twilio.com/docs/api/errors/${code}`);
    }
  });
});

// ── classifyErrorCode ───────────────────────────────────────────────────────

describe("classifyErrorCode ne lève jamais", () => {
  it("rend le catalogue tel quel pour un code connu", () => {
    expect(classifyErrorCode(30007)).toBe(ERROR_CLASSES[30007]);
    expect(classifyErrorCode(30007).family).toBe("filtered");
    expect(classifyErrorCode(21610).family).toBe("blocked");
  });

  it("une entrée absente ou aberrante retombe sur le dictionnaire, sans planter", () => {
    // La colonne `messages.error_code` est un `integer` NULLABLE écrit par un
    // tiers, et la réconciliation REST y verse ce que l'API renvoie. Chacune
    // de ces valeurs a un chemin réel jusqu'ici ; une exception ferait tomber
    // toute la page de délivrabilité sur une seule rangée bizarre.
    const garbage: readonly (number | null | undefined)[] = [
      null,
      undefined,
      Number.NaN,
      -1,
      -30007,
      0,
      1.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const value of garbage) {
      const label = String(value);
      const seen = classifyErrorCode(value);
      expect(seen.family, label).toBe("other");
      expect(seen.code, label).toBe(0);
      expect(seen.retryable, label).toBe(false);
      // Pas de page de code à pointer : on renvoie l'index du dictionnaire
      // plutôt qu'une URL fabriquée qui rendrait un 404.
      expect(seen.doc, label).toBe("https://www.twilio.com/docs/api/errors");
      expect(seen.name.trim().length, label).toBeGreaterThan(0);
    }
  });

  it("un code inconnu reste nommé, classé « other » et cliquable", () => {
    // Twilio ajoute des codes ; le catalogue est daté du 2026-08-27. Un code
    // né demain doit s'afficher avec son numéro et son lien, pas disparaître
    // de la répartition — sinon les colonnes ne totalisent plus les rangées.
    const seen = classifyErrorCode(30999);
    expect(seen.family).toBe("other");
    expect(seen.code).toBe(30999);
    expect(seen.name).toBe("Twilio 30999");
    expect(seen.doc).toBe("https://www.twilio.com/docs/api/errors/30999");
    expect(seen.retryable, "on ne devine pas qu'un code inconnu se réessaie").toBe(false);
  });

  it("aucun code catalogué ne ressort en « other »", () => {
    const lost = KNOWN_ERROR_CODES.filter((c) => classifyErrorCode(c).family === "other");
    expect(lost, `codes catalogués perdus au classement : ${lost.join(", ")}`).toEqual([]);
  });
});

// ── C7 ──────────────────────────────────────────────────────────────────────

describe("contradiction C7 — 30003, le téléphone éteint qu'on ne rappelle jamais", () => {
  it("le moteur d'envoi supprime définitivement ce que ce module dit transitoire", () => {
    // Ce cas ne protège pas un comportement : il fige une DIVERGENCE, pour
    // qu'elle ne se referme pas en silence du mauvais côté.
    //
    // Twilio documente 30003 comme transitoire — combiné éteint, hors
    // couverture. Le catalogue le suit : `retryable: true`, et l'indicateur
    // bâti dessus (`unreachable_delta`) mesure une DÉRIVE, pas un niveau.
    //
    // `src/lib/sms/status.ts` ne suit pas : 30003 est dans
    // `HARD_FAILURE_CODES`, donc `recordDeliveryOutcome` insère une rangée
    // `suppressions` DÉFINITIVE sur le numéro dès le premier accusé négatif.
    // Conséquence : un client dont le téléphone était éteint UNE fois ne sera
    // plus jamais texté par ce CRM — personne ne l'a décidé, et l'interface
    // n'offre aucun chemin de retour.
    expect(
      HARD_FAILURE_CODES.has(30003),
      "le moteur a cessé de bannir 30003 — si c'est voulu, retirer `harsh_suppression_30003`",
    ).toBe(true);
    expect(
      classifyErrorCode(30003).retryable,
      "le catalogue s'est aligné sur le moteur : la seule trace du problème vient de disparaître",
    ).toBe(true);
    expect(classifyErrorCode(30003).family).toBe("unreachable");
    expect(UNREACHABLE_CODES).toEqual([30003]);
  });

  it("les deux autres codes bannis par le moteur, eux, sont bien définitifs", () => {
    // 30005 (numéro inconnu) et 30006 (ligne fixe) : la suppression définitive
    // est légitime, et le catalogue est d'accord. C'est ce qui isole 30003
    // comme le seul cas litigieux, plutôt qu'un désaccord général.
    for (const code of [30005, 30006]) {
      expect(HARD_FAILURE_CODES.has(code), `${code}`).toBe(true);
      expect(classifyErrorCode(code).retryable, `${code}`).toBe(false);
      expect(classifyErrorCode(code).family, `${code}`).toBe("invalid");
    }
    // Et rien d'autre n'a été ajouté au bannissement sans passer par ici.
    expect([...HARD_FAILURE_CODES].sort((a, b) => a - b)).toEqual([30003, 30005, 30006]);
  });
});
