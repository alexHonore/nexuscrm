/**
 * Unitaire — le repli des gabarits, et le seul chiffre de l'onglet qui alarme.
 *
 * Ce que ce fichier protège : `distinctSendingNumbers`. Tout l'onglet
 * « Délivrabilité » repose sur lui — « le MÊME gabarit porté par plusieurs
 * numéros expéditeurs » est la définition de l'essaimage (CTIA §5.5.2), et ce
 * chiffre n'existe que si le repli a d'abord su reconnaître que cinq mille
 * corps différents par le prénom, le numéro civique et le prix sont UN gabarit.
 * Un repli qui rate ce regroupement affiche cinq mille grappes à un expéditeur
 * chacune : l'essaimage devient invisible. Un repli qui sur-regroupe FABRIQUE
 * l'alerte inverse sur deux textes sans rapport — et une alerte inventée sur un
 * écran de conformité coûte la confiance de toute la page.
 *
 * Les cas de sensibilité sont écrits sur la sensibilité MESURÉE de ce
 * SimHash-là, pas sur la promesse. Chaque distance ci-dessous a été relevée sur
 * les chaînes exactes du fichier ; elles sont rappelées en commentaire pour que
 * la prochaine personne sache ce qui a bougé quand un cas tombe. Aucune
 * assertion ne pose une distance comme contrat d'API : on épingle le RÉSULTAT
 * (fusionné / pas fusionné), qui doit survivre à un réglage qui garde le
 * comportement.
 *
 * Module PUR : ni base, ni horloge, ni réseau — d'où l'absence de tout montage.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_BUCKET,
  MAX_SCAN_ROWS,
  SIMHASH_MAX_DISTANCE,
  foldTemplates,
  hamming,
  normalizeTemplate,
  simhash64,
  type CoarseGroup,
} from "@/lib/deliverability/dedupe";
import type { TemplateCluster } from "@/lib/deliverability/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FOOTER = "Répondez STOP pour vous désabonner.";
const SENDERS = ["+14185550111", "+14185550112", "+14185550113"];

/** Un groupe grossier tel que Postgres le rend, valeurs par défaut inoffensives. */
function group(body: string, over: Partial<CoarseGroup> = {}): CoarseGroup {
  return {
    coarseKey: body.slice(0, 12),
    body,
    messages: 1,
    distinctRecipients: 1,
    senders: [SENDERS[0]],
    firstName: null,
    ...over,
  };
}

/** La distance entre deux corps, vue comme `foldTemplates` la voit. */
function distance(a: string, b: string, firstName: string | null = null): number {
  return hamming(
    simhash64(normalizeTemplate(a, firstName)),
    simhash64(normalizeTemplate(b, firstName)),
  );
}

const totalMessages = (clusters: TemplateCluster[]): number =>
  clusters.reduce((sum, cluster) => sum + cluster.messages, 0);

/**
 * L'invariant de lecture de l'écran : l'atteinte se lit
 * `distinctRecipients / messages`. Au-dessus de 100 %, l'opérateur cesse de
 * croire TOUS les autres chiffres de la page, pas seulement celui-là.
 */
function unreadableReach(clusters: TemplateCluster[], label: string): string[] {
  return clusters
    .filter((c) => c.distinctRecipients > c.messages)
    .map((c) => `${label} : ${c.distinctRecipients} destinataires pour ${c.messages} messages`);
}

/**
 * Le corpus du courtier : cinq mille envois d'UN gabarit, qui ne diffèrent que
 * par le prénom (fusionné par jointure), le numéro civique, le prix, et le pied
 * de page réglementaire — constant, donc sans valeur distinctive.
 */
const NAMES = ["Marie", "Jean", "Sophie", "Luc", "Amélie", "Zoé", "Benoît", "Chloé", "Émile", "Nadia"];
const BULK: CoarseGroup[] = Array.from({ length: 5000 }, (_unused, i) => {
  const name = NAMES[i % NAMES.length];
  return group(
    `Bonjour ${name}, le ${4000 + i} rue des Ormes vient de se libérer à ${300 + (i % 400)} 000 $. ` +
      `Voulez-vous la visiter cette semaine ? ${FOOTER}`,
    { coarseKey: `k${i}`, firstName: name, senders: [SENDERS[i % SENDERS.length]] },
  );
});

