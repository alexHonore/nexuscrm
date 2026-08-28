/**
 * Le SEUL endroit qui interprète un numéro d'erreur Twilio.
 *
 * Module PUR (règle du dossier) : aucun import Next.js, aucun accès base,
 * aucun réseau, aucune horloge. `tests/unit-deliverability-purity.test.ts`
 * fait échouer le build si l'un de ces interdits entre ici.
 *
 * Pourquoi centraliser : Twilio écrit noir sur blanc que `error_code` et
 * `error_message` « sont susceptibles de changer et ne devraient pas être
 * utilisés par programme ». On ne peut donc pas brancher une règle métier sur
 * un entier — mais on peut le NOMMER, le classer, et surveiller le déplacement
 * des TAUX par famille. Toute la page repose là-dessus : elle alerte sur un
 * mouvement de famille, jamais sur l'égalité à un code.
 *
 * ── Deux lectures d'un même code, et pourquoi elles diffèrent ───────────────
 *
 * `ERROR_CLASSES[code].family` répond à « qu'est-ce que ça VEUT DIRE » — c'est
 * ce qu'on montre à l'opérateur. Les listes `FILTERED_CODES`, `BLOCKED_CODES`,
 * `THROUGHPUT_CODES`… répondent à « qu'est-ce qui ENTRE dans tel indicateur » —
 * elles sont épinglées par `thresholds.ts`, dont les barres ont été calibrées
 * sur exactement ces codes.
 *
 * Les deux se recouvrent largement, mais PAS complètement, et c'est voulu :
 * 30039 (boucle de messages) est un filtrage, sauf qu'il frappe un message
 * ENTRANT — le compter dans `filtered_rate`, dont le dénominateur est le
 * sortant, fabriquerait un taux qui n'a aucun sens. 30017 est une congestion de
 * débit, mais elle n'existe qu'en MMS : la compter dans `throughput_blocks`
 * ajouterait un compteur qui ne bougera jamais. Un code doit pouvoir être bien
 * nommé sans pour autant nourrir une barre d'alerte.
 *
 * ── Ce qui n'est pas ici, et pourquoi ──────────────────────────────────────
 *
 * 30026, 30027 (dépréciés, Twilio ne les émet plus — 30023 les remplace),
 * 30010 (obsolète), 30044 (comptes d'essai), 30045 (validation de requête),
 * 63024 (WhatsApp uniquement), 30452 (formulaire de vérification sans frais)
 * et 30038 (corps OTP, comptes d'essai) sont ABSENTS volontairement. Une tuile
 * posée sur un code qui ne peut jamais se déclencher est pire que pas de tuile
 * du tout : elle affiche un zéro rassurant sur une surveillance qui n'existe
 * pas.
 */

// ── Familles ────────────────────────────────────────────────────────────────

/**
 * Ce que le code dit du refus. L'ordre est celui de la gravité de lecture :
 * un filtrage se travaille (contenu, réputation), une saturation s'attend.
 *
 * · `filtered`      — un filtre a jugé le CONTENU. Le signal de pourriel.
 * · `blocked`       — la LIGNE est fermée : désabonnement, liste noire.
 * · `invalid`       — le NUMÉRO n'existe pas ou n'est pas un mobile.
 * · `unreachable`   — le combiné n'a pas répondu. Voir C7 plus bas.
 * · `registration`  — refusé à la porte : le compte, le numéro ou la campagne
 *                     n'a pas le DROIT d'envoyer. Aucun contenu n'a été lu.
 * · `throughput`    — la file ou le débit sature. Ça repart tout seul.
 * · `content`       — ce que la campagne a DÉCLARÉ a été rejeté au visa A2P.
 *                     Seule famille qui n'apparaît jamais sur une rangée
 *                     `messages` : ces codes vivent dans `errors[]` de la
 *                     ressource Usa2p, pas sur un message.
 * · `carrier_other` — l'opérateur a refusé sans dire pourquoi.
 * · `platform`      — Twilio a échoué de son côté, ou un réglage de compte
 *                     ferme la destination.
 * · `other`         — code absent du catalogue. Jamais silencieux : on le
 *                     nomme quand même, avec son lien vers la doc.
 */
