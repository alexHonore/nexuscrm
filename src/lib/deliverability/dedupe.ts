/**
 * Repli des gabarits — le même texte parti combien de fois, et surtout DEPUIS
 * COMBIEN DE NUMÉROS.
 *
 * Module PUR (règle du dossier) : aucun `next-intl`, aucun accès base, aucune
 * lecture d'horloge ni d'environnement, aucun réseau. Postgres a déjà fait un
 * regroupement grossier ; on reçoit des groupes agrégés et on rend des grappes.
 * `tests/unit-deliverability-purity.test.ts` fait échouer le build si un
 * interdit entre ici.
 *
 * DEUX replis, jamais un seul :
 *
 *  1. **Hachage exact du GABARIT.** Les corps sortants d'ici ont trois
 *     origines : un barreau de campagne avec champs de fusion, une réponse
 *     improvisée par l'assistant, une phrase tapée à la main. La première est
 *     LITTÉRALEMENT une instanciation de gabarit — retirer les créneaux
 *     instanciés (prénom, lien de suivi, montant, heure) reconstitue le gabarit
 *     tel qu'il a été écrit et effondre le gros du corpus pour rien. C'est ce
 *     premier repli qui laisse au second quelques centaines de chaînes à
 *     comparer au lieu de cinquante mille : sans lui, le second coûterait des
 *     millions de hachages de grammes et ne tiendrait pas dans une page.
 *  2. **SimHash-64 sur 4-grammes de caractères**, distance de Hamming ≤ 3.
 *     Rattrape « même gabarit, une clause réécrite » — la dérive typique d'un
 *     modèle qui improvise. SimHash est réputé instable sur les entrées
 *     courtes ; c'est corrigé en le faisant travailler sur des 4-grammes
 *     (≈ 150 traits pour un SMS de 150 caractères, pas ≈ 20 comme des jetons de
 *     mots) et sur les GABARITS, plus longs et plus propres que les corps bruts.
 *
 * Ce qui est écarté et pourquoi : MinHash/Jaccard est conçu pour des documents
 * longs — un SMS donne une vingtaine de bardeaux, et l'erreur d'estimation
 * d'une esquisse à 128 permutations est du même ordre que le signal cherché.
 * Le cosinus de trigrammes est plus juste sur les chaînes courtes, mais c'est
 * exactement ce que fait `pg_trgm` : aucune extension n'est installée dans ce
 * dépôt et en installer une est une migration de production. Si `pg_trgm`
 * arrive un jour, il remplace le second repli par un parcours d'index.
 */
import type { TemplateCluster } from "./types";

// ── Ce qu'on reçoit de Postgres ─────────────────────────────────────────────

export interface CoarseGroup {
  coarseKey: string;
  /** Un corps RÉEL représentatif du groupe. */
  body: string;
  messages: number;
  distinctRecipients: number;
  /** Ids (ou E.164) des numéros expéditeurs distincts du groupe. */
  senders: string[];
  /** Prénom du destinataire, quand la requête a pu le fournir. */
  firstName?: string | null;
}

// ── Bornes de coût ──────────────────────────────────────────────────────────

/**
 * Plafond de groupes grossiers que la requête a le droit de rapporter.
 *
 * C'est le CALLER (`deliverability-server/templates.ts`) qui l'applique en SQL
 * et qui pose `truncated: true` quand il mord ; le repli ne tronque rien de
 * lui-même. La raison est simple : couper ici ferait disparaître des grappes
 * sans que personne ne l'écrive à l'écran, et un onglet de conformité qui
 * sous-compte en silence est pire qu'un onglet qui dit « analyse partielle ».
 */
export const MAX_SCAN_ROWS = 20_000;

/**
 * Garde-fou de seau dégénéré. Le blocage par bandes met dans le même seau tous
 * les gabarits qui partagent 16 bits d'empreinte ; un corpus où tout se
 * ressemble produit un seau géant et la comparaison deux à deux y devient
 * quadratique. Au-delà de cette taille le seau est SAUTÉ : on préfère rater
 * quelques fusions approchées (le repli exact, lui, a déjà fait son travail)
 * plutôt que faire tourner la page pendant une minute.
 */