/**
 * Le même remaniement — UN mot — sur deux longueurs. Distances relevées :
 * 1 bit sur le corps long (364 caractères de gabarit), 7 bits sur le court
 * (109). C'est la sensibilité réelle décrite dans le module : un même
 * remaniement pèse d'autant plus lourd que le corps est court.
 */
const CLAUSE = "cette propriété correspond exactement à ce que vous cherchiez";
const SHORT_BODY = `Bonjour Marie, ${CLAUSE}. Voulez-vous la visiter cette semaine ?`;
const LONG_BODY =
  `Bonjour Marie, ici Alex-Honoré, courtier immobilier à Lévis depuis douze ans. ` +
  `Une inscription vient de paraître sur la rue des Ormes et ${CLAUSE} au printemps dernier. ` +
  `Je peux vous transmettre la fiche complète et les ventes comparables du secteur, sans aucun engagement de votre part. ` +
  `Voulez-vous la visiter cette semaine ?`;
const oneWordSwap = (body: string): string => body.replace("exactement", "parfaitement");
/** Une clause entière réécrite sur le MÊME corps long : 15 bits. */
const LONG_BODY_REWRITTEN = LONG_BODY.replace(
  "Voulez-vous la visiter cette semaine ?",
  "Dites-moi simplement si un déménagement est encore dans vos plans cette année.",
);

/** Trois textes que rien ne rapproche : 29 à 34 bits deux à deux. */
const UNRELATED = [
  "Votre évaluation gratuite est prête, je vous la transmets aujourd'hui.",
  "Un duplex vient d'être inscrit sur la rue Saint-Georges à Lévis.",
  "Merci, le notaire confirmera la date de signature sous peu.",
];

// ── La normalisation ────────────────────────────────────────────────────────

describe("normalizeTemplate — ce qui ne distingue rien est effacé", () => {
  it("prénom, civique, prix, heure, date, lien et accents donnent le MÊME gabarit", () => {
    // C'est le premier repli, celui qui fait le gros du travail : deux instances
    // du même barreau de campagne doivent se réduire à une seule chaîne, sinon
    // le second repli reçoit cinquante mille chaînes au lieu de quelques
    // centaines et la page ne tient plus dans une requête.
    const a = normalizeTemplate(
      "Bonjour Marie, c'est prêt à 14 h chez nous : voir exemple.ca/a1b2 — 450 000 $.",
      "Marie",
    );
    const b = normalizeTemplate(
      "Bonjour Jean, c’est pret a 9h chez nous : voir exemple.ca/z9 — 375 000 $.",
      "Jean",
    );
    expect(a, "deux instances d'un même gabarit doivent donner UNE chaîne").toBe(b);
    expect(a).toBe("bonjour ~p~ cest pret a ~h~ chez nous voir ~u~ ~m~");
  });

  it("un prénom de moins de trois lettres n'est PAS remplacé", () => {
    // Le garde existe pour « Ed » : sans lui, « médecine » deviendrait
    // « m~p~ecine » et le gabarit se disperserait au lieu de se rassembler —
    // exactement l'inverse du but.
    expect(normalizeTemplate("Ed est là. Une médecine douce.", "Ed")).toBe(
      "ed est la une medecine douce",
    );
    expect(normalizeTemplate("Bonjour a, ça va ?", "a")).toBe("bonjour a ca va");
  });

  it("un prénom rempli de métacaractères est traité comme du TEXTE", () => {
    // Une fiche mal saisie (« a.*b » dans le champ prénom) ne doit pas devenir
    // un joker qui avale la moitié du message : la normalisation dépendrait
    // alors du destinataire, et deux instances du même gabarit ne se
    // replieraient plus ensemble.
    expect(normalizeTemplate("Bonjour a.*b, ça va ?", "a.*b")).toBe("bonjour ~p~ ca va");
    expect(normalizeTemplate("Bonjour Marie, ça va ?", "a.*b")).toBe("bonjour marie ca va");
  });

  it("les émojis disparaissent sans laisser de trou", () => {
    expect(normalizeTemplate("Bonjour 🏡 Marie ✅, ça va ?", "Marie")).toBe("bonjour ~p~ ca va");
  });
});

