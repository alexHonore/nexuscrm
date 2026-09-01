import { classifyErrorCode, type ErrorFamily } from "./error-classes";
import { ERROR_TEXT_EN, FAMILY_TEXT_EN } from "./error-text.en";
import type { DocLocale } from "@/lib/docs/types";

/**
 * Ce qu'un code d'erreur Twilio VEUT DIRE, en français — module PUR.
 *
 * `./error-classes` sait déjà tout classer : la famille, le caractère
 * réessayable, le lien vers la doc, et un nom officiel — en anglais, écrit par
 * Twilio pour des ingénieurs Twilio (« Unknown destination handset »). Ce
 * fichier écrit l'autre moitié, celle qui manquait à l'écran : le mot que la
 * téléphoniste lit sur la rangée d'un échec, et la phrase qui lui dit s'il faut
 * corriger un téléphone, réécrire un message, ou simplement attendre.
 *
 * Ce qui se passait sans lui : l'onglet « Échecs » affichait « 30007 » et rien
 * d'autre. Un nombre ne dit ni ce qui a échoué, ni si réessayer sert à quelque
 * chose — alors on rappelait le contact pour lui demander s'il avait reçu le
 * texto, ce qui est exactement le travail que ce CRM devait épargner.
 *
 * Deux champs, jamais trois. `label` tient dans une pastille — deux ou trois
 * mots, lisibles à côté d'une date. `why` tient en UNE phrase : ce que ça veut
 * dire et, quand il y en a un, le geste. Le chantier de fond — réputation du
 * numéro, contenu des gabarits, inscription A2P — appartient aux constats de
 * `./findings`, qui ont trois champs et de la place pour argumenter. Ici on
 * NOMME un échec, on n'ouvre pas un dossier.
 *
 * Module PUR (règle du dossier) : `tests/unit-deliverability-purity.test.ts`
 * fait échouer le build sur un import Next, une base, un réseau ou une horloge.
 * La langue arrive donc en PARAMÈTRE, comme pour `findingText()` — c'est ce qui
 * permet à une carte serveur et à un composant client d'appeler la même
 * fonction sans que l'un des deux tire next-intl dans son paquet.
 *
 * Le français est la SOURCE : il décide quelles entrées existent. L'anglais est
 * une surcouche de MOTS dans `./error-text.en`, exactement comme
 * `messages/<locale>/<ns>.json`, et `tests/unit-docs-locale.test.ts` fait
 * échouer le build sur une entrée non traduite.
 *
 * Enfin : un code ABSENT du catalogue ne tombe jamais dans le silence. Le
 * dictionnaire d'erreurs de Twilio bouge, et une rangée d'échec qui n'afficherait
 * rien du tout se lirait comme une rangée sans problème. La FAMILLE parle alors
 * à la place du code, et le lien vers la doc reste cliquable.
 */

/** Le texte d'un échec dans UNE langue, sans suffixe. */
export interface FailureText {
  /** COURT — tient dans une pastille à côté d'une date. */
  label: string;
  /** UNE phrase : ce que ça veut dire pour la personne qui appelle. */
  why: string;
}

/**
 * Un échec prêt à afficher : la langue est déjà tranchée, et tout ce que la
 * rangée doit montrer tient dans cet objet — le code pour le support Twilio,
 * la famille pour le regroupement, `retryable` pour tempérer un bouton.
 *
 * `retryable` DOCUMENTE, il n'interdit rien : « Réessayer » est offert sur
 * chaque échec, y compris sur un 30007 qui échouera de nouveau, parce qu'entre
 * les deux tentatives quelqu'un a pu corriger le téléphone sur la fiche.
 */
export interface ResolvedFailure {
  /** Le code Twilio, ou null quand l'échec n'en portait aucun. */
  code: number | null;
  family: ErrorFamily;
  retryable: boolean;
  /** Doc Twilio — jamais traduite. */
  doc: string;
  label: string;
  why: string;
}

/**
 * Un code, un mot. L'ordre suit celui de `./error-classes` — les deux fichiers
 * se relisent côte à côte, et une entrée qui manque saute aux yeux.
 */