export const MAX_BUCKET = 200;

/**
 * Distance de Hamming maximale entre deux empreintes de 64 bits pour les
 * déclarer proches — la valeur de Manku, Jain & Das Sarma (WWW 2007) pour des
 * empreintes de 64 bits. Elle est solidaire du blocage à 4 bandes de 16 bits :
 * à 3 bits de différence au plus, au moins une bande sur quatre reste
 * identique (principe des tiroirs), donc le blocage est EXACT — il n'écarte
 * aucune paire proche. Monter ce nombre à 4 casserait cette garantie.
 *
 * Ce que ce seuil attrape RÉELLEMENT, mesuré sur des corps français d'ici (le
 * chiffre est la distance obtenue) :
 *
 *  · un mot changé dans un gabarit d'au moins ≈ 180 caractères : 3 → fusionne ;
 *  · le même mot changé dans un gabarit de ≈ 100 caractères : 5 → ne fusionne
 *    pas, parce qu'un même remaniement pèse deux fois plus lourd sur un corps
 *    deux fois plus court ;
 *  · une phrase entière réécrite : 9 à 17 → ne fusionne jamais.
 *
 * Le second repli n'est donc PAS un détecteur de paraphrase et ne doit pas être
 * présenté comme tel : il rattrape la dérive fine, là où le premier s'arrête.
 * Et c'est bien le premier qui fait le gros du travail — accents, apostrophes,
 * ponctuation, prénom, lien de suivi, montant, heure et pied de page donnent
 * tous une distance de ZÉRO, parce que la normalisation les a déjà effacés
 * avant qu'une empreinte soit calculée.
 *
 * Le déséquilibre est voulu dans ce sens-là : sous-fusionner affiche deux
 * grappes là où un œil humain en verrait une, tandis que sur-fusionner FABRIQUE
 * une alerte d'essaimage sur des textes sans rapport — et une alerte inventée
 * sur un écran de conformité coûte la confiance de tout l'onglet.
 */
export const SIMHASH_MAX_DISTANCE = 3;

// ── Sentinelles ─────────────────────────────────────────────────────────────

/**
 * Les créneaux instanciés deviennent ces jetons. Ils sont en ASCII minuscule et
 * encadrés de `~` pour trois raisons : ils traversent le pliage de casse et le
 * dépouillement des accents sans bouger, la classe de ponctuation les épargne
 * explicitement, et aucun texte français n'écrit `~` spontanément.
 */
const PERSON = "~p~";
const BRAND = "~b~";
const FIELD = "~f~";
const URL = "~u~";
const PHONE = "~t~";
const MONEY = "~m~";
const DATE = "~d~";
const HOUR = "~h~";
const NUMBER = "~n~";

// ── Étapes de la normalisation française ────────────────────────────────────
//
// L'ORDRE PORTE LE SENS. Tout ce qui a besoin de la casse ou des accents passe
// AVANT le pliage ; tout le reste après. Inverser deux étapes ne fait pas un
// résultat « un peu différent », ça fait un résultat faux : remplacer les
// chiffres avant les téléphones détruit le motif du téléphone, et plier la
// casse avant le prénom rend la comparaison littérale du prénom impossible.

/** Caractères à échapper pour bâtir un motif littéral (mode `u`). */
const RE_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Un jeton littéral borné par des non-lettres. Sans les bornes, un client
 * prénommé « Marc » transformerait « marché » en « ~p~hé » — et comme la
 * normalisation d'un corps dépendrait alors du destinataire, deux instances du
 * MÊME gabarit ne se replieraient plus ensemble. C'est précisément ce que le
 * repli doit éviter.
 */
function literalTokenRe(token: string): RegExp | null {
  const escaped = token.replace(RE_SPECIALS, "\\$&");
  try {
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
  } catch {
    // Un demi-substitut égaré (émoji tronqué collé dans un champ « nom ») rend
    // le motif invalide. On saute le remplacement plutôt que de faire tomber
    // tout l'onglet pour une fiche mal saisie.
    return null;
  }
}