describe("normalizeTemplate — le pied de page de conformité", () => {
  /** Sept façons d'écrire la même obligation. Toutes doivent s'effacer. */
  const VARIANTS = [
    "Répondez STOP pour vous désabonner.",
    "Répondez STOP.",
    "Texto STOP pour arrêter",
    "Reply STOP to unsubscribe.",
    "STOP au 1-800-555-0199 pour vous désabonner",
    "Envoyez STOP pour ne plus rien recevoir.",
    "Désabonnement : répondez STOP",
  ];
  const BODY = "Bonjour, une occasion à Lévis.";

  it("le pied de page vaut ZÉRO dans le gabarit, quelle que soit sa formulation", () => {
    // L'assertion qui prouve que l'étape 9 est encore branchée : le gabarit d'un
    // corps AVEC pied de page est le gabarit du corps SANS, au caractère près.
    // Débranchée, cette égalité tombe immédiatement.
    const bare = normalizeTemplate(BODY);
    const kept = VARIANTS.filter((v) => normalizeTemplate(`${BODY} ${v}`) !== bare);
    expect(kept, `pieds de page laissés dans le gabarit :\n  ${kept.join("\n  ")}`).toEqual([]);
    expect(bare).toBe("bonjour une occasion a levis");
  });

  it("sept formulations du pied de page font UNE grappe, pas sept", () => {
    // Le bénéfice direct du retrait sur le repli exact : le même barreau, dont
    // le pied de page a été retouché trois fois en un an, reste un gabarit.
    const clusters = foldTemplates(VARIANTS.map((v, i) => group(`${BODY} ${v}`, { coarseKey: `v${i}` })));
    expect(clusters.length, "un pied de page retouché ne crée pas de gabarit").toBe(1);
    expect(clusters[0].messages).toBe(VARIANTS.length);
  });

  it("deux textes sans rapport qui partagent le pied de page restent SÉPARÉS", () => {
    // Le danger inverse, et le plus coûteux : « Répondez STOP pour vous
    // désabonner » est identique sur tous les envois. Laissé en place, il donne
    // à deux textes étrangers une base commune et remonte le plancher de
    // similarité — l'écran annoncerait un essaimage là où il n'y a qu'une
    // mention réglementaire.
    const [a, b] = UNRELATED;
    const clusters = foldTemplates([
      group(`${a} ${FOOTER}`, { coarseKey: "a" }),
      group(`${b} ${FOOTER}`, { coarseKey: "b" }),
    ]);
    expect(clusters.length, "un pied de page commun ne rapproche personne").toBe(2);
    // Et il ne les rapproche PAS D'UN BIT : la distance avec pied de page est
    // exactement celle sans.
    expect(distance(`${a} ${FOOTER}`, `${b} ${FOOTER}`)).toBe(distance(a, b));
  });

  it("le plancher de similarité que le retrait supprime est MESURABLE", () => {
    // Le contrefactuel, simulé en recollant le pied de page normalisé : les deux
    // textes étrangers se rapprochent de plusieurs bits (33 → 26 au relevé).
    // Ce n'est pas assez, à cette longueur de pied de page, pour franchir les
    // trois bits tout seul — la vraie perte serait sur le repli exact, cas
    // au-dessus. Ce que ce cas épingle, c'est le SENS de l'effet : le pied de
    // page ne peut que rapprocher, donc il ne doit jamais être compté.
    const [a, b] = UNRELATED;
    const NORMALIZED_FOOTER = "repondez stop pour vous desabonner";
    const unstripped = hamming(
      simhash64(`${normalizeTemplate(a)} ${NORMALIZED_FOOTER}`),
      simhash64(`${normalizeTemplate(b)} ${NORMALIZED_FOOTER}`),
    );
    expect(unstripped, "sans le retrait, le pied de page remonte la similarité").toBeLessThan(
      distance(a, b),
    );
  });

  it("un « stop » isolé au milieu d'une phrase reste du texte", () => {
    // Le mot-clé seul n'est pas un pied de page : l'effacer amputerait des
    // phrases ordinaires et ferait fusionner des gabarits distincts.
    expect(normalizeTemplate("Il faut un stop complet avant le virage.")).toBe(
      "il faut un stop complet avant le virage",
    );
  });
});

// ── Le repli ────────────────────────────────────────────────────────────────