export const ERROR_TEXT: Record<number, FailureText> = {
  // ── filtered ──────────────────────────────────────────────────────────────

  30007: {
    label: "Filtré par l'opérateur",
    why: "Un opérateur a jugé le message indésirable et l'a jeté sans jamais le remettre ; renvoyer le même texte creuse la réputation du numéro expéditeur, réécrivez-le d'abord.",
  },
  30039: {
    label: "Boucle de réponses coupée",
    why: "Twilio a pris le message reçu pour une réponse de machine et a coupé l'échange, pour éviter deux automates qui se répondent sans fin.",
  },

  // ── blocked ───────────────────────────────────────────────────────────────

  30004: {
    label: "Message bloqué",
    why: "La ligne est fermée de l'autre côté — liste noire de l'opérateur, désabonnement antérieur ou filtre interne de Twilio ; seul un START envoyé par le destinataire la rouvre.",
  },
  21610: {
    label: "Désabonné",
    why: "Ce numéro a répondu STOP : Twilio refuse l'envoi avant même de le tenter, et plus rien ne partira vers lui tant qu'il n'aura pas écrit START.",
  },

  // ── invalid ───────────────────────────────────────────────────────────────

  30005: {
    label: "Numéro inexistant",
    why: "Le réseau ne connaît pas ce numéro, ou ne le connaît plus ; corrigez le téléphone sur la fiche, il n'y a rien à réessayer tel quel.",
  },
  30006: {
    label: "Ligne fixe",
    why: "C'est une ligne fixe, ou un opérateur qui n'achemine pas le SMS : ce téléphone ne recevra jamais de texto, quel que soit le message.",
  },
  21614: {
    label: "Pas un mobile",
    why: "Twilio a refusé l'envoi dès la création parce que le numéro inscrit sur la fiche n'est pas une ligne mobile — c'est la fiche qu'il faut corriger.",
  },

  // ── unreachable ───────────────────────────────────────────────────────────

  30003: {
    label: "Numéro injoignable",
    why: "Le combiné n'a pas répondu — éteint, hors de portée, ou écarté par l'opérateur après des échecs répétés ; une nouvelle tentative plus tard a de bonnes chances de passer.",
  },
  30046: {
    label: "Remise non confirmée",
    why: "Le message est parti mais le combiné n'a jamais confirmé l'avoir reçu ; réessayer après un délai est le seul moyen d'en avoir le cœur net.",
  },

  // ── registration ──────────────────────────────────────────────────────────

  30002: {
    label: "Compte suspendu",
    why: "Le compte Twilio a été suspendu entre la mise en file et l'envoi ; vérifiez d'abord la facturation, une carte refusée produit exactement ce code.",
  },
  30024: {
    label: "Expéditeur non provisionné",
    why: "L'opérateur du destinataire exige un numéro expéditeur pré-enregistré et celui-ci ne l'est pas encore — inscription en cours, ou numéro fraîchement porté.",
  },
  30032: {
    label: "Sans frais non vérifié",
    why: "Le numéro sans frais utilisé pour l'envoi est encore en attente de vérification ; depuis 2024, les opérateurs bloquent ce trafic, mobiles canadiens compris.",
  },
  30033: {
    label: "Campagne A2P suspendue",
    why: "La campagne A2P déclarée chez Twilio a été suspendue après son approbation ; ne rebasculez surtout pas le même trafic sur une autre campagne, Twilio y voit une violation grave.",
  },
  30034: {
    label: "Numéro non inscrit A2P",
    why: "L'envoi visait un mobile américain depuis un numéro absent du registre A2P 10DLC ; pour un courtier qui n'écrit qu'au Québec, ce code dit qu'un numéro américain s'est glissé dans la liste.",
  },
  30035: {
    label: "Inscription en cours",
    why: "Le numéro expéditeur termine son inscription : laissez passer jusqu'à 24 h et ne le retirez pas du service, ça relancerait l'inscription à zéro.",
  },
  30037: {
    label: "Envoi désactivé",
    why: "Le sous-compte Twilio qui porte les identifiants n'a pas le droit d'émettre : c'est un réglage de compte, rien à voir avec le destinataire.",
  },

  // ── throughput ────────────────────────────────────────────────────────────

  30001: {
    label: "File saturée",
    why: "Plus de messages ont été poussés que le numéro ne peut en écouler — environ un par seconde ; l'envoi a attendu en file puis a été abandonné, il passera si les départs sont étalés.",
  },
  30017: {
    label: "Congestion opérateur",
    why: "Le réseau aval était congestionné au moment de la remise ; rien à corriger de notre côté, l'envoi repasse de lui-même plus tard.",
  },
  30022: {
    label: "Débit A2P dépassé",
    why: "Le débit de la campagne enregistrée a été dépassé, tous ses numéros confondus — souvent parce que trop de messages sont partis vers un même destinataire en peu de temps.",
  },
  30023: {
    label: "Plafond quotidien atteint",
    why: "Le plafond quotidien de la marque chez T-Mobile est consommé ; il se remet à zéro à minuit, heure du Pacifique.",
  },
  30036: {
    label: "Expiré en file",
    why: "Le message a attendu en file au-delà de sa durée de validité et a été abandonné avant d'être remis : c'est la file qui bouchonne, pas le destinataire.",
  },
  30450: {
    label: "Envoi retenu (antifraude)",
    why: "La protection anti-pompage de Twilio a bloqué temporairement cette destination, en général 15 à 30 minutes ; cherchez la rafale qui l'a déclenchée plutôt que de renvoyer tout de suite.",
  },
  30453: {
    label: "Trafic jugé suspect",
    why: "La détection de fraude de Twilio a trouvé le trafic vers cette destination inhabituel ; les faux positifs existent, réessayez dans quelques heures.",
  },
  30454: {
    label: "Limite de compte atteinte",
    why: "Le compte a dépassé le nombre de messages que Twilio accepte vers cette destination ; il n'y a rien d'autre à faire qu'attendre.",
  },
  21611: {
    label: "File du numéro pleine",
    why: "La file du numéro expéditeur débordait déjà : le message a été refusé à la création, pas même mis en attente. Même remède qu'une file saturée, étaler les départs.",
  },

  // ── content ───────────────────────────────────────────────────────────────
  // Ces six-là ne se posent jamais sur un message : ils vivent sur la campagne
  // A2P déclarée chez Twilio. Ils sont nommés ici pour que la carte Twilio dise
  // autre chose que « code 30892 ».

  30883: {
    label: "Contenu refusé (A2P)",
    why: "Le visa de la campagne A2P a été refusé pour violation de contenu : ce code porte sur la campagne déclarée chez Twilio, jamais sur un message précis.",
  },
  30884: {
    label: "Campagne jugée pourriel",
    why: "Le visa A2P a classé la campagne comme pourriel ou hameçonnage : c'est la déclaration de campagne qu'il faut réécrire, pas le message.",
  },
  30885: {
    label: "Campagne à haut risque",
    why: "Le visa A2P a jugé l'usage déclaré trop risqué ; la correction se fait dans la déclaration de campagne, chez Twilio.",
  },
  30886: {
    label: "Description invalide",
    why: "La description d'usage déposée au visa A2P est trop vague ou incohérente ; il faut la rédiger de nouveau dans la console Twilio.",
  },
  30892: {
    label: "Lien raccourci public",
    why: "Le message d'exemple déposé au visa A2P contenait un raccourcisseur public (bit.ly, TinyURL) : les opérateurs les bloquent d'office, mettez l'adresse complète.",
  },
  30893: {
    label: "Exemple hors sujet",
    why: "Le message d'exemple déposé au visa A2P ne correspond pas à l'usage déclaré ; les deux doivent raconter la même chose.",
  },

  // ── carrier_other ─────────────────────────────────────────────────────────

  30008: {
    label: "Refus sans motif",
    why: "L'opérateur aval a refusé sans dire pourquoi ; un cas isolé ne veut rien dire, mais une concentration de ce code est souvent du filtrage qui ne s'annonce pas.",
  },
  21612: {
    label: "Expéditeur incompatible",
    why: "Cette combinaison de numéro expéditeur et de destinataire n'est pas acheminable ; d'un numéro canadien vers le Canada ou les États-Unis, c'est presque toujours un mauvais expéditeur.",
  },

  // ── platform ──────────────────────────────────────────────────────────────

  30410: {
    label: "Délai du fournisseur",
    why: "Le fournisseur aval a mis trop de temps à répondre et Twilio ne réessaie pas de lui-même : renvoyer le message est ici la bonne réaction.",
  },
  30500: {
    label: "Panne Twilio",
    why: "L'erreur vient de Twilio, pas du destinataire ; renvoyez le message, et allez voir la page d'état si ça se répète.",
  },
  21408: {
    label: "Pays désactivé",
    why: "Le pays du destinataire est désactivé dans les permissions géographiques du compte Twilio — une case à cocher dans la console, qui se referme parfois seule après un changement de forfait.",
  },
};