export const ERROR_FAMILIES = [
  "filtered",
  "blocked",
  "invalid",
  "unreachable",
  "registration",
  "throughput",
  "content",
  "carrier_other",
  "platform",
  "other",
] as const;
export type ErrorFamily = (typeof ERROR_FAMILIES)[number];

export interface ErrorClass {
  code: number;
  family: ErrorFamily;
  /**
   * Renvoyer le MÊME message plus tard peut-il réussir sans rien changer ?
   *
   * Twilio ne publie aucun drapeau « permanent / transitoire » : la valeur est
   * déduite du langage de remédiation de chaque page (« try sending again » →
   * vrai ; « do not retry », « complete registration », « contact Support » →
   * faux). Ce champ ne PILOTE rien dans cette page — il documente. Réessayer
   * automatiquement un 30007 aggrave la réputation du numéro, et c'est
   * précisément ce que le tableau de bord doit dissuader de faire.
   */
  retryable: boolean;
  /** URL de la doc Twilio. */
  doc: string;
  /** Libellé court NEUTRE (nom officiel Twilio, non traduit). */
  name: string;
}

/** Racine du dictionnaire d'erreurs — une page par code, même schéma d'URL. */
const DOC_BASE = "https://www.twilio.com/docs/api/errors/";

/** Le dictionnaire lui-même, quand on n'a pas de code à pointer. */
const DOC_INDEX = "https://www.twilio.com/docs/api/errors";

const catalogue = (
  entries: readonly (readonly [number, ErrorFamily, boolean, string])[],
): Record<number, ErrorClass> => {
  const out: Record<number, ErrorClass> = {};
  for (const [code, family, retryable, name] of entries) {
    out[code] = { code, family, retryable, doc: `${DOC_BASE}${code}`, name };
  }
  return out;
};

/**
 * Le catalogue, vérifié le 2026-08-27 contre docs.twilio.com pour un
 * expéditeur long code canadien vers des mobiles CA et US.
 */