describe("foldTemplates — cinq mille corps, un gabarit", () => {
  const clusters = foldTemplates(BULK);

  it("les 5 000 envois se replient en EXACTEMENT une grappe", () => {
    expect(
      clusters.length,
      `5 000 corps du même barreau ont donné ${clusters.length} grappes`,
    ).toBe(1);
    expect(clusters[0].messages, "aucun message ne se perd en route").toBe(5000);
    expect(totalMessages(clusters)).toBe(BULK.reduce((sum, g) => sum + g.messages, 0));
  });

  it("`distinctSendingNumbers` compte les expéditeurs À TRAVERS les groupes fusionnés", () => {
    // LE chiffre de l'onglet. Les cinq mille corps sont partis de trois numéros
    // et arrivent en trois mille rangées distinctes côté Postgres : si le compte
    // se faisait par groupe grossier au lieu de par grappe, chaque ligne dirait
    // « 1 expéditeur » et l'essaimage serait rigoureusement invisible.
    expect(clusters[0].distinctSendingNumbers, "trois numéros pour un gabarit = essaimage").toBe(3);
  });

  it("l'atteinte reste lisible : jamais plus de destinataires que de messages", () => {
    expect(unreadableReach(clusters, "5 000")).toEqual([]);
    expect(clusters[0].distinctRecipients).toBe(5000);
  });

  it("le même corpus dans un autre ORDRE rend les mêmes grappes et les mêmes représentants", () => {
    // Postgres ne promet pas d'ordre sans `order by`. Si l'ordre décidait du
    // représentant, l'extrait affiché changerait d'un chargement à l'autre et
    // personne ne pourrait citer la page dans un dossier d'inscription 10DLC.
    let seed = 42;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const shuffled = [...BULK];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    expect(shuffled.map((g) => g.coarseKey), "le mélange doit vraiment mélanger").not.toEqual(
      BULK.map((g) => g.coarseKey),
    );
    expect(foldTemplates(shuffled)).toEqual(clusters);
  });
});

describe("foldTemplates — ce qui ne doit JAMAIS fusionner", () => {
  it("trois textes sans rapport restent trois grappes", () => {
    const clusters = foldTemplates(UNRELATED.map((body, i) => group(body, { coarseKey: `u${i}` })));
    expect(clusters.length, "sur-fusionner FABRIQUE une alerte d'essaimage").toBe(3);
    // Et de très loin : la marge est d'un ordre de grandeur au-dessus du seuil.
    for (const [a, b] of [
      [UNRELATED[0], UNRELATED[1]],
      [UNRELATED[0], UNRELATED[2]],
      [UNRELATED[1], UNRELATED[2]],
    ]) {
      expect(distance(a, b), `${a} / ${b}`).toBeGreaterThan(SIMHASH_MAX_DISTANCE * 3);
    }
  });

  it("une clause entière réécrite ne fusionne pas, même sur un corps long", () => {
    // Le second repli n'est PAS un détecteur de paraphrase, et il ne doit pas
    // être présenté comme tel : 15 bits au relevé, cinq fois le seuil.
    expect(
      foldTemplates([group(LONG_BODY, { coarseKey: "l" }), group(LONG_BODY_REWRITTEN, { coarseKey: "r" })]).length,
      "une phrase réécrite reste un autre gabarit",
    ).toBe(2);
    expect(distance(LONG_BODY, LONG_BODY_REWRITTEN)).toBeGreaterThan(SIMHASH_MAX_DISTANCE);
  });
});