/** 3. Champs de fusion, rendus ou non. `${x}` avant `{x}`, `{{x}}` avant `{x}`. */
const MERGE_FIELD_RE = /\$\{[^{}]*\}|\{\{[^{}]*\}\}|\{[^{}]*\}|\[[^[\]]*\]|%[a-z0-9_.-]+%/gi;

/**
 * 4. Liens. Même forme que `URL_RE` de `src/lib/guardrails/filter.ts` — schéma
 * explicite, préfixe `www.`, ET domaine nu, parce que « voir nos propriétés sur
 * exemple.ca » est un lien pour un opérateur téléphonique comme pour le
 * garde-fou. Les liens de suivi par destinataire sont la première source de
 * fausse unicité : sans cette étape, mille envois du même gabarit font mille
 * gabarits distincts.
 */
const URL_RE =
  /(https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|net|org|ca|qc|io|co|info|biz|app|link|ly|me|shop|site|xyz)\b[^\s]*)/gi;

/**
 * 5. Téléphones AVANT les chiffres. Les corps portent les deux formes : E.164
 * (`+15145550134`) et québécoise (`(514) 555-0134`), séparateurs insécables
 * compris.
 */
const PHONE_RE =
  /(?:\+?1[\s.  -]?)?\(?\d{3}\)?[\s.  -]?\d{3}[\s.  -]?\d{4}/g;

/**
 * 6. Montants. Le français écrit la décimale avec une virgule et les milliers
 * avec une espace insécable (U+00A0) ou fine insécable (U+202F) — un motif
 * anglophone sur `,` et `.` ne verrait rien de « 450 000 $ ». `450 k$` est la
 * forme courte du courtier et se traite d'abord, sinon `450` partirait seul.
 */
const MONEY_RE =
  /\d+\s?k\s?\$|\d[\d\s  ]*(?:,\d{1,2})?\s*\$|\$\s?\d[\d\s  ]*(?:[.,]\d{1,2})?/g;

/** 7a. Heures : `14h`, `14 h 30`, `14:30`. */
const TIME_RE = /\b\d{1,2}\s?h(?:\s?\d{2})?|\b\d{1,2}:\d{2}\b/gi;

/** 7b. Dates numériques : ISO et `12/05`. Le point n'est pas séparateur ici — il ferait de « 3.5 » une date. */
const DATE_NUM_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;

/**
 * 7c. Jours et mois français, abréviations comprises. Les variantes longues
 * précèdent les courtes dans l'alternance (`septembre` avant `sept`), sinon
 * l'alternance mordrait la forme courte et laisserait « embre » derrière elle.
 * La borne de fin est une anticipation et non `\b` : `\b` accepterait
 * « maison » après « mai ».
 */
const FR_DATE_WORD_RE =
  /\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|janvier|janv|f[ée]vrier|f[ée]vr|mars|avril|mai|juin|juillet|ao[uû]t|septembre|sept|octobre|oct|novembre|nov|d[ée]cembre|d[ée]c)\.?(?![\p{L}\p{N}])/giu;

/** 8. Émojis, sélecteurs de variante et liant de largeur nulle — retirés, pas remplacés. */
const EMOJI_RE = /[\p{Extended_Pictographic}️‍]/gu;

// 9. Le pied de page de conformité.
/** Verbes d'invitation qui précèdent le mot-clé. */
const FOOTER_LEAD =
  "(?:r[ée]pond(?:ez|re|s|ez-nous)?|envoy(?:ez|er)|text(?:ez|o)?|tapez|composez|reply|send|answer)";
/** Le code court qui suit — chiffres, ou la sentinelle déjà posée par l'étape 5. */
const FOOTER_NUM = "(?:\\s*(?:au|[àa]|to|par|sur)?\\s*(?:~[a-z]~|\\d[\\d\\s.\\u00A0\\u202F-]*))";
/** Le but déclaré qui suit. */
const FOOTER_PURPOSE =
  "(?:\\s*(?:pour|afin\\s+d[e']|to)\\s*(?:vous\\s+|nous\\s+|me\\s+|be\\s+)?" +
  "(?:d[ée]sabonner|d[ée]sinscrire|arr[êe]ter|ne\\s+plus\\s+(?:rien\\s+)?recevoir|unsubscribe|opt\\s*-?\\s*out|cancel))";