export const ERROR_CLASSES: Record<number, ErrorClass> = catalogue([
  // ── filtered ──────────────────────────────────────────────────────────────
  /**
   * LE code. Twilio ou l'opérateur du destinataire a jugé le message
   * indésirable. C'est le seul signal de pourriel que Twilio nomme comme tel,
   * et l'empreinte canonique du filtrage transporteur est le couple
   * « statut `undelivered` + 30007 » — exactement les trois SID que le support
   * demande de rassembler avant d'ouvrir un dossier.
   */
  [30007, "filtered", false, "Message filtered"],
  /**
   * ENTRANT uniquement : Twilio a jugé le message reçu généré par une machine
   * et a supprimé l'appel de webhook pour couper une boucle de réponses
   * automatiques. Directement pertinent ici — on FAIT répondre un agent — mais
   * il ne rentre dans aucun taux sortant : voir l'en-tête sur famille ≠ liste.
   */
  [30039, "filtered", false, "Filtered to Prevent Message Loops"],

  // ── blocked ───────────────────────────────────────────────────────────────
  /**
   * Surchargé : liste noire du destinataire, désabonnement antérieur, ligne
   * fixe, ou filtrage interne de Twilio sur le contenu ou l'expéditeur. À
   * traiter comme une suppression tant qu'on n'a pas la preuve du contraire ;
   * seul un `START` du destinataire rouvre la ligne.
   */
  [30004, "blocked", false, "Message blocked"],
  /**
   * Le destinataire a répondu STOP. Refus à la CRÉATION du message, pas un
   * accusé de livraison : c'est la copie de Twilio de notre table
   * `suppressions`, et c'est elle qui fait autorité — elle s'applique quoi que
   * dise notre base.
   */
  [21610, "blocked", false, "Attempt to send to unsubscribed recipient"],

  // ── invalid ───────────────────────────────────────────────────────────────
  /** Numéro inconnu ou qui n'existe plus. Suppression définitive légitime. */
  [30005, "invalid", false, "Unknown destination handset"],
  /** Ligne fixe, ou opérateur injoignable par SMS. Ne jamais réessayer. */
  [30006, "invalid", false, "Landline or unreachable carrier"],
  /** Refus à la création : le « To » n'est pas un mobile. Voir `HARD_INVALID_CODES`. */
  [21614, "invalid", false, "'To' number is not a valid mobile number"],

  // ── unreachable ───────────────────────────────────────────────────────────
  /**
   * CONTRADICTION C7 — à lire avant de toucher à ce champ.
   *
   * Twilio documente 30003 comme TRANSITOIRE : un téléphone éteint, hors
   * couverture. La page ajoute pourtant « filtrage ou blocage côté opérateur
   * après des échecs répétés sur long code » parmi les causes, et conseille de
   * revoir le type d'expéditeur et le contenu. D'où le classement retenu ici :
   * `unreachable`, `retryable: true`, et un indicateur bâti sur la DÉRIVE
   * (`unreachable_delta`) plutôt que sur le niveau — un bruit de fond existe,
   * c'est sa hausse qui trahit un filtrage déguisé.
   *
   * NOTRE MOTEUR N'EST PAS D'ACCORD. `src/lib/sms/status.ts` range 30003 dans
   * `HARD_FAILURE_CODES`, et `recordDeliveryOutcome` écrit alors une rangée
   * `suppressions` DÉFINITIVE sur le numéro. Conséquence concrète : un client
   * dont le téléphone était éteint une fois ne sera plus jamais texté par ce
   * CRM, sans que personne ne l'ait décidé et sans chemin de retour dans
   * l'interface. C'est pour ça que le constat `harsh_suppression_30003` est
   * structurel et permanent : il ne signale pas une donnée qui dérape, il
   * signale une divergence entre ce fichier et le moteur d'envoi. Corriger le
   * moteur, pas cette ligne — sinon on efface la seule trace du problème.
   */
  [30003, "unreachable", true, "Unreachable destination handset"],
  /** Le combiné n'a jamais confirmé la réception. Réessayer après un délai. */
  [30046, "unreachable", true, "Message delivery not confirmed"],

  // ── registration ──────────────────────────────────────────────────────────
  /**
   * Suspension du COMPTE, entre la mise en file et l'envoi. Les causes vont de
   * la violation de la politique d'usage au simple échec de paiement — vérifier
   * la facturation avant de conclure à un problème de réputation.
   */
  [30002, "registration", false, "Account suspended"],
  /**
   * L'opérateur de destination exige un expéditeur numérique pré-enregistré et
   * celui-ci ne l'est pas encore : 10DLC en cours, sans frais non vérifié,
   * numéro fraîchement porté.
   */
  [30024, "registration", true, "Numeric Sender ID Not Provisioned on Carrier"],
  /**
   * Vise les abonnés US ET CANADIENS : depuis le 2024-01-31, un numéro sans
   * frais en statut `Restricted` ou `Pending` est bloqué. Ne concerne ce CRM
   * que le jour où un numéro sans frais entrerait dans le bassin.
   */
  [30032, "registration", false, "Toll-Free Number Has Not Been Verified"],
  /**
   * Suspension de la campagne A2P APRÈS approbation — la liste des
   * déclencheurs est la taxonomie complète du pourriel. Ne jamais rerouter le
   * même trafic par une autre campagne : la doc qualifie ça de violation grave
   * qui met le compte en jeu.
   */
  [30033, "registration", false, "US A2P 10DLC - Campaign Suspended"],
  /**
   * Bloquant depuis le 2023-09-01, et STRICTEMENT sur destination américaine.
   * Voir C8 : pour un courtier qui n'écrit qu'au Québec, ce code est
   * structurellement impossible. S'il apparaît, le constat à lever est « vous
   * textez des mobiles américains », pas « enregistrez une marque ».
   */
  [30034, "registration", false, "US A2P 10DLC - Message from an Unregistered Number"],
  /**
   * Numéro en cours d'inscription. Attendre jusqu'à 24 h ; surtout ne pas le
   * retirer puis le remettre, ça relance l'inscription à zéro.
   */
  [30035, "registration", true, "US A2P 10DLC - Message from a number still being configured"],
  /** Le (sous-)compte porteur des identifiants n'a pas le droit d'émettre. */
  [30037, "registration", false, "Outbound Messaging Disabled"],

  // ── throughput ────────────────────────────────────────────────────────────
  /**
   * Soumis plus vite que le débit de l'expéditeur. Twilio garde en file 10 h au
   * maximum, puis échoue. La ligne de base d'un long code américain est d'UN
   * segment par seconde — c'est peu, et c'est le mur qu'on touche en premier.
   */
  [30001, "throughput", true, "Queue overflow"],
  /**
   * Congestion MMS chez l'opérateur aval. Ce CRM n'envoie que du SMS : classé
   * pour être nommé s'il apparaît, jamais compté dans `THROUGHPUT_CODES`.
   */
  [30017, "throughput", true, "Carrier network congestion"],
  /**
   * Débit de la campagne enregistrée dépassé, agrégé sur TOUS ses numéros. Se
   * déclenche aussi sur trop de messages vers UN même destinataire en peu de
   * temps — le piège exact d'un agent qui répond vite.
   */
  [30022, "throughput", true, "US A2P 10DLC - Rate Limits Exceeded"],
  /**
   * Plafond quotidien T-Mobile de la marque consommé, compté par numéro
   * d'entreprise à travers TOUS les fournisseurs, pas seulement Twilio.
   * Remise à zéro à minuit, heure du Pacifique.
   */
  [30023, "throughput", true, "US A2P 10DLC - Daily Message Cap Reached"],
  /**
   * Le message a attendu en file au-delà de son `ValidityPeriod`. Ce n'est pas
   * un signal de pourriel : c'est le 30001 vu depuis l'autre bout de la même
   * file, et il compte donc avec lui.
   */
  [30036, "throughput", true, "Validity Period Expired"],
  /**
   * SMS Pumping Protection a jugé la demande suspecte et bloqué TEMPORAIREMENT
   * cette destination — « typiquement 15 à 30 minutes », prolongé si le motif
   * persiste. Laisser la fenêtre expirer ; chercher la rafale qui l'a déclenché.
   */
  [30450, "throughput", true, "Message delivery blocked"],
  /**
   * Détection de fraude : trafic inhabituel vers cette destination. Twilio
   * reconnaît le risque de faux positif. Réessayer après plusieurs heures.
   */
  [30453, "throughput", true, "Message couldn't be delivered"],
  /** Limites de Twilio dépassées vers une destination donnée. Attendre. */
  [30454, "throughput", true, "Account exceeded the messages limit"],
  /**
   * Refus à la CRÉATION : la file de ce numéro expéditeur est déjà pleine, le
   * message n'est même pas mis en attente. Même remède que 30001.
   */
  [21611, "throughput", true, "This 'From' number has exceeded the maximum number of queued messages"],

  // ── content ───────────────────────────────────────────────────────────────
  // Ces six-là ne se posent JAMAIS sur une rangée `messages` : ils arrivent
  // dans `errors[]` de la ressource Usa2p quand `campaign_status = FAILED`, et
  // c'est la sonde A2P qui les lit. Ils sont ici pour être nommés en français
  // sur la carte Twilio plutôt que rendus en « code 30892 ».
  [30883, "content", false, "Campaign vetting rejection - Content Violation"],
  [30884, "content", false, "Campaign vetting rejection - Spam/Phishing"],
  [30885, "content", false, "Campaign vetting rejection - High Risk"],
  [30886, "content", false, "Campaign vetting rejection - Invalid Campaign Description"],
  /** bit.ly, TinyURL & compagnie dans les exemples — le raccourcisseur public. */
  [30892, "content", false, "Campaign vetting rejection - Invalid Sample Message - Public URL Shorteners"],
  [30893, "content", false, "Campaign vetting rejection - Inconsistency between Sample Message and Use-case"],

  // ── carrier_other ─────────────────────────────────────────────────────────
  /**
   * Échec aval sans détail. La doc liste « le réseau de destination rejette
   * l'expéditeur » parmi les causes : une CONCENTRATION de 30008 peut donc
   * être du filtrage silencieux. D'où sa présence dans `TOTAL_ERROR_CODES`
   * alors que sa famille reste « on ne sait pas ».
   */
  [30008, "carrier_other", true, "Unknown error"],
  /**
   * Restriction d'identifiant expéditeur dans le pays de destination, ou aucune
   * connectivité Twilio vers ce réseau. En CA→CA/US, c'est presque toujours un
   * mauvais « From ».
   */
  [21612, "carrier_other", false, "Message cannot be sent with the current combination of 'To' and/or 'From' parameters"],

  // ── platform ──────────────────────────────────────────────────────────────
  /** Interruption ou délai chez le fournisseur aval. Twilio ne réessaie PAS. */
  [30410, "platform", true, "Provider Timeout Error"],
  /** Panne côté Twilio. Renvoyer, vérifier la page d'état. */
  [30500, "platform", true, "Twilio Internal Error"],
  /**
   * Le pays de destination est désactivé dans les permissions géographiques du
   * compte. Rien à voir avec du pourriel — c'est une case à cocher dans la
   * console, et elle se ferme parfois toute seule après un changement de plan.
   */
  [21408, "platform", false, "Message blocked: permissions disabled for the destination region"],
]);