describe("foldTemplates — la sensibilité RÉELLE du second repli", () => {
  it("UN mot changé dans un corps long fusionne", () => {
    // Relevé sur ces chaînes exactes : 1 bit sur 364 caractères de gabarit.
    // C'est la dérive typique d'un assistant qui improvise autour d'un barreau,
    // et c'est tout ce que le second repli prétend rattraper.
    const clusters = foldTemplates([
      group(LONG_BODY, { coarseKey: "long", senders: [SENDERS[0]] }),
      group(oneWordSwap(LONG_BODY), { coarseKey: "long2", senders: [SENDERS[1]] }),
    ]);
    expect(clusters.length, "la dérive fine d'un long gabarit doit se rattraper").toBe(1);
    // Et c'est bien le second repli qui vient de rendre l'essaimage visible :
    // sans lui, deux grappes à un expéditeur chacune.
    expect(clusters[0].distinctSendingNumbers, "les expéditeurs se cumulent aussi au second repli").toBe(2);
    expect(distance(LONG_BODY, oneWordSwap(LONG_BODY))).toBeLessThanOrEqual(SIMHASH_MAX_DISTANCE);
  });

  it("LE MÊME mot changé dans un corps court ne fusionne PAS", () => {
    // 7 bits au relevé, sur 109 caractères de gabarit. Ce n'est pas une
    // incohérence : un même remaniement pèse deux fois plus lourd sur un corps
    // deux fois plus court. Le sous-repli est le sens voulu du déséquilibre —
    // deux grappes là où un œil en verrait une, plutôt qu'une alerte inventée.
    expect(
      foldTemplates([
        group(SHORT_BODY, { coarseKey: "court" }),
        group(oneWordSwap(SHORT_BODY), { coarseKey: "court2" }),
      ]).length,
      "un corps court ne pardonne pas le même remaniement",
    ).toBe(2);
    expect(distance(SHORT_BODY, oneWordSwap(SHORT_BODY))).toBeGreaterThan(SIMHASH_MAX_DISTANCE);
  });
});

describe("foldTemplates — les chiffres rendus à l'écran", () => {
  it("le représentant est le corps le PLUS ENVOYÉ, pas le premier ni le premier alphabétique", () => {
    // L'opérateur doit lire ce que les gens ont réellement reçu. Un représentant
    // pris au hasard donne l'impression d'un extrait tronqué, et un représentant
    // qui change d'un chargement à l'autre rend la page incitable.
    const clusters = foldTemplates([
      // Premier du tableau ET premier alphabétiquement — mais 1 message.
      group(`Bonjour Amélie, le 4801 rue des Ormes se libère à 410 000 $. ${FOOTER}`, {
        coarseKey: "a",
        firstName: "Amélie",
        messages: 1,
      }),
      group(`Bonjour Benoît, le 4802 rue des Ormes se libère à 420 000 $. ${FOOTER}`, {
        coarseKey: "b",
        firstName: "Benoît",
        messages: 1,
      }),
      // Le mode : 900 envois.
      group(`Bonjour Zoé, le 4803 rue des Ormes se libère à 430 000 $. ${FOOTER}`, {
        coarseKey: "z",
        firstName: "Zoé",
        messages: 900,
      }),
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].representativeBody, "le représentant doit être le corps le plus envoyé").toContain(
      "Bonjour Zoé",
    );
    expect(clusters[0].messages).toBe(902);
  });

  it("à égalité de messages, le représentant est tranché par la chaîne, pas par l'ordre", () => {
    const bodies = [
      `Bonjour Zoé, la maison de la rue des Ormes se libère. ${FOOTER}`,
      `Bonjour Amélie, la maison de la rue des Ormes se libère. ${FOOTER}`,
    ];
    const names = ["Zoé", "Amélie"];
    const forward = foldTemplates(bodies.map((b, i) => group(b, { coarseKey: `f${i}`, firstName: names[i] })));
    const backward = foldTemplates(
      [...bodies].reverse().map((b, i) => group(b, { coarseKey: `r${i}`, firstName: [...names].reverse()[i] })),
    );
    expect(forward[0].representativeBody).toBe(backward[0].representativeBody);
    expect(forward[0].representativeBody).toContain("Bonjour Amélie");
  });

  it("une rangée aberrante ne fait jamais afficher une atteinte au-dessus de 100 %", () => {
    // Les destinataires arrivent déjà comptés par groupe, et leur somme peut
    // surcompter quand une même personne apparaît dans deux groupes fusionnés.
    // Ici on force le cas extrême — neuf destinataires pour quatre messages :
    // un taux d'atteinte de 225 % sur un écran de conformité ferait douter de
    // TOUS les autres chiffres de la page.
    const clusters = foldTemplates([
      group("Bonjour, votre visite est confirmée.", { coarseKey: "x", messages: 4, distinctRecipients: 9 }),
    ]);
    expect(unreadableReach(clusters, "aberrante")).toEqual([]);
    expect(clusters[0].distinctRecipients).toBe(4);
  });

  it("les grappes sortent triées : le plus envoyé d'abord", () => {
    const clusters = foldTemplates([
      group(UNRELATED[0], { coarseKey: "a", messages: 10 }),
      group(UNRELATED[1], { coarseKey: "b", messages: 400 }),
      group(UNRELATED[2], { coarseKey: "c", messages: 90 }),
    ]);
    expect(clusters.map((c) => c.messages)).toEqual([400, 90, 10]);
  });

  it("un même numéro présent dans deux groupes ne se compte qu'une fois", () => {
    const clusters = foldTemplates([
      group(`Bonjour Marie, la visite est confirmée. ${FOOTER}`, {
        coarseKey: "s1",
        firstName: "Marie",
        senders: [SENDERS[0], SENDERS[1]],
      }),
      group(`Bonjour Sophie, la visite est confirmée. ${FOOTER}`, {
        coarseKey: "s2",
        firstName: "Sophie",
        senders: [SENDERS[1]],
      }),
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].distinctSendingNumbers, "deux numéros distincts, pas trois").toBe(2);
  });
});