/**
 * 9. Le pied de page de conformité, RETIRÉ EN ENTIER.
 *
 * Cette étape compte bien plus qu'elle n'en a l'air. « Répondez STOP pour vous
 * désabonner » est identique sur TOUS les messages sortants : laissé en place,
 * il donne à deux gabarits sans aucun rapport une base commune de texte et
 * relève le plancher de similarité du second repli. Le résultat n'est pas une
 * imprécision, c'est une grappe FABRIQUÉE — l'écran annoncerait un essaimage
 * là où il n'y a qu'un pied de page réglementaire, et l'opérateur cesserait de
 * croire l'onglet.
 *
 * « ARRÊT » compte autant que « STOP » : c'est le mot-clé français, et
 * `normalizeOptOutInput` l'accepte depuis toujours. L'oublier ici laissait le
 * pied de page dans le gabarit — une constante identique sur des textes SANS
 * RAPPORT, qui les rapprochait assez pour les fondre en une seule grappe et
 * fabriquer une alerte d'essaimage sur un trafic irréprochable.
 *
 * Le mot-clé seul n'est jamais retiré : la deuxième alternance exige au moins
 * une suite (un code court ou un but), la première un verbe d'invitation. Un
 * « stop » isolé au milieu d'une phrase reste donc du texte, comme il doit.
 */
const COMPLIANCE_FOOTER_RE = new RegExp(
  "(?:" +
    `${FOOTER_LEAD}\\s*(?:«\\s*)?(?:stops?|arr[eê]t)(?:\\s*»)?(?:${FOOTER_NUM}|${FOOTER_PURPOSE})*` +
    "|" +
    `(?:«\\s*)?\\b(?:stops?|arr[eê]t)\\b(?:\\s*»)?(?:${FOOTER_NUM}|${FOOTER_PURPOSE})+` +
    "|" +
    "\\b(?:stopall|unsubscribe|d[ée]sabonnement|se\\s+d[ée]sabonner)\\b" +
    ")",
  "giu",
);

/** 10. Marques combinatoires laissées par NFKD : é→e, ç→c, ù→u. */
const COMBINING_RE = /\p{M}/gu;

/**
 * 12. Apostrophes : SUPPRIMÉES, pas remplacées par une espace. `j'ai` devient
 * `jai` et `c'est` devient `cest`, ce qui fusionne délibérément l'orthographe
 * sans apostrophe que les texteurs produisent réellement. Mettre une espace à
 * la place fabriquerait des jetons d'une lettre (`l`, `d`, `qu`) qui polluent
 * les 4-grammes du second repli.
 */