/** Tous les codes catalogués — sert aux tests et à l'inventaire, pas au calcul. */
export const KNOWN_ERROR_CODES: readonly number[] = Object.keys(ERROR_CLASSES)
  .map((k) => Number(k))
  .sort((a, b) => a - b);

/**
 * Classe un code. NE LÈVE JAMAIS, et ne renvoie jamais `undefined` : un code
 * inconnu ressort en famille « other » avec son lien vers la doc Twilio, parce
 * que le dictionnaire d'erreurs bouge et qu'un code non catalogué doit rester
 * cliquable au lieu de disparaître de l'écran.
 */
export function classifyErrorCode(code: number | null | undefined): ErrorClass {
  if (code === null || code === undefined || !Number.isInteger(code) || code <= 0) {
    return { code: 0, family: "other", retryable: false, doc: DOC_INDEX, name: "Unknown error" };
  }
  const known = ERROR_CLASSES[code];
  if (known) return known;
  return { code, family: "other", retryable: false, doc: `${DOC_BASE}${code}`, name: `Twilio ${code}` };
}

// ── Les listes qui nourrissent les indicateurs ──────────────────────────────
//
// Écrites à la main plutôt que dérivées des familles : `thresholds.ts` a
// calibré ses barres sur EXACTEMENT ces codes, et une famille qui gagne un
// membre demain déplacerait silencieusement un seuil. Le test
// `unit-deliverability-errors.test.ts` vérifie que chaque code listé ici existe
// bien dans `ERROR_CLASSES` — un chiffre tapé de travers ne compterait rien du
// tout, et un compteur à zéro se lit comme « tout va bien ».
//
// Réserve commune à toutes ces listes : la file d'envoi n'écrit un `error_code`
// que sur un accusé de livraison. Un refus SYNCHRONE de Twilio (21610, 21611,
// 21614…) fait passer `handleSendSms` par `TwilioSendError`, qui écrit
// `status: "failed"` et un `skip_reason` textuel SANS `twilio_sid` ni
// `error_code` — la rangée sort donc du dénominateur « remis à Twilio ». Ces
// codes restent listés parce que la réconciliation REST peut les rapporter et
// parce que le jour où quelqu'un persistera `TwilioSendError.code`, les
// indicateurs les compteront sans qu'il faille y repenser.