// ── Robustesse ──────────────────────────────────────────────────────────────

describe("foldTemplates — entrées hostiles", () => {
  it("un corpus vide rend un tableau vide", () => {
    expect(foldTemplates([])).toEqual([]);
  });

  it("corps vide, métacaractères, demi-substitut, prénom nul : rien ne casse", () => {
    // Aucune de ces fiches n'est théorique : un corps vide sort d'un envoi
    // avorté, « a.*b » d'un import mal mappé, le demi-substitut d'un émoji
    // tronqué collé dans un champ « nom ». Une exception ici ferait tomber
    // TOUT l'onglet de conformité pour une seule fiche mal saisie.
    const hostile: CoarseGroup[] = [
      group("", { coarseKey: "vide", firstName: "Marie" }),
      group("Bonjour a.*b, ça va ?", { coarseKey: "meta", firstName: "a.*b" }),
      group("Bonjour \uD83Dxyz, ça va ?", { coarseKey: "surrogate", firstName: "\uD83Dxyz" }),
      group("Bonjour Marie, ça va ?", { coarseKey: "nul", firstName: null }),
      group("Bonjour Marie, ça va ?", { coarseKey: "absent" }),
      group("Ed est là. Une médecine douce.", { coarseKey: "ed", firstName: "Ed" }),
      group("a", { coarseKey: "1car", firstName: "a" }),
      group("~p~ ~u~ ~m~", { coarseKey: "sentinelles", firstName: "Marie" }),
    ];
    let clusters: TemplateCluster[] = [];
    expect(() => {
      clusters = foldTemplates(hostile);
    }, "une fiche mal saisie ne doit pas faire tomber l'onglet").not.toThrow();
    expect(totalMessages(clusters), "aucun message perdu").toBe(hostile.length);
    expect(unreadableReach(clusters, "hostile")).toEqual([]);
    for (const cluster of clusters) {
      expect(typeof cluster.representativeBody, "un représentant reste une chaîne").toBe("string");
      expect(cluster.distinctSendingNumbers).toBeGreaterThanOrEqual(1);
    }
  });

  it("un corps plus court qu'un gramme garde une empreinte à lui", () => {
    // Sans le hachage entier des corps minuscules, tous sortiraient avec
    // l'empreinte nulle et se retrouveraient dans UNE grappe — la page
    // annoncerait un gabarit géant fait de « oui », « non » et « ok ».
    expect(simhash64("")).toEqual([0, 0]);
    expect(simhash64("oui")).not.toEqual(simhash64("non"));
    expect(simhash64("oui")).not.toEqual([0, 0]);
    const clusters = foldTemplates([
      group("Oui", { coarseKey: "oui" }),
      group("Non", { coarseKey: "non" }),
      group("Ok", { coarseKey: "ok" }),
    ]);
    expect(clusters.length, "trois corps minuscules ne sont pas un gabarit").toBe(3);
  });
});