const APOSTROPHE_RE = /['‘’ʹʼ`´]/g;

/** 13. Toute la ponctuation sauf `~`, qui porte les sentinelles. */
const PUNCTUATION_RE = /[^\p{L}\p{N}~\s]/gu;

/** 14. Ce qui reste de chiffres : numéros civiques, âges, superficies. */
const DIGIT_RUN_RE = /\d+/g;

/** 15. Espaces de toute nature, insécables et de largeur nulle comprises. */
const WHITESPACE_RE = /[\s  ​‌‍﻿]+/g;

/**
 * Le gabarit d'un corps de message — la chaîne sur laquelle les deux replis
 * travaillent.
 *
 * `firstName` est le prénom du DESTINATAIRE de ce corps-là, obtenu par jointure
 * et non deviné : le remplacement est littéral, sans dictionnaire et sans faux
 * positif. Le garde de trois lettres n'est pas décoratif — un client prénommé
 * « Ed » ferait de « médecin » un « m~p~ecin » et disperserait le gabarit au
 * lieu de le rassembler.
 *
 * `brandTokens` reçoit les mots de marque de l'exploitant. Ils sont retirés
 * pour la même raison que le pied de page : présents partout, ils ne
 * distinguent rien et remontent la similarité de fond.
 */
export function normalizeTemplate(
  body: string,
  firstName?: string | null,
  brandTokens?: string[],
): string {
  let text = body;

  // ── Pré-passe : la casse et les accents sont encore là, on s'en sert. ──

  // 1. Le prénom du destinataire dans son propre message.
  const name = (firstName ?? "").trim();
  if (name.length >= 3) {
    const nameRe = literalTokenRe(name);
    if (nameRe) text = text.replace(nameRe, `$1${PERSON}`);
  }

  // 2. Les mots de marque. Du plus long au plus court, sinon « Nexus » mordrait
  //    à l'intérieur de « Groupe Nexus » et laisserait « Groupe ~b~ » derrière.
  if (brandTokens && brandTokens.length > 0) {
    const tokens = Array.from(new Set(brandTokens.map((token) => token.trim())))
      .filter((token) => token.length >= 3)
      .sort((a, b) => b.length - a.length);
    for (const token of tokens) {
      const tokenRe = literalTokenRe(token);
      if (tokenRe) text = text.replace(tokenRe, `$1${BRAND}`);
    }
  }

  // 3. Champs de fusion. Certaines rangées sont des gabarits jamais rendus
  //    (`{{prenom}}` parti tel quel) : elles doivent atterrir dans le MÊME
  //    groupe que leurs instances rendues, sinon la fuite de champ de fusion
  //    apparaît comme un gabarit à part et se noie dans la liste.
  text = text.replace(MERGE_FIELD_RE, FIELD);

  // 4. Liens.
  text = text.replace(URL_RE, URL);

  // 5. Téléphones — avant tout traitement des chiffres.
  text = text.replace(PHONE_RE, PHONE);

  // 6. Montants.
  text = text.replace(MONEY_RE, MONEY);

  // 7. Heures puis dates. L'heure d'abord : « 14h30 » contient un motif de
  //    chiffres que la date numérique pourrait entamer.
  text = text.replace(TIME_RE, HOUR);
  text = text.replace(DATE_NUM_RE, DATE);
  text = text.replace(FR_DATE_WORD_RE, DATE);

  // 8. Émojis.
  text = text.replace(EMOJI_RE, "");

  // 9. Pied de page de conformité.
  text = text.replace(COMPLIANCE_FOOTER_RE, " ");

  // ── Passe de pliage : à partir d'ici, ni casse ni accents. ──

  // 10. NFKD puis retrait des marques combinatoires. NFKD ne décompose PAS `œ`
  //     ni `æ` — Unicode les traite comme des lettres et non comme des
  //     ligatures — d'où la table explicite ci-dessous. Sans elle, « sœur »
  //     resterait « sœur » alors que le même mot tapé « soeur » deviendrait
  //     « soeur » : deux gabarits pour un.
  text = text.normalize("NFKD").replace(COMBINING_RE, "");
  text = text
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "OE")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "AE");

  // 11. Casse.
  text = text.toLowerCase();

  // 12. Apostrophes.
  text = text.replace(APOSTROPHE_RE, "");

  // 13. Ponctuation, sauf `~`.
  text = text.replace(PUNCTUATION_RE, "");

  // 14. Chiffres restants.
  text = text.replace(DIGIT_RUN_RE, NUMBER);

  // 15. Espaces.
  return text.replace(WHITESPACE_RE, " ").trim();
}

// ── Empreintes ──────────────────────────────────────────────────────────────

/**
 * FNV-1a 32 bits — même forme que `hashKey` de `src/lib/campaigns/variants.ts`.
 * Non cryptographique, et c'est voulu : on compte des doublons de texte, on ne
 * protège rien.
 */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Multiplication FNV en 32 bits non signés.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Brassage final de 32 bits (le `fmix32` de MurmurHash3).
 *
 * INDISPENSABLE ici, et pas pour la beauté du geste. FNV-1a ne propage presque
 * rien vers ses bits de poids faible : la multiplication par un nombre impair
 * laisse le bit 0 intact, si bien que le bit 0 d'une empreinte FNV n'est que la
 * parité des bits 0 des caractères, décalée par la graine. Comme les deux
 * moitiés de `hash64` ne diffèrent QUE par leur graine, leurs bits 0, 1 et 2
 * sont parfaitement corrélés — mesuré : ils s'accordent 100 % du temps.
 *
 * Sans ce brassage, trois des soixante-quatre positions du SimHash sont donc
 * la copie de trois autres : elles n'apportent aucune information et comptent
 * DEUX FOIS dans la distance de Hamming. Le seuil de 3 bits, qui est le cœur
 * du second repli, se trouve alors faussé sur une empreinte qui n'en vaut que
 * soixante et une.
 */