/** 30007 — le filtrage pur. Aucun autre code Twilio ne dit « pourriel ». */
export const FILTERED_CODES: readonly number[] = [30007];

/** La ligne est fermée : liste noire de l'opérateur, ou STOP côté Twilio. */
export const BLOCKED_CODES: readonly number[] = [30004, 21610];

/**
 * 30005 / 30006 — la LISTE est en cause, pas les messages : numéros achetés,
 * périmés ou mal saisis. Les opérateurs lisent ça comme du ratissage.
 *
 * 21614 est de la même nature mais reste DEHORS : c'est un refus à la création,
 * jamais un accusé de livraison, donc il n'appartient pas à un taux dont le
 * dénominateur est « ce que Twilio a accepté ». L'y glisser gonflerait le
 * numérateur sans toucher au dénominateur.
 */
export const HARD_INVALID_CODES: readonly number[] = [30005, 30006];

/** 30003 seul — l'indicateur qui le lit mesure une DÉRIVE, pas un niveau (C7). */
export const UNREACHABLE_CODES: readonly number[] = [30003];

/**
 * Refusé à la porte. Pour un envoi Canada→Canada, TOUS ces codes devraient
 * être structurellement impossibles : il n'existe aucun registre canadien à
 * remplir. Un seul de ces codes qui se déclenche dit donc quelque chose sur la
 * DESTINATION du trafic, pas sur une paperasse oubliée — d'où le seuil à zéro.
 */