/**
 * La famille, quand il n'y a pas de code — ou quand le code est trop neuf pour
 * être ici. Ce texte est alors affiché TEL QUEL sur la rangée : il doit donc se
 * suffire à lui-même, sans supposer qu'un numéro l'accompagne.
 */
export const FAMILY_TEXT: Record<ErrorFamily, FailureText> = {
  filtered: {
    label: "Filtré comme indésirable",
    why: "Un filtre a jugé le CONTENU et jeté le message ; c'est la réputation du numéro expéditeur qui le paie, pas le message fautif.",
  },
  blocked: {
    label: "Ligne fermée",
    why: "Le destinataire ou son opérateur refuse cette ligne ; seul le destinataire peut la rouvrir.",
  },
  invalid: {
    label: "Numéro invalide",
    why: "Le numéro n'existe pas ou ne peut pas recevoir de texto : c'est la fiche qu'il faut corriger, pas le message.",
  },
  unreachable: {
    label: "Injoignable",
    why: "Le combiné n'a pas répondu ; le même envoi peut très bien passer plus tard.",
  },
  registration: {
    label: "Expéditeur non autorisé",
    why: "Refusé à la porte : le compte, le numéro ou la campagne n'avait pas le droit d'envoyer, et le contenu du message n'a même pas été lu.",
  },
  throughput: {
    label: "Débit saturé",
    why: "La file ou le débit d'envoi sature ; ça repart tout seul dès que les départs s'étalent.",
  },
  content: {
    label: "Campagne refusée",
    why: "Le visa A2P a refusé ce qui a été déclaré : le code appartient à la campagne chez Twilio, jamais à un message.",
  },
  carrier_other: {
    label: "Refus de l'opérateur",
    why: "L'opérateur a refusé sans donner de raison ; seule une accumulation de ces refus dit quelque chose.",
  },
  platform: {
    label: "Panne ou réglage Twilio",
    why: "Twilio a échoué de son côté, ou un réglage du compte ferme cette destination.",
  },
  other: {
    label: "Erreur inconnue",
    why: "Ce code est absent du catalogue ; le dictionnaire d'erreurs de Twilio le décrit.",
  },
};