function avalanche(word: number): number {
  let h = (word ^ (word >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 64 bits portés en DEUX MOITIÉS de 32 bits `[hi, lo]`.
 *
 * Ce n'est pas un choix de style : `tsconfig` cible ES2017, où un littéral
 * `BigInt` (`0n`) est une erreur de compilation. Deux graines FNV différentes
 * donnent les deux moitiés, chacune brassée pour les décorréler (voir
 * `avalanche`). La collision d'un gabarit sur 64 bits est sans conséquence ici :
 * au pire deux gabarits sans rapport se comptent ensemble sur un écran de
 * lecture, jamais sur une décision d'envoi.
 */
export function hash64(s: string): [number, number] {
  return [avalanche(fnv1a(s, 0x811c9dc5)), avalanche(fnv1a(s, 0x9e3779b9))];
}

/** La clé de `Map` d'une empreinte : 16 chiffres hexadécimaux, stable et triable. */
export function keyOf(h: [number, number]): string {
  return (h[0] >>> 0).toString(16).padStart(8, "0") + (h[1] >>> 0).toString(16).padStart(8, "0");
}

/** Taille des grammes. Quatre caractères : ≈ 150 traits pour un SMS, contre ≈ 20 en jetons de mots. */
const GRAM = 4;

/**
 * SimHash-64 sur les 4-grammes de caractères d'un gabarit.
 *
 * Chaque gramme vote pour ou contre chacun des 64 bits ; le signe de la somme
 * fixe le bit. Deux textes qui partagent la plupart de leurs grammes gardent
 * donc la plupart de leurs bits — c'est ce qui rend la distance de Hamming
 * lisible comme une distance de contenu.
 *
 * Un gabarit plus court qu'un gramme n'aurait AUCUN trait et sortirait avec
 * l'empreinte nulle, comme tous ses semblables : tous les corps minuscules du
 * corpus se retrouveraient dans une seule grappe. Ils sont donc hachés en
 * entier, ce qui les sépare correctement.
 */
export function simhash64(t: string): [number, number] {
  const votes = new Int32Array(64);
  if (t.length < GRAM) {
    if (t.length === 0) return [0, 0];
    return hash64(t);
  }
  for (let i = 0; i + GRAM <= t.length; i += 1) {
    const [hi, lo] = hash64(t.slice(i, i + GRAM));
    for (let b = 0; b < 32; b += 1) {
      votes[b] += ((lo >>> b) & 1) === 1 ? 1 : -1;
      votes[b + 32] += ((hi >>> b) & 1) === 1 ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b += 1) {
    if (votes[b] > 0) lo |= 1 << b;
    if (votes[b + 32] > 0) hi |= 1 << b;
  }
  return [hi >>> 0, lo >>> 0];
}

/** Nombre de bits à 1 d'un mot de 32 bits (Hamming weight, sans boucle). */
function popcount(word: number): number {
  let x = word - ((word >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Distance de Hamming entre deux empreintes de 64 bits. */
export function hamming(a: [number, number], b: [number, number]): number {
  return popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);
}

// ── Le repli ────────────────────────────────────────────────────────────────

interface TemplateGroup {
  template: string;
  messages: number;
  recipients: number;
  senders: Set<string>;
  /** Le corps brut le plus envoyé du groupe, et son compte. */
  bestBody: string;
  bestCount: number;
}

interface Cluster {
  messages: number;
  recipients: number;
  senders: Set<string>;
  bestBody: string;
  bestCount: number;
}

/**
 * Le corps représentatif est le corps brut le PLUS ENVOYÉ, pas le premier venu.
 *
 * L'opérateur doit lire ce que les gens ont réellement reçu — avec un vrai
 * prénom et un vrai lien dedans — et non le gabarit reconstruit, qui n'a jamais
 * été envoyé à personne et qui donne l'impression d'un extrait tronqué. En cas
 * d'égalité on tranche sur la chaîne : sans ce départage, l'ordre des rangées
 * renvoyées par Postgres changerait le représentant d'un chargement à l'autre.
 */
function keepBest(
  current: { bestBody: string; bestCount: number },
  body: string,
  count: number,
): void {
  if (count > current.bestCount || (count === current.bestCount && body < current.bestBody)) {
    current.bestBody = body;
    current.bestCount = count;
  }
}

/**
 * `distinctSendingNumbers ≥ 2` : LE seul chiffre de cet onglet qui alarme.
 *
 * Il ne dit pas « ce texte est répétitif », il dit : **un même gabarit est
 * porté par plusieurs numéros expéditeurs à la fois**. C'est mot pour mot la
 * pratique nommée et interdite par les bonnes pratiques CTIA §5.5.2 :
 *
 *   « Message Senders should not engage in Snowshoe Messaging, which is a
 *     technique used to spread messages across many sending phone numbers or
 *     short codes. Service Providers should also take measures to prevent
 *     Snowshoe Messaging. Messaging use cases that require the use of multiple
 *     numbers to distribute "similar" or "like" content may require special
 *     arrangements between Message Senders and Service Providers. »
 *
 * Tout le reste de l'onglet est du CONTEXTE, et il faut le lire ainsi. Un taux
 * de répétition élevé sur UN SEUL numéro est le comportement normal et conforme
 * d'une campagne A2P : une campagne 10DLC inscrite est censée ressembler aux
 * exemples qu'elle a déclarés. Alarmer là-dessus apprendrait à l'exploitant à
 * ignorer la page — c'est pourquoi `duplication_rate` est marqué
 * `informational` dans `thresholds.ts` et pourquoi `template_spread` est le
 * seul seuil de provenance `carrier` de ce groupe.
 *
 * ⚠️ CE DÉTECTEUR NE DOIT PAS SERVIR À ALIMENTER UN GÉNÉRATEUR DE VARIANTES.
 * La tentation est immédiate — « le tableau dit que mes textes se ressemblent,
 * donc je les fais varier automatiquement » — et c'est exactement la
 * transgression. La politique de messagerie de Twilio interdit, sous « actions
 * prohibées », de répandre des messages semblables ou identiques sur plusieurs
 * numéros « with the intent OR EFFECT of evading unwanted messaging detection
 * and prevention mechanisms », et interdit de même « intentionally misspelling
 * words or non-standard opt-out phrases created to evade detection ». La
 * clause d'EFFET est la partie qui compte : il n'est pas nécessaire de l'avoir
 * voulu. Une variation fabriquée pour faire baisser ce chiffre est jugée sur
 * son effet, donc elle est la violation — pas le remède. La bonne réponse à
 * `distinctSendingNumbers ≥ 2` est d'épingler le gabarit à UN numéro, jamais de
 * réécrire le texte. S'y ajoute une raison pratique : l'inscription 10DLC exige
 * des exemples représentatifs du trafic réel, et l'écart entre ce qui est
 * déclaré et ce qui est envoyé se lit lui aussi comme de l'évasion.
 */
export function foldTemplates(groups: CoarseGroup[]): TemplateCluster[] {
  // ── Repli 1 : hachage exact du gabarit. O(G·L). ──
  const byTemplate = new Map<string, TemplateGroup>();
  for (const group of groups) {
    const template = normalizeTemplate(group.body, group.firstName);
    const key = keyOf(hash64(template));
    let entry = byTemplate.get(key);
    if (!entry) {
      entry = {
        template,
        messages: 0,
        recipients: 0,
        senders: new Set<string>(),
        bestBody: group.body,
        bestCount: -1,
      };
      byTemplate.set(key, entry);
    }
    entry.messages += group.messages;
    // Les destinataires arrivent DÉJÀ comptés par groupe grossier (la requête
    // rend `count(distinct …)`, pas la liste : un gabarit diffusé à vingt mille
    // personnes ferait autrement transiter vingt mille numéros). La somme
    // surcompte donc légèrement quand une même personne apparaît dans deux
    // groupes fusionnés ; le serveur recompte exactement les vingt premières
    // grappes, les seules qu'un exploitant regarde. La somme reste bornée par
    // le nombre de messages, puisque chaque groupe respecte
    // `distinctRecipients <= messages` — la concentration ne peut pas dépasser 1.
    entry.recipients += group.distinctRecipients;
    for (const sender of group.senders) entry.senders.add(sender);
    keepBest(entry, group.body, group.messages);
  }

  // ── Repli 2 : SimHash sur les seuls survivants du repli 1. ──
  // T vaut ici quelques centaines à quelques milliers, jamais cinquante mille :
  // c'est toute la justification du dispositif à deux étages.
  const entries = Array.from(byTemplate.values()).map((group) => ({
    group,
    fingerprint: simhash64(group.template),
  }));

  // Blocage par bandes : quatre mots de 16 bits. À `SIMHASH_MAX_DISTANCE` bits
  // de différence au plus, les bits qui diffèrent touchent au plus trois bandes
  // sur quatre — donc deux quasi-doublons partagent forcément une bande entière.
  // Le blocage est exact : il ne peut pas produire de faux négatif.
  const bands = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const words = [
      entry.fingerprint[0] >>> 16,
      entry.fingerprint[0] & 0xffff,
      entry.fingerprint[1] >>> 16,
      entry.fingerprint[1] & 0xffff,
    ];
    words.forEach((word, band) => {
      const bandKey = `${band}:${word}`;
      const bucket = bands.get(bandKey);
      if (bucket) bucket.push(index);
      else bands.set(bandKey, [index]);
    });
  });

  // Union-find : les grappes sont transitives (A~B et B~C rassemblent A et C
  // même si A et C sont à plus de trois bits). Le chaînage est rare à cette
  // distance et bénin sur un écran de lecture ; s'il gênait un jour, il faudrait
  // ancrer chaque grappe sur son premier membre au lieu d'unir.
  const parent = entries.map((_unused, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (const bucket of bands.values()) {
    if (bucket.length > MAX_BUCKET) continue;
    for (let a = 0; a < bucket.length; a += 1) {
      for (let b = a + 1; b < bucket.length; b += 1) {
        const left = entries[bucket[a]];
        const right = entries[bucket[b]];
        if (hamming(left.fingerprint, right.fingerprint) <= SIMHASH_MAX_DISTANCE) {
          union(bucket[a], bucket[b]);
        }
      }
    }
  }

  // ── Émission. ──
  const clusters = new Map<number, Cluster>();
  entries.forEach((entry, index) => {
    const root = find(index);
    let cluster = clusters.get(root);
    if (!cluster) {
      cluster = {
        messages: 0,
        recipients: 0,
        senders: new Set<string>(),
        bestBody: entry.group.bestBody,
        bestCount: -1,
      };
      clusters.set(root, cluster);
    }
    cluster.messages += entry.group.messages;
    cluster.recipients += entry.group.recipients;
    for (const sender of entry.group.senders) cluster.senders.add(sender);
    keepBest(cluster, entry.group.bestBody, entry.group.bestCount);
  });

  return Array.from(clusters.values())
    .map((cluster) => ({
      representativeBody: cluster.bestBody,
      messages: cluster.messages,
      // Borne de sûreté : la concentration d'atteinte est lue comme
      // `distinctRecipients / messages` et un taux au-dessus de 1 sur un écran
      // de conformité fait douter de TOUS les autres chiffres de la page.
      distinctRecipients: Math.min(cluster.recipients, cluster.messages),
      distinctSendingNumbers: cluster.senders.size,
    }))
    .sort((a, b) =>
      b.messages !== a.messages
        ? b.messages - a.messages
        : a.representativeBody < b.representativeBody
          ? -1
          : a.representativeBody > b.representativeBody
            ? 1
            : 0,
    );
}
