/**
 * Analyse de contenu — ce qu'un corps de SMS dit de lui-même.
 *
 * Module PUR (règle du dossier) : aucun `next-intl`, aucun `next/headers`,
 * aucun accès base, aucun `fetch`, aucune horloge, aucune variable
 * d'environnement. Rien n'entre que la chaîne et son contexte, rien ne sort que
 * des FAITS — jamais de prose : le texte qui explique vit dans le registre de
 * constats, en deux langues. `tests/unit-deliverability-purity.test.ts` fait
 * échouer le build si l'un de ces interdits entre ici.
 *
 * ## La discipline du faux positif
 *
 * Ce fichier est le seul de l'écran qui accuse un texte écrit par un humain.
 * Sa règle de conception tient en une phrase :
 *
 * > Une ouverture française conforme — « Bonjour Marie, ici Alex-Honoré du
 * > Groupe Nexus. […] Répondez STOP pour vous désabonner. » — doit produire
 * > ZÉRO signalement.
 *
 * Ce n'est pas une politesse, c'est la condition de survie du tableau de bord.
 * Un détecteur qui crie au loup sur les bons messages est ignoré au bout de
 * trois jours, et un détecteur ignoré ne protège plus rien : il est alors
 * strictement pire que pas de détecteur, parce qu'il donne l'impression que
 * quelqu'un surveille. Trois conséquences concrètes, appliquées partout plus bas :
 *
 *  · **Les mots-clés de conformité sont RETIRÉS avant de mesurer le ton.**
 *    « Répondez STOP » et la signature du courtier sont exigés par la politique
 *    de Twilio ; les compter dans le taux de majuscules ferait sonner l'alarme
 *    précisément sur les messages les mieux écrits.
 *  · **Le vocabulaire immobilier légitime ne figure dans AUCUNE liste.**
 *    « hypothèque », « offre » (d'achat), « mandat exclusif », « cave à vin »,
 *    « acheteur cash » sont le métier du courtier, pas des signaux de pourriel.
 *    Seules les formules de crédit à la consommation que les opérateurs
 *    filtrent réellement — prêt hypothécaire, refinancement, mauvais crédit,
 *    pré-approbation, consolidation de dettes — entrent dans SHAFT.
 *  · **On préfère le silence au bruit.** Sous dix lettres, le taux de
 *    majuscules vaut 0 et non « 100 % » : deux lettres capitales sur trois ne
 *    sont pas un cri, c'est du bruit d'échantillon.
 *
 * ## Ce qu'on ne réimplémente pas
 *
 * Trois définitions existent déjà dans le dépôt et sont RÉUTILISÉES telles
 * quelles, parce qu'une deuxième définition finit toujours par diverger :
 * `URL_RE` (garde-fous) dit ce qu'est un lien, `lintSms` (moteur SMS) dit ce
 * qui force l'UCS-2 et combien de segments sont facturés, `normalizeOptOutInput`
 * (opt-out) dit comment on replie les accents d'un mot-clé d'arrêt.
 */
import { URL_RE } from "@/lib/guardrails/filter";
import { normalizeOptOutInput } from "@/lib/sms/optout";
import { lintSms } from "@/lib/sms/segments";
import type { ContentFlags } from "./types";

// ── Outils communs ──────────────────────────────────────────────────────────

/**
 * Forme comparable d'un texte : sans accents, en minuscules, apostrophes
 * unifiées.
 *
 * Le repli d'accents est délégué à `normalizeOptOutInput` — le MÊME que celui
 * qui reconnaît un STOP entrant. Si les deux divergeaient, l'écran pourrait
 * afficher « mention d'arrêt présente » sur un message dont le mot-clé ne
 * serait justement pas reconnu à l'entrée.
 *
 * L'unification des apostrophes est ajoutée ici et nulle part ailleurs : sur
 * iOS et macOS le clavier français produit « ’ » (U+2019) par défaut, et sans
 * cette ligne « arrêtez de m’écrire » ne s'apparierait à aucune expression
 * multi-mots de ce fichier — la moitié du détecteur d'hostilité serait morte
 * sans que rien ne le signale.
 */