describe("foldTemplates — bornes de coût", () => {
  it("trois mille gabarits quasi identiques se replient sans faire tourner la page", () => {
    // Le seau dégénéré : tous ces corps partagent seize bits d'empreinte et
    // atterrissent dans le même seau, où la comparaison deux à deux devient
    // quadratique. `MAX_BUCKET` fait SAUTER le seau — quelques fusions
    // approchées ratées valent mieux qu'une page qui tourne une minute.
    const LETTERS = "abcdefghijklmnopqrstuvwxyz";
    const degenerate: CoarseGroup[] = Array.from({ length: 3000 }, (_unused, i) => {
      const code =
        LETTERS[i % 26] + LETTERS[Math.floor(i / 26) % 26] + LETTERS[Math.floor(i / 676) % 26];
      return group(
        `Bonjour Marie, votre dossier ${code} avance bien et le notaire confirmera la date sous peu. ` +
          `Merci de votre patience. ${FOOTER}`,
        { coarseKey: `d${i}`, firstName: "Marie" },
      );
    });
    const started = Date.now();
    const clusters = foldTemplates(degenerate);
    const elapsed = Date.now() - started;
    // Le résultat d'abord : rien ne se perd, même quand un seau est sauté.
    expect(totalMessages(clusters), "un seau sauté ne fait pas disparaître de messages").toBe(3000);
    expect(clusters.length).toBeGreaterThan(0);
    expect(unreadableReach(clusters, "dégénéré")).toEqual([]);
    // Et l'ordre de grandeur : mesuré à ~50 ms, la borne est large exprès pour
    // ne pas transformer ce cas en test de vitesse de machine. Elle attrape le
    // seul vrai risque : le retour du parcours quadratique complet.
    expect(elapsed, `repli dégénéré en ${elapsed} ms`).toBeLessThan(5000);
  });

  it("les bornes déclarées gardent leur sens", () => {
    // `SIMHASH_MAX_DISTANCE` est solidaire du blocage en quatre bandes de
    // 16 bits : au-delà de 3, le principe des tiroirs ne garantit plus qu'une
    // bande reste identique et le blocage se met à rater des paires proches
    // sans que rien ne le dise.
    expect(SIMHASH_MAX_DISTANCE, "monter à 4 casse l'exactitude du blocage").toBeLessThanOrEqual(3);
    expect(MAX_BUCKET).toBeGreaterThan(0);
    expect(MAX_SCAN_ROWS, "le plafond de balayage s'applique en SQL, pas ici").toBeGreaterThan(
      MAX_BUCKET,
    );
  });
});

/**
 * Régression — le pied de page FRANÇAIS est retiré comme l'anglais.
 *
 * « ARRÊT » est le mot-clé d'arrêt en français, et `normalizeOptOutInput`
 * l'accepte depuis toujours. Tant que le pliage de gabarit ne connaissait que
 * « STOP », le pied de page français restait dans le texte normalisé : une
 * constante identique collée à la fin de messages SANS RAPPORT, assez lourde
 * pour les rapprocher et les fondre en une seule grappe. Résultat, une alerte
 * d'essaimage fabriquée sur un trafic irréprochable — le pire défaut possible
 * pour cet écran, puisqu'il use la confiance qu'on lui accorde.
 */
describe("pied de page de conformité — français", () => {
  const FR_FOOTER = " Répondez ARRÊT pour vous désabonner.";

  it("deux textes sans rapport ne fusionnent PAS à cause du pied de page", () => {
    const a = "Bonjour, avez-vous encore un projet immobilier a Levis cette annee ?" + FR_FOOTER;
    const b = "Votre rendez-vous de mardi est confirme, je vous appelle avant midi." + FR_FOOTER;
    const clusters = foldTemplates([
      { coarseKey: "a", body: a, messages: 40, distinctRecipients: 40, senders: ["n1"] },
      { coarseKey: "b", body: b, messages: 40, distinctRecipients: 40, senders: ["n1"] },
    ]);
    expect(clusters, "le pied de page français doit être retiré avant l'empreinte").toHaveLength(2);
  });

  it("le pied de page disparaît du gabarit, en ARRÊT comme en STOP", () => {
    const base = "Bonjour, avez-vous encore un projet immobilier a Levis cette annee ?";
    const fr = normalizeTemplate(base + FR_FOOTER);
    const en = normalizeTemplate(base + " Répondez STOP pour vous désabonner.");
    expect(fr).toBe(normalizeTemplate(base));
    expect(en).toBe(normalizeTemplate(base));
  });
});