/**
 * 30002 n'est PAS ici, et c'est délibéré : « Account suspended » est un compte
 * fermé, pas une marque non enregistrée. Rangé parmi les refus d'inscription,
 * il déclenchait le constat « inscrivez votre marque A2P » — un formulaire
 * inutile pendant qu'un compte suspendu bloque tout. Il compte dans le taux
 * d'erreur global (`TOTAL_ERROR_CODES`) et c'est la sonde de compte Twilio qui
 * le diagnostique, avec le bon geste.
 */
export const REGISTRATION_CODES: readonly number[] = [30034, 30032, 30033, 30037, 30035, 30024];

/**
 * File ou débit saturé. Rien de honteux en soi, mais des occurrences soutenues
 * ressemblent, vues du réseau, à de l'arrosage — et c'est ainsi que ça se
 * juge. 30017 en est absent : congestion MMS, or on n'envoie que du SMS.
 */
export const THROUGHPUT_CODES: readonly number[] = [
  30001,
  21611,
  30022,
  30023,
  30036,
  30450,
  30453,
  30454,
];

/**
 * L'union qui fait `total_error_rate` — délibérément PLUS ÉTROITE que « tous
 * les codes ». On y met ce qui témoigne de la santé de la LISTE et de la
 * réputation du numéro : injoignable, invalide, filtré, refusé, désabonné.
 *
 * Ce qui en est exclu l'est pour ne pas noyer le signal : une saturation de
 * file (30001) ou une panne Twilio (30500) fait un mauvais chiffre sans rien
 * dire de la qualité du trafic, et un taux d'erreur global qui monte les jours
 * de panne apprend à l'opérateur à ignorer le taux d'erreur global.
 *
 * 30004 y figure aux côtés de 21610, son jumeau : les deux disent « ce
 * destinataire ne recevra pas », l'un par décision de l'opérateur, l'autre par
 * désabonnement. N'en compter qu'un laissait un numéro dont TOUT le trafic
 * revenait bloqué afficher un taux d'erreur global sain — un faux « rien à
 * signaler » sur l'écran qui existe pour empêcher exactement ça. Compter en
 * trop coûte une alerte de plus ; compter en moins coûte une réputation.
 */
export const TOTAL_ERROR_CODES: readonly number[] = [
  30002, 30003, 30004, 30005, 30006, 30007, 30008, 21610,
];