function fold(input: string): string {
  return normalizeOptOutInput(input).toLowerCase().replace(/[‘’‛`´]/g, "'");
}

/** Littéralise une chaîne de configuration avant de la coudre dans un motif. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Dédoublonne en gardant l'ordre d'apparition — le rapport doit être stable. */
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * `U+XXXX` plutôt que le caractère lui-même.
 *
 * Une preuve doit être lisible : un caractère de largeur nulle affiché tel quel
 * est un vide dans la page, et un « а » cyrillique est visuellement IDENTIQUE
 * au « a » latin. Montrer le glyphe reviendrait à écrire « le problème est ici :
 *  » — le point de code est la seule forme qui se vérifie.
 */
function codePointLabel(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Un terme surveillé : le libellé ACCENTUÉ (celui qu'on montrera à l'écran) et
 * son motif replié (celui qui cherche). Les deux se tiennent : chercher sur la
 * forme repliée attrape « offre limitee » comme « offre limitée », mais c'est
 * la forme française qui s'affiche dans la preuve.
 */
interface TermMatcher {
  readonly label: string;
  readonly re: RegExp;
}

/**
 * Frontières de mot ASCII : légitimes ici parce que le motif ET le texte sont
 * repliés avant l'appariement — il ne reste plus une seule lettre accentuée aux
 * bords, là où `\b` aurait échoué (« é » n'est pas un caractère de mot).
 * Aucun drapeau `g` : `.test()` reste apatride, ces motifs sont partagés.
 */
function compileTerms(terms: readonly string[]): readonly TermMatcher[] {
  return terms.map((label) => ({ label, re: new RegExp(`\\b${escapeRegExp(fold(label))}\\b`) }));
}

function matchTerms(folded: string, matchers: readonly TermMatcher[]): string[] {
  const hits: string[] = [];
  for (const matcher of matchers) {
    if (matcher.re.test(folded)) hits.push(matcher.label);
  }
  return hits;
}

// ── Champs de fusion ────────────────────────────────────────────────────────

/**
 * Le constat le plus précis de tout l'écran, et le seul qui soit PROSPECTIF :
 * un `{{prenom}}` laissé dans un barreau de campagne écrit à la main part
 * LITTÉRALEMENT au contact — `renderTemplate` n'a que trois points d'appel, et
 * tous les trois servent le prompt, jamais le corps d'un barreau.
 *
 * Deux précautions contre le faux positif :
 *
 *  · L'intérieur doit ressembler à un IDENTIFIANT (lettre ou souligné en tête,
 *    puis lettres/chiffres/souligné/point). « [1] » en note de bas de message
 *    et « exemple.com/a%20b%20c » ne sont donc pas des champs de fusion — sans
 *    la règle du premier caractère, le second aurait produit « %20b% ».
 *  · La forme `{{ … }}` tolère les espaces intérieures, comme le fait vraiment
 *    `TOKEN_RE` dans `src/lib/agent/render.ts`. Ne pas les tolérer laisserait
 *    passer `{{ prenom }}`, qui casse exactement de la même façon.
 */
const IDENT = "[\\p{L}_][\\p{L}\\p{N}_.]*";
const MERGE_FIELD_RE = new RegExp(
  [
    `\\{\\{\\s*${IDENT}\\s*\\}\\}`,
    `\\$\\{${IDENT}\\}`,
    `\\{${IDENT}\\}`,
    `\\[${IDENT}\\]`,
    `%${IDENT}%`,
  ].join("|"),
  "gu",
);

// ── Liens et raccourcisseurs ────────────────────────────────────────────────

/**
 * Hôtes de raccourcissement public. Twilio rejette explicitement les échantillons
 * de campagne qui en contiennent (30892) et les opérateurs les traitent comme
 * une intention de masquer la destination — ce qui, pour un envoi à froid, est
 * exactement ce dont on est soupçonné.
 */
export const PUBLIC_SHORTENERS: readonly string[] = [
  "bit.ly",
  "tinyurl.com",
  "goo.gl",
  "t.co",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "cutt.ly",
  "rebrand.ly",
  "rb.gy",
  "tiny.cc",
  "s.id",
  "shorturl.at",
  "lnkd.in",
  "t.ly",
  "v.gd",
  "tr.im",
  "bl.ink",
  "linktr.ee",
];

const SHORTENER_HOSTS = new Set(PUBLIC_SHORTENERS);

/**
 * Rattrapage — et le seul endroit où l'on voit un lien que le garde-fou ne voit
 * pas.
 *
 * La troisième branche de `URL_RE` (domaine nu) n'accepte qu'une liste fermée
 * d'extensions : `.gl`, `.gd`, `.gy`, `.cc`, `.id`, `.at`, `.in`, `.ee` n'y
 * sont PAS. Un « goo.gl/xy » sans schéma est donc invisible pour elle, alors
 * qu'il est précisément la forme de lien la plus reprochée. On ajoute donc les
 * hôtes raccourcisseurs connus, avec un chemin obligatoire pour ne pas
 * confondre une adresse avec la simple mention du service (« n'utilisez pas
 * bit.ly »). La divergence ne va que dans ce sens : tout ce que `URL_RE` voit,
 * on le voit — l'inverse est faux, et c'est documenté plutôt que corrigé, parce
 * qu'élargir `URL_RE` changerait le comportement d'un garde-fou d'envoi.
 */
const BARE_SHORTENER_RE = new RegExp(
  `\\b(?:${PUBLIC_SHORTENERS.map(escapeRegExp).join("|")})\\/[^\\s]+`,
  "gi",
);

/**
 * Hôte d'un lien. Reprend `hostnameOf` de `src/lib/guardrails/filter.ts` (privé
 * là-bas) en corrigeant un détail : le test de schéma est ancré, si bien qu'un
 * « httpfoo.com » est bien préfixé au lieu d'être donné tel quel à `URL` et de
 * lever. Ne fait aucune requête — `URL` n'est qu'un analyseur syntaxique.
 */
function hostOf(rawUrl: string): string | null {
  const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isShortenerHost(host: string): boolean {
  if (SHORTENER_HOSTS.has(host)) return true;
  for (const shortener of PUBLIC_SHORTENERS) {
    if (host.endsWith(`.${shortener}`)) return true;
  }
  return false;
}

// ── Mention d'arrêt ─────────────────────────────────────────────────────────

/**
 * Marqueurs d'arrêt cherchés DANS un corps sortant.
 *
 * Volontairement plus court que `OPTOUT_KEYWORDS` (`src/lib/sms/optout.ts`), et
 * pour une raison de fond : là-bas le message ENTIER doit être égal au mot-clé,
 * ici on cherche à l'intérieur d'une phrase. « ANNULER », « END », « QUIT » ou
 * « CANCEL » y sont légitimes ; cherchés en sous-chaîne, « annuler votre
 * rendez-vous ? » deviendrait une mention de désabonnement et l'écran
 * certifierait conforme un message qui ne l'est pas. On ne garde que les
 * formules qu'un pied de message conforme emploie réellement.
 *
 * Le corps est replié par `normalizeOptOutInput` : « ARRÊT » et « arret » sont
 * la même chose, et les frontières `\b` s'appliquent à de l'ASCII.
 */
const OPT_OUT_MARKERS_RE = /\b(?:STOPALL|STOP|ARRET(?:EZ|ONS)?|DESABONNE(?:R|MENT|Z)?|UNSUBSCRIBE)\b/;

/**
 * Vrai quand le corps porte une mention d'arrêt. Le biais est assumé : en cas
 * de doute on répond « présente », parce qu'un faux positif ici fait seulement
 * taire un constat, tandis qu'un faux négatif accuse un message conforme.
 */
export function hasOptOutLanguage(body: string): boolean {
  return OPT_OUT_MARKERS_RE.test(normalizeOptOutInput(body));
}

// ── Ton : majuscules et exclamations ────────────────────────────────────────

/**
 * Ce qu'on efface avant de juger le ton.
 *
 * « STOP » et « ARRÊT » s'écrivent en capitales parce que la politique de
 * Twilio les veut reconnaissables ; les compter dans le taux de majuscules
 * classerait comme criard le seul type de message qu'on souhaite voir. La liste
 * reste courte à dessein : effacer un mot de prose minuscule (« aide »,
 * « info », « oui ») retirerait des lettres MINUSCULES du dénominateur et
 * gonflerait le taux — l'effacement doit aller dans le sens de l'indulgence,
 * jamais l'inverse.
 *
 * Le motif travaille sur le texte BRUT (le repli d'accents changerait les
 * longueurs), d'où les alternatives d'accents écrites à la main.
 */
const SHOUTING_EXEMPT_RE =
  /\b(?:stop\s?all|stopall|stop|arr[eéèê]t(?:ez|ons)?|d[eé]sabonne(?:r|ment|z)?|unsubscribe|help)\b/gi;

const LETTER_RE = /\p{L}/u;
const UPPERCASE_LETTER_RE = /\p{Lu}/u;

/** En deçà, un taux de majuscules n'est pas une mesure mais un accident. */
const MIN_LETTERS_FOR_CAPS = 10;

/**
 * Corps débarrassé des mots-clés de conformité et des marques.
 *
 * L'appariement des marques se fait sur le texte brut, insensible à la casse :
 * une signature criée (« GROUPE NEXUS ») est justement le cas qu'il faut
 * neutraliser. Une marque écrite avec d'autres accents que sa configuration
 * échappe à cet effacement — c'est un manque assumé, `hasBrand` (replié) reste
 * la mesure de présence qui fait foi ; ici on ne corrige qu'un dénominateur.
 * Les jetons d'un caractère sont ignorés : ils raboteraient le message entier.
 */
function stripCompliance(body: string, brandTokens: readonly string[]): string {
  let out = body.replace(SHOUTING_EXEMPT_RE, " ");
  for (const token of brandTokens) {
    const trimmed = token.trim();
    if (trimmed.length < 2) continue;
    out = out.replace(new RegExp(escapeRegExp(trimmed), "gi"), " ");
  }
  return out;
}

// ── Vocabulaire promotionnel ────────────────────────────────────────────────

/**
 * Vocabulaire promotionnel français et anglais.
 *
 * Écrit sous sa forme ACCENTUÉE : c'est ce libellé qui remonte dans la preuve,
 * et une page française qui reproche « offre limitee » perd sa crédibilité en
 * même temps que son accent. L'appariement, lui, se fait sur la forme repliée.
 *
 * Ce qui n'y est PAS, et pourquoi : « offre » seul (une offre d'achat est le
 * cœur du métier), « exclusif » (un mandat exclusif aussi), « garantie » (la
 * garantie légale de qualité), « aubaine » et « cash » (le vocabulaire courant
 * des fiches québécoises), « sans engagement » (déjà couvert par « gratuit »
 * quand c'est vraiment de la promotion). Chacun de ces mots aurait allumé
 * l'écran sur des messages parfaitement normaux.
 */
export const PROMO_TERMS_FR_EN: readonly string[] = [
  // Français
  "gratuit",
  "gratuite",
  "sans frais",
  "aucun frais",
  "urgent",
  "urgence",
  "dernière chance",
  "dernier appel",
  "offre limitée",
  "offre exclusive",
  "offre spéciale",
  "temps limité",
  "durée limitée",
  "agissez maintenant",
  "appelez maintenant",
  "réservez maintenant",
  "ne manquez pas",
  "profitez-en",
  "cliquez ici",
  "cliquez sur le lien",
  "félicitations",
  "gagnant",
  "gagnante",
  "vous avez gagné",
  "prix à gagner",
  "garanti",
  "argent facile",
  "promotion",
  "rabais",
  "meilleur prix",
  "prix imbattable",
  // Anglais
  "free",
  "act now",
  "limited time",
  "limited offer",
  "special offer",
  "click here",
  "winner",
  "congratulations",
  "guaranteed",
  "risk free",
  "best price",
  "buy now",
  "call now",
  "earn money",
  "make money",
];

/**
 * SHAFT (sexe, haine, alcool, armes à feu, tabac) — plus les jeux d'argent et,
 * surtout, LE piège du courtier immobilier.
 *
 * Les cinq dernières entrées françaises ne relèvent pas de SHAFT au sens strict :
 * ce sont les formules de crédit à la consommation que les opérateurs
 * nord-américains filtrent le plus durement, et un courtier immobilier écrit
 * « refinancement » ou « pré-approbation » sans y voir malice. C'est exactement
 * pour ça qu'elles sont ici : le constat doit se lever AVANT que le message ne
 * parte, pas après le 30007.
 *
 * « hypothèque » seul reste absent — c'est le métier, pas un signal. De même
 * « vin » (« cave à vin » est une ligne de fiche descriptive) et « cave ».
 */
export const SHAFT_TERMS: readonly string[] = [
  // Sexe
  "sexe",
  "sexy",
  "porno",
  "pornographie",
  "escorte",
  "nudité",
  "xxx",
  "porn",
  "escort",
  "nude",
  // Haine
  "haine",
  "raciste",
  "racisme",
  "nazi",
  "suprémaciste",
  "racist",
  "hate speech",
  // Alcool
  "alcool",
  "bière",
  "spiritueux",
  "whisky",
  "vodka",
  "alcohol",
  "beer",
  "liquor",
  // Armes à feu
  "arme à feu",
  "armes à feu",
  "fusil",
  "carabine",
  "pistolet",
  "munitions",
  "firearm",
  "firearms",
  "handgun",
  "ammo",
  // Tabac et cannabis
  "tabac",
  "cigarette",
  "cigarettes",
  "vapotage",
  "vapoteuse",
  "nicotine",
  "cannabis",
  "marijuana",
  "cbd",
  "thc",
  "tobacco",
  "vape",
  "weed",
  // Jeux d'argent
  "casino",
  "pari sportif",
  "paris sportifs",
  "loterie",
  "gambling",
  "betting",
  // Crédit à la consommation — le piège immobilier
  "prêt hypothécaire",
  "prêts hypothécaires",
  "refinancement",
  "refinancer",
  "mauvais crédit",
  "pré-approbation",
  "préapprobation",
  "consolidation de dettes",
  "consolidation de dette",
  "réparation de crédit",
  "prêt personnel",
  "prêt rapide",
  "argent rapide",
  "bad credit",
  "debt consolidation",
  "credit repair",
  "payday loan",
  "refinance",
];

/**
 * Réponses hostiles — PROXY de plainte, jamais la plainte.
 *
 * Les signalements au 7726 arrivent à l'agrégateur, pas sur la rangée du
 * message : ils sont structurellement hors de portée. Ce qu'on peut voir, c'est
 * un mot de colère dans une réponse ENTRANTE. La liste évite soigneusement les
 * mots qu'un contact poli emploie (« annuler », « non merci », « plus tard ») et
 * les faux amis du français (« cave », « épais »), qui ne sont des insultes
 * qu'au Québec et seulement dans un certain ton.
 */
const HOSTILE_TERMS: readonly string[] = [
  // Nommer la chose
  "spam",
  "pourriel",
  "pourriels",
  "harcèlement",
  "harceler",
  "harcelez",
  "arnaque",
  "fraude",
  "escroc",
  "escroquerie",
  "porter plainte",
  "plainte",
  "je vais vous signaler",
  "harassment",
  "harassing",
  "scam",
  "fraud",
  "report you",
  // Demander l'arrêt avec colère
  "arrêtez de m'écrire",
  "arrêtez de m'envoyer",
  "arrêtez de me texter",
  "arrêtez de me contacter",
  "cessez de m'écrire",
  "ne m'écrivez plus",
  "ne me contactez plus",
  "ne me textez plus",
  "laissez-moi tranquille",
  "foutez-moi la paix",
  "stop texting me",
  "stop messaging me",
  "leave me alone",
  "go away",
  // Nier le consentement
  "je n'ai jamais demandé",
  "j'ai jamais demandé",
  "je n'ai rien demandé",
  "never signed up",
  "never asked",
  // Insultes courantes
  "va chier",
  "va te faire",
  "connard",
  "salaud",
  "salope",
  "imbécile",
  "idiot",
  "idiote",
  "crétin",
  "enculé",
  "tabarnak",
  "câlisse",
  "calisse",
  "crisse",
  "ostie",
  "fuck",
  "asshole",
  "bullshit",
  "piss off",
  "shut up",
];

const PROMO_MATCHERS = compileTerms(PROMO_TERMS_FR_EN);
const SHAFT_MATCHERS = compileTerms(SHAFT_TERMS);
const HOSTILE_MATCHERS = compileTerms(HOSTILE_TERMS);

/**
 * Vrai quand une réponse ENTRANTE porte de l'hostilité. Sert d'estimation du
 * taux de plainte, et le registre de constats a le devoir de le dire : présenter
 * une approximation comme une mesure est pire que de n'avoir aucune mesure.
 */
export function isHostileReply(body: string): boolean {
  const folded = fold(body);
  if (folded === "") return false;
  for (const matcher of HOSTILE_MATCHERS) {
    if (matcher.re.test(folded)) return true;
  }
  return false;
}

// ── Évasion ─────────────────────────────────────────────────────────────────

/**
 * Caractères invisibles. La politique de messagerie de Twilio les nomme
 * explicitement comme procédé d'évasion : glisser une largeur nulle au milieu
 * d'un mot casse la signature qu'un filtre cherche, sans rien changer à ce que
 * le destinataire lit. C'est du contournement, pas du style — d'où une gravité
 * de blocage, contrairement au reste de ce fichier.
 *
 * U+2060 (assembleur de mots) accompagne les quatre classiques : même invisible,
 * même effet.
 */
const INVISIBLE_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/gu;

/**
 * Mélange d'alphabets. Un « а » cyrillique (U+0430) ou un « ο » grec (U+03BF)
 * au milieu d'un mot latin est l'autre moitié du même procédé : le mot reste
 * lisible pour l'œil et cesse de correspondre pour la machine.
 *
 * On n'alarme que sur la CO-OCCURRENCE avec du latin — un message entièrement
 * grec ou cyrillique n'est pas une évasion, c'est une autre langue.
 */
const LATIN_LETTER_RE = /\p{Script=Latin}/u;
const CONFUSABLE_SCRIPT_RE = /[\p{Script=Cyrillic}\p{Script=Greek}]/gu;

/**
 * Émojis. `\p{Extended_Pictographic}` compte les points de code, pas les
 * grappes : un émoji de famille, assemblé par jointures de largeur nulle,
 * compte pour autant de pictogrammes qu'il en contient, et ©, ® et ™
 * appartiennent à la propriété et comptent pour un. Assumé : le chiffre sert à
 * repérer un message décoré à outrance, pas à dresser un inventaire exact.
 */
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

// ── L'analyse ───────────────────────────────────────────────────────────────

export interface ScanContext {
  /** Marques acceptées : nom de l'organisation, nom du courtier. */
  brandTokens: string[];
  /** Vrai quand ce corps est le PREMIER message d'un fil — seul cas où l'absence de STOP et de marque compte. */
  isOpener: boolean;
}

/**
 * Analyse un corps de message et rend des faits bruts.
 *
 * `ctx.isOpener` ne modifie AUCUN drapeau, et c'est délibéré : un scanner qui
 * adoucit un fait selon son contexte devient impossible à tester et impossible
 * à croire. La présence d'un STOP ou d'une marque est mesurée toujours de la
 * même façon ; c'est le registre de constats qui décide qu'une ABSENCE ne vaut
 * reproche que sur le premier message d'un fil — exiger la mention d'arrêt à
 * chaque tour d'une conversation entamée serait à la fois inutile et faux.
 */
export function scanBody(body: string, ctx: ScanContext): ContentFlags {
  const folded = fold(body);

  // Liens : la définition du garde-fou d'abord, le rattrapage raccourcisseur
  // ensuite, et seulement s'il n'est pas déjà contenu dans un lien trouvé
  // (« https://bit.ly/x » contient « bit.ly/x » — ce serait le même lien deux fois).
  const links = unique(body.match(URL_RE) ?? []);
  for (const bare of body.match(BARE_SHORTENER_RE) ?? []) {
    const lowered = bare.toLowerCase();
    if (links.some((link) => link.toLowerCase().includes(lowered))) continue;
    links.push(bare);
  }

  const shorteners = links.filter((link) => {
    const host = hostOf(link);
    return host !== null && isShortenerHost(host);
  });

  // Ton : mesuré sur le corps débarrassé de ce que la conformité impose d'écrire.
  const stripped = stripCompliance(body, ctx.brandTokens);
  let letters = 0;
  let uppercase = 0;
  let exclamations = 0;
  for (const char of stripped) {
    if (char === "!") exclamations += 1;
    if (!LETTER_RE.test(char)) continue;
    letters += 1;
    if (UPPERCASE_LETTER_RE.test(char)) uppercase += 1;
  }
  const capsRatio = letters < MIN_LETTERS_FOR_CAPS ? 0 : uppercase / letters;

  const evasionChars: string[] = body.match(INVISIBLE_RE) ?? [];
  if (LATIN_LETTER_RE.test(body)) {
    for (const confusable of body.match(CONFUSABLE_SCRIPT_RE) ?? []) evasionChars.push(confusable);
  }
  const evasion = unique(evasionChars).map(codePointLabel);

  // Encodage, segments et caractères fautifs viennent du moteur d'envoi
  // lui-même (`lintSms`, qui délègue à `analyzeSms`) : l'écran doit annoncer le
  // nombre de segments RÉELLEMENT facturé, pas une seconde estimation qui
  // dériverait de la première au premier ajustement de la table GSM 03.38.
  const lint = lintSms(body);

  return {
    mergeFields: unique(body.match(MERGE_FIELD_RE) ?? []),
    links,
    shorteners,
    hasOptOut: hasOptOutLanguage(body),
    hasBrand: ctx.brandTokens.some((token) => {
      const needle = fold(token);
      return needle !== "" && folded.includes(needle);
    }),
    capsRatio,
    exclamations,
    promoTerms: matchTerms(folded, PROMO_MATCHERS),
    shaftTerms: matchTerms(folded, SHAFT_MATCHERS),
    evasion,
    emoji: (body.match(EMOJI_RE) ?? []).length,
    encoding: lint.encoding,
    segments: lint.segments,
    ucs2Offenders: lint.warnings.map((warning) =>
      warning.suggestion === undefined
        ? { char: warning.char }
        : { char: warning.char, suggestion: warning.suggestion },
    ),
    // Points de code, pas unités UTF-16 : un émoji compte pour UN caractère aux
    // yeux de l'opérateur qui relit son message, et `body.length` en dirait deux.
    length: [...body].length,
  };
}