/**
 * Le français est la source, l'anglais une surcouche par clé. Une traduction
 * manquante RETOMBE sur le français plutôt que d'afficher un vide : lire la
 * raison dans l'autre langue reste infiniment plus utile que de ne rien lire,
 * et le test de parité fait de toute façon échouer le build.
 */
function pick(fr: FailureText, en: FailureText | undefined, locale: DocLocale): FailureText {
  if (locale === "fr" || !en) return fr;
  return { label: en.label || fr.label, why: en.why || fr.why };
}

/**
 * Le texte d'un code, dans la langue de l'ÉCRAN.
 *
 * NE LÈVE JAMAIS, comme `classifyErrorCode()` dont elle hérite la discipline :
 * pas de code, code inconnu, code négatif — il en sort toujours une pastille
 * remplie et un lien vers la doc. Une rangée d'échec muette se lit comme une
 * rangée sans échec, et c'est la seule chose que cet écran n'a pas le droit de
 * faire.
 *
 * À ne pas confondre avec la langue de l'ASSISTANT (règle 14 du dépôt) : rien
 * d'ici n'entre dans un prompt ni dans un SMS. Ce sont des mots pour la
 * personne qui regarde l'écran.
 */
export function errorCodeText(
  code: number | null | undefined,
  locale: DocLocale,
): ResolvedFailure {
  const cls = classifyErrorCode(code);
  const fr = ERROR_TEXT[cls.code];
  const text = fr ? pick(fr, ERROR_TEXT_EN[cls.code], locale) : errorFamilyText(cls.family, locale);
  return {
    // `classifyErrorCode` rend 0 quand il n'y avait rien à classer ; l'écran,
    // lui, doit distinguer « aucun code » de « code 0 » pour ne pas afficher
    // « Code 0 » sous un échec qui n'a jamais atteint Twilio.
    code: cls.code > 0 ? cls.code : null,
    family: cls.family,
    retryable: cls.retryable,
    doc: cls.doc,
    label: text.label,
    why: text.why,
  };
}

/** La FAMILLE seule, pour une pastille quand il n'y a aucun code à montrer. */
export function errorFamilyText(family: ErrorFamily, locale: DocLocale): FailureText {
  const fr = FAMILY_TEXT[family] ?? FAMILY_TEXT.other;
  return pick(fr, FAMILY_TEXT_EN[family], locale);
}
