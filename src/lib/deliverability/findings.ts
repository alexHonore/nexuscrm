import { FINDING_TEXT_EN } from "./findings.en";
import type {
  DeepLinkKind,
  FindingFamily,
  FindingId,
  FindingSeverity,
  MetricId,
} from "./types";
import type { DocLocale } from "@/lib/docs/types";

/**
 * Le catalogue des constats de délivrabilité, en français — module PUR.
 *
 * Un tableau de bord qui affiche « taux 30007 : 1,4 % » ne fait rien avancer :
 * il faut savoir quel opérateur s'en soucie, ce que ça coûte, et QUEL geste
 * pose la correction aujourd'hui. Les trois textes d'une entrée répondent
 * exactement à ça, dans cet ordre : ce qui ne va pas, pourquoi c'est grave
 * dehors, et l'unique action à faire.
 *
 * Trois disciplines tiennent ce fichier, et les enfreindre le rend nuisible :
 *
 *  · **On ne blanchit pas un repère de fournisseur en règle d'opérateur.**
 *    Presque aucun opérateur nord-américain ne publie ses barres. Quand le
 *    chiffre vient d'un guide de fournisseur ou de notre exploitation, le
 *    texte le DIT. Le jour où un seuil est contesté, personne ne doit avoir à
 *    deviner lequel était sourcé — `sourceUrl` porte la référence quand elle
 *    existe, et elle n'est jamais traduite.
 *  · **Une seule action par constat, à l'impératif, faisable aujourd'hui.**
 *    « Envisagez d'améliorer votre réputation » n'est pas une correction.
 *  · **Aucune notion de consentement** (règle 12 du dépôt, décision de
 *    l'exploitant du 2026-08-22). Les seules barrières qui existent ici sont
 *    le désabonnement (table `suppressions`, mot-clé STOP) et `doNotCall`.
 *
 * Trois constats sont STRUCTURELS : ils ne se déduisent pas des chiffres mais
 * de la forme du code, ils seront donc vrais tant que le code n'aura pas
 * changé — `ladder_body_unguarded`, `harsh_suppression_30003` et
 * `dispatch_cron_daily`. Ce sont les plus utiles de la page, parce que
 * personne d'autre ne les dira jamais.
 *
 * Le français est la SOURCE : il décide quels constats existent. L'anglais est
 * une surcouche de MOTS dans `./findings.en`, exactement comme
 * `messages/<locale>/<ns>.json`, et `tests/unit-docs-locale.test.ts` fait
 * échouer le build sur une entrée non traduite.
 */

export interface FindingDoc {
  id: FindingId;
  family: FindingFamily;
  /** Sévérité de BASE ; le calcul peut l'escalader, jamais l'adoucir. */
  severity: FindingSeverity;
  /** L'indicateur qui déclenche, ou null pour un constat structurel. */
  metric: MetricId | null;
  targetKind: DeepLinkKind;
  labelFr: string;
  whyFr: string;
  fixFr: string;
  /** Doc Twilio/CTIA — jamais traduite. */
  sourceUrl?: string;
  orderIndex: number;
}

/** Le texte d'un constat dans UNE langue, sans suffixe. */
export interface FindingText {
  label: string;
  why: string;
  fix: string;
}

// ── Références externes ─────────────────────────────────────────────────────
// Nommées une fois : une URL recopiée dans quinze entrées devient quinze URL
// différentes à la première mise à jour.

const CTIA_BEST_PRACTICES =
  "https://api.ctia.org/wp-content/uploads/2023/05/230523-CTIA-Messaging-Principles-and-Best-Practices-FINAL.pdf";
const TWILIO_MESSAGING_POLICY = "https://www.twilio.com/en-us/legal/messaging-policy";
const TWILIO_A2P = "https://www.twilio.com/docs/messaging/compliance/a2p-10dlc";
const TWILIO_STATUS_CALLBACK =
  "https://www.twilio.com/docs/messaging/guides/track-outbound-message-status";
const twilioError = (code: number) => `https://www.twilio.com/docs/api/errors/${code}`;

// L'ordre de déclaration EST l'ordre de lecture de la page : est-ce arrivé,
// qui a dit stop, quelle forme a le trafic, que dit le texte, la machine
// tourne-t-elle. Un compteur plutôt qu'un nombre écrit à la main — insérer une
// entrée au milieu ne doit pas obliger à renuméroter les quarante suivantes.
let order = 0;
const entry = (d: Omit<FindingDoc, "orderIndex">): FindingDoc => ({ ...d, orderIndex: (order += 1) });

export const FINDING_DOCS: Record<FindingId, FindingDoc> = {
  // ── Est-ce arrivé ? ───────────────────────────────────────────────────────

  low_delivery_rate: entry({
    id: "low_delivery_rate",
    family: "delivery",
    severity: "warn",
    metric: "delivered_rate",
    targetKind: "none",
    labelFr: "Une partie des messages n'arrive pas",
    whyFr:
      "Le taux de remise est le premier chiffre qui décide si un numéro mérite encore d'être acheminé : sous 90 %, chaque envoi est facturé sans que personne ne lise. La barre (95 % / 90 %) est un repère de fournisseur, pas une règle publiée par les opérateurs canadiens — aucun ne publie la sienne.",
    fixFr:
      "Dans le tableau « Par numéro expéditeur », traitez d'abord le code d'erreur affiché en tête sous le numéro fautif : un seul code fait presque toujours l'essentiel du taux.",
  }),

  no_dlr_backlog: entry({
    id: "no_dlr_backlog",
    family: "delivery",
    severity: "warn",
    metric: "no_dlr_rate",
    targetKind: "none",
    labelFr: "Des messages restent « envoyés » sans jamais être confirmés",
    whyFr:
      "Sans accusé de remise, la base ne sait pas si le message est arrivé : le fil reste « En file », personne ne relance, et rien n'a l'air cassé. C'est exactement la panne du 25 août 2026 — les envois partaient, les rappels de statut revenaient en 403. Barre d'exploitation, pas une règle d'opérateur.",
    fixFr:
      "Vérifiez que TWILIO_AUTH_TOKEN dans Vercel appartient bien au compte qui envoie : une signature refusée fait échouer le rappel de statut en silence.",
    sourceUrl: TWILIO_STATUS_CALLBACK,
  }),

  stuck_in_flight: entry({
    id: "stuck_in_flight",
    family: "delivery",
    severity: "warn",
    metric: "stale_in_flight",
    targetKind: "goLive",
    labelFr: "Des messages sont immobiles depuis plus d'une heure",
    whyFr:
      "Un message « en file » depuis une heure n'est ni parti ni perdu : il attend un répartiteur qui ne passe pas. Le contact, lui, croit simplement qu'on ne lui a pas répondu. Barre d'exploitation, alignée sur celle du préflight de mise en service.",
    fixFr:
      "Ouvrez « Mise en service » et regardez la date du dernier passage du répartiteur : au-delà de quinze minutes, la file ne s'écoule plus toute seule.",
  }),

  carrier_filtered: entry({
    id: "carrier_filtered",
    family: "delivery",
    severity: "danger",
    metric: "filtered_rate",
    targetKind: "none",
    labelFr: "Des messages sont filtrés par l'opérateur téléphonique",
    whyFr:
      "Le code 30007 veut dire qu'un opérateur a jugé le message indésirable et l'a jeté sans jamais le remettre : c'est LE signal de pourriel, et il se paie sur la réputation du numéro entier, pas sur le message fautif. Renvoyer le même texte creuse le trou.",
    fixFr:
      "Ouvrez l'onglet Contenu et retirez le lien du gabarit le plus envoyé : un lien dans un premier message est le déclencheur le plus courant.",
    sourceUrl: twilioError(30007),
  }),

  carrier_blocked: entry({
    id: "carrier_blocked",
    family: "delivery",
    severity: "danger",
    metric: "blocked_rate",
    targetKind: "client",
    labelFr: "Des numéros refusent vos messages",
    whyFr:
      "Le code 30004 dit que le destinataire ou son opérateur bloque la ligne ; le 21610 dit que Twilio refuse d'envoyer parce que ce numéro a déjà répondu STOP. Continuer d'écrire à ces téléphones est précisément le geste qui fait suspendre un expéditeur.",
    fixFr:
      "Ouvrez la fiche du contact et cochez « Ne pas appeler » : le numéro sort alors de toutes les audiences de campagne.",
    sourceUrl: twilioError(30004),
  }),

  hard_invalid_numbers: entry({
    id: "hard_invalid_numbers",
    family: "delivery",
    severity: "warn",
    metric: "hard_invalid_rate",
    targetKind: "client",
    labelFr: "Vous écrivez à des numéros qui ne peuvent pas recevoir de SMS",
    whyFr:
      "Le 30005 est un numéro inconnu, le 30006 une ligne fixe. Un taux qui monte ne dit rien de vos messages : il dit que la LISTE est mauvaise — numéros périmés, mal saisis, achetés. Les opérateurs lisent ce motif comme du ratissage et filtrent l'expéditeur en conséquence. Seuil de fournisseur.",
    fixFr:
      "Ouvrez la fiche et corrigez le téléphone, ou effacez-le : une ligne fixe ne recevra jamais de texto, quel que soit le message.",
    sourceUrl: twilioError(30006),
  }),

  unreachable_spike: entry({
    id: "unreachable_spike",
    family: "delivery",
    severity: "warn",
    metric: "unreachable_delta",
    targetKind: "none",
    labelFr: "Les « injoignables » augmentent d'une période à l'autre",
    whyFr:
      "Le 30003 (« appareil éteint ou hors de portée ») a un niveau de fond normal ; c'est sa HAUSSE qui trahit un filtrage discret, qui se déguise volontiers en téléphone fermé. Le mécanisme est documenté par Twilio ; la barre de dérive (+2 points) est la nôtre.",
    fixFr:
      "Comparez avec la colonne « Filtrés » du même numéro dans le tableau « Par numéro expéditeur » : si les deux montent ensemble, traitez le contenu, pas la liste.",
    sourceUrl: twilioError(30003),
  }),

  error_rate_high: entry({
    id: "error_rate_high",
    family: "delivery",
    severity: "warn",
    metric: "total_error_rate",
    targetKind: "none",
    labelFr: "Trop d'envois se terminent en erreur",
    whyFr:
      "Un envoi sur dix qui échoue, tous codes confondus, dessine le profil d'un expéditeur que les opérateurs commencent à écarter : ils ne voient pas une intention, ils voient un numéro qui produit des échecs. Seuil de fournisseur (6 % / 10 %), pas une barre publiée.",
    fixFr:
      "Traitez le code affiché en tête sous le numéro fautif, dans le tableau « Par numéro expéditeur », avant tous les autres : la queue de codes rares ne pèse presque rien.",
  }),

  registration_block: entry({
    id: "registration_block",
    family: "delivery",
    severity: "danger",
    metric: "registration_blocks",
    targetKind: "client",
    labelFr: "Un envoi a été refusé faute d'inscription A2P",
    whyFr:
      "Ces codes disent que l'expéditeur n'est pas inscrit au programme A2P 10DLC, obligatoire pour écrire à des mobiles AMÉRICAINS. Pour un envoi Québec vers Québec, ils ne devraient jamais apparaître : leur présence veut dire qu'un numéro américain est entré dans la liste.",
    fixFr:
      "Ouvrez la fiche dont l'indicatif régional est américain et retirez-la de la campagne : inscrire une marque n'est pas la réponse tant que vous n'écrivez pas volontairement aux États-Unis.",
    sourceUrl: twilioError(30034),
  }),

  us_bound_traffic: entry({
    id: "us_bound_traffic",
    family: "delivery",
    severity: "warn",
    metric: "us_bound_share",
    targetKind: "client",
    labelFr: "Vous écrivez à des mobiles américains",
    whyFr:
      "L'inscription A2P 10DLC se déclenche sur la DESTINATION, jamais sur l'expéditeur : tant que la liste reste canadienne, il n'y a rien à inscrire nulle part. Dès qu'un mobile américain reçoit un message, le trafic tombe sous les règles américaines et se fait bloquer faute de marque déclarée.",
    fixFr:
      "Retirez de l'audience les fiches dont l'indicatif régional est américain — c'est la destination qui crée l'obligation, pas votre numéro.",
    sourceUrl: TWILIO_A2P,
  }),

  throughput_block: entry({
    id: "throughput_block",
    family: "delivery",
    severity: "warn",
    metric: "throughput_blocks",
    targetKind: "settings",
    labelFr: "La file d'envoi du numéro a débordé",
    whyFr:
      "Ces codes disent que trop de messages ont été poussés d'un coup sur le même numéro : la file dépasse ce qu'un numéro long peut écouler, environ un message par seconde. Le surplus est refusé, pas retardé — il ne partira jamais.",
    fixFr:
      "Baissez le plafond « Plafond / jour » du numéro dans Réglages : un départ étalé passe là où une salve est refusée.",
    sourceUrl: twilioError(30001),
  }),

  // ── Qui a dit stop ? ──────────────────────────────────────────────────────

  optout_rate_high: entry({
    id: "optout_rate_high",
    family: "consent",
    severity: "warn",
    metric: "optout_rate",
    targetKind: "assistant",
    labelFr: "Trop de gens répondent STOP",
    whyFr:
      "Le désabonnement est le signal que les opérateurs lisent sans discuter, et il précède le filtrage de plusieurs jours. La barre (1 % / 2 %) est un repère de fournisseur — aucun opérateur canadien ne publie la sienne — mais la mécanique, elle, est bien réelle.",
    fixFr:
      "Ouvrez l'assistant, onglet Approche, et baissez sa persistance d'un cran : c'est le nombre de relances sans réponse qui fait dire STOP, bien avant le contenu.",
    sourceUrl: CTIA_BEST_PRACTICES,
  }),

  suppression_leak: entry({
    id: "suppression_leak",
    family: "consent",
    severity: "danger",
    metric: "suppression_leak",
    targetKind: "client",
    labelFr: "Un message est parti vers un numéro désabonné",
    whyFr:
      "Un contact qui a répondu STOP ne doit plus jamais rien recevoir : les bonnes pratiques CTIA ne tolèrent qu'UN seul accusé de réception après le mot-clé. Un message de trop suffit à faire suspendre un expéditeur, et c'est la seule règle du SMS qui ne se négocie pas.",
    fixFr:
      "Ouvrez la fiche et cochez « Ne pas appeler » : c'est la barrière qui s'applique à tous les chemins d'envoi, y compris celui qui vient de fuir.",
    sourceUrl: CTIA_BEST_PRACTICES,
  }),

  carrier_suppressions: entry({
    id: "carrier_suppressions",
    family: "consent",
    severity: "warn",
    metric: "carrier_suppressions",
    targetKind: "none",
    labelFr: "Des numéros ont été bloqués automatiquement après un échec",
    whyFr:
      "Chaque échec jugé définitif écrit une suppression permanente : le téléphone sort de toutes les campagnes sans que personne ne l'ait décidé. Beaucoup de suppressions d'un coup veut dire qu'une liste entière est mauvaise, ou qu'un filtrage est pris pour une panne d'appareil. Compteur d'exploitation.",
    fixFr:
      "Regardez, sous chaque numéro du tableau « Par numéro expéditeur », quel code a produit ces blocages : un 30003 en masse est un filtrage déguisé, pas des téléphones éteints.",
  }),

  harsh_suppression_30003: entry({
    id: "harsh_suppression_30003",
    family: "consent",
    severity: "warn",
    metric: null,
    targetKind: "none",
    labelFr: "Nous bloquons définitivement des numéros pour une erreur passagère",
    whyFr:
      "Constat STRUCTUREL, lu dans le code et non dans les chiffres : `src/lib/sms/status.ts` range le 30003 parmi les échecs définitifs (`HARD_FAILURE_CODES`) et écrit une suppression permanente, alors que Twilio documente ce code comme transitoire — « l'appareil est éteint ou hors de portée ». Un téléphone déchargé une heure coûte donc un contact pour toujours.",
    fixFr:
      "La correction est un changement de code — retirer 30003 de `HARD_FAILURE_CODES` ; les numéros déjà perdus se libèrent en effaçant leurs rangées de la table `suppressions`.",
    sourceUrl: twilioError(30003),
  }),

  missing_optout_language: entry({
    id: "missing_optout_language",
    family: "consent",
    severity: "warn",
    metric: null,
    targetKind: "assistant",
    labelFr: "Le premier message ne dit pas comment arrêter",
    whyFr:
      "Les bonnes pratiques CTIA demandent que le message d'ouverture indique comment se désabonner, et les opérateurs s'en servent comme marqueur de sérieux. Sans le mot STOP, celui qui veut que ça cesse signale le message au lieu d'y répondre — et un signalement pèse infiniment plus lourd qu'un STOP.",
    fixFr:
      "Ajoutez « Répondez STOP pour arrêter » à la fin du message d'ouverture.",
    sourceUrl: CTIA_BEST_PRACTICES,
  }),

  hostile_replies: entry({
    id: "hostile_replies",
    family: "consent",
    severity: "warn",
    metric: "hostile_reply_rate",
    targetKind: "client",
    labelFr: "Des contacts répondent avec hostilité",
    whyFr:
      "Les vrais signalements de pourriel (7726) arrivent chez l'agrégateur, jamais sur la rangée du message : ils sont hors de notre portée. Une réponse hostile est ce qu'on peut voir — c'est un PROXY, un indice, pas la mesure — et il annonce presque toujours un filtrage qui commence.",
    fixFr:
      "Ouvrez la fiche et lisez le fil : dans neuf cas sur dix, c'est une relance de trop sur un contact déjà servi.",
  }),

  // ── Quelle forme a le trafic ? ────────────────────────────────────────────

  template_spread: entry({
    id: "template_spread",
    family: "shape",
    severity: "danger",
    metric: "template_spread",
    targetKind: "campaign",
    labelFr: "Le même texte part depuis plusieurs numéros",
    whyFr:
      "Diluer un texte identique sur plusieurs expéditeurs porte un nom — le snowshoeing — et il est nommé mot pour mot dans les bonnes pratiques CTIA (§5.5.2) et dans la politique de messagerie de Twilio, qui juge sur « l'intention OU l'effet ». Fait sans intention, l'effet suffit à faire suspendre le compte.",
    fixFr:
      "Épinglez la campagne sur UN seul numéro expéditeur, dans l'onglet Général de son éditeur.",
    sourceUrl: TWILIO_MESSAGING_POLICY,
  }),

  sender_inconsistency: entry({
    id: "sender_inconsistency",
    family: "shape",
    severity: "warn",
    metric: "sender_consistency",
    targetKind: "client",
    labelFr: "Un même contact reçoit des messages de deux numéros",
    whyFr:
      "Vu du destinataire, deux numéros qui disent la même chose sont deux inconnus, et il bloque. Vu de l'opérateur, c'est la signature du snowshoeing. Un fil étant épinglé à un seul numéro, deux expéditeurs pour un contact veulent dire deux conversations ouvertes sur le même téléphone.",
    fixFr:
      "Épinglez la campagne sur UN seul numéro expéditeur (onglet Général de son éditeur) : c'est le réglage qui décide, et il empêche le prochain contact d'être joint deux fois.",
  }),

  daily_cap_pressure: entry({
    id: "daily_cap_pressure",
    family: "shape",
    severity: "warn",
    metric: "daily_cap_headroom",
    targetKind: "campaign",
    labelFr: "Un numéro approche son plafond quotidien",
    whyFr:
      "Le plafond est ce qui empêche un numéro de ressembler à une machine à publipostage. Collé au plafond, deux choses arrivent ensemble : les envois du soir basculent au lendemain, et le volume atteint le niveau à partir duquel les opérateurs regardent de près.",
    fixFr:
      "Baissez le plafond d'inscriptions par jour de la campagne qui alimente ce numéro : monter le plafond du numéro ne fait que déplacer le problème sur sa réputation.",
  }),

  burst_traffic: entry({
    id: "burst_traffic",
    family: "shape",
    severity: "warn",
    metric: "burst_factor",
    targetKind: "campaign",
    labelFr: "Les envois partent par salves",
    whyFr:
      "Un numéro qui passe de zéro à cent segments dans la même minute puis retombe dessine exactement le profil qu'un système anti-pourriel cherche : une machine, pas une conversation. Le rapport pointe/médiane est une mesure d'exploitation ; le profil, lui, est bien ce qui se fait repérer.",
    fixFr:
      "Baissez le plafond d'inscriptions par jour de la campagne : les départs s'étalent alors d'eux-mêmes sur la journée.",
  }),

  quiet_hours_violation: entry({
    id: "quiet_hours_violation",
    family: "shape",
    severity: "warn",
    metric: "quiet_hours_violations",
    targetKind: "assistant",
    labelFr: "Des messages automatiques sont partis en dehors des heures permises",
    whyFr:
      "Les bonnes pratiques CTIA fixent l'envoi entre 8 h et 21 h chez le DESTINATAIRE : un texto à 22 h est le motif de plainte le plus courant, et le plus facile à éviter. Faute de connaître le fuseau du destinataire, ce contrôle compte les envois hors de 9 h – 20 h, HEURE DE TORONTO — la fenêtre par défaut du moteur, plus serrée que celle de la CTIA. La fenêtre qui décide vraiment est celle de l'assistant.",
    fixFr:
      "Ouvrez l'assistant, onglet Approche, et resserrez sa fenêtre d'envoi : c'est elle qui décide à l'envoi, pas ce tableau.",
    sourceUrl: CTIA_BEST_PRACTICES,
  }),

  low_reply_rate: entry({
    id: "low_reply_rate",
    family: "shape",
    severity: "warn",
    metric: "reply_rate",
    targetKind: "assistant",
    labelFr: "Presque personne ne répond",
    whyFr:
      "Un trafic que personne ne lit finit filtré même sans un mot de travers : l'engagement est le contrepoids du volume dans tous les modèles d'opérateurs. Sous 5 % de fils qui répondent, le numéro ressemble à une diffusion. Repère de fournisseur ; la mécanique est réelle, la barre est indicative.",
    fixFr:
      "Réécrivez l'ouverture de l'assistant pour qu'elle pose UNE question fermée : un message qui n'appelle pas de réponse n'en reçoit pas.",
  }),

  unanswered_tail: entry({
    id: "unanswered_tail",
    family: "shape",
    severity: "warn",
    metric: "unanswered_tail",
    targetKind: "campaign",
    labelFr: "On continue d'écrire à des gens qui n'ont jamais répondu",
    whyFr:
      "Quatre sortants et zéro entrant, c'est parler tout seul. Chaque relance de plus ajoute du volume sans engagement — le mélange exact qui fait basculer un numéro du côté filtré — et le contact, lui, a déjà décidé.",
    fixFr:
      "Raccourcissez l'échelle de la campagne à trois barreaux : le quatrième ne convertit pas, il coûte de la réputation.",
  }),

  reach_concentration: entry({
    id: "reach_concentration",
    family: "shape",
    severity: "warn",
    metric: "reach_concentration",
    targetKind: "campaign",
    labelFr: "Les mêmes personnes reçoivent presque tout",
    whyFr:
      "Cent messages pour vingt destinataires, ce n'est plus une campagne : vu du contact c'est du harcèlement, et vu de l'opérateur c'est une répétition serrée sur un petit groupe de numéros — le motif qu'un filtre repère le plus facilement.",
    fixFr:
      "Ajoutez « sans contact depuis N jours » à l'audience de la campagne : c'est le filtre qui empêche de réécrire aux mêmes.",
  }),

  // ── Que dit le texte ? ────────────────────────────────────────────────────

  merge_field_leak: entry({
    id: "merge_field_leak",
    family: "content",
    severity: "danger",
    metric: null,
    targetKind: "campaign",
    labelFr: "Un champ de fusion part tel quel dans le message",
    whyFr:
      "Un `{{prenom}}` écrit dans un barreau de campagne n'est remplacé par rien : le corps du barreau est expédié littéralement, sans passer par le gabarit du prompt. Le contact reçoit « Bonjour {{prenom}} », la marque la plus reconnaissable d'un envoi automatisé raté.",
    fixFr:
      "Laissez le corps du barreau VIDE : l'assistant rédige alors le message et place le prénom lui-même.",
  }),

  public_shortener: entry({
    id: "public_shortener",
    family: "content",
    severity: "danger",
    metric: null,
    targetKind: "campaign",
    labelFr: "Un lien raccourci public se trouve dans le message",
    whyFr:
      "Les raccourcisseurs partagés (bit.ly, tinyurl…) masquent la destination, et un seul abuseur brûle le domaine pour tous ceux qui l'emploient : les opérateurs nord-américains les bloquent d'office et la politique de messagerie de Twilio les interdit dans le trafic A2P.",
    fixFr:
      "Remplacez le lien raccourci par l'adresse complète du site.",
    sourceUrl: TWILIO_MESSAGING_POLICY,
  }),

  link_in_opener: entry({
    id: "link_in_opener",
    family: "content",
    severity: "warn",
    metric: null,
    targetKind: "campaign",
    labelFr: "Le premier message contient un lien",
    whyFr:
      "Un lien envoyé à quelqu'un qui n'a encore rien répondu est le signal de pourriel le plus fiable qu'un filtre d'opérateur connaisse. C'est aussi le plus facile à retirer : le lien peut attendre la deuxième réponse.",
    fixFr:
      "Retirez le lien du message d'ouverture et gardez-le pour un message qui répond à une question posée.",
    sourceUrl: CTIA_BEST_PRACTICES,
  }),

  missing_brand: entry({
    id: "missing_brand",
    family: "content",
    severity: "warn",
    metric: null,
    targetKind: "assistant",
    labelFr: "Le premier message ne dit pas de qui il vient",
    whyFr:
      "La LCAP exige que tout message commercial identifie son expéditeur, et la politique de messagerie de Twilio en fait une condition de service. Un contact qui ne reconnaît pas l'expéditeur ne répond pas : il signale.",
    fixFr:
      "Ouvrez l'assistant, onglet Identité, et vérifiez le nom d'organisation : c'est ce mot que la règle « identify_sender » cherche dans le premier message.",
    sourceUrl: TWILIO_MESSAGING_POLICY,
  }),

  caps_and_punctuation: entry({
    id: "caps_and_punctuation",
    family: "content",
    severity: "info",
    metric: null,
    targetKind: "campaign",
    labelFr: "Le message crie",
    whyFr:
      "Les majuscules et les points d'exclamation en série sont comptés par les filtres de contenu comme un marqueur publicitaire : jamais décisifs seuls, ils s'ajoutent à tout le reste. Le calcul exclut déjà STOP, ARRÊT et le nom de l'entreprise, qui sont en majuscules pour de bonnes raisons.",
    fixFr:
      "Remettez la phrase en minuscules et gardez un seul point d'exclamation par message.",
  }),

  promo_language: entry({
    id: "promo_language",
    family: "content",
    severity: "warn",
    metric: null,
    targetKind: "campaign",
    labelFr: "Le message a le vocabulaire d'une publicité",
    whyFr:
      "« Gratuit », « offre limitée », « garanti » sont les premiers mots que comptent les filtres de contenu — et un courtier n'en a pas besoin, puisque le rendez-vous se prend sur une question, pas sur une promesse. Liste d'exploitation, pas une liste publiée par un opérateur.",
    fixFr:
      "Remplacez la promesse par une question : « quand seriez-vous disponible ? » convertit mieux qu'une offre.",
  }),

  shaft_language: entry({
    id: "shaft_language",
    family: "content",
    severity: "danger",
    metric: null,
    targetKind: "guardrails",
    labelFr: "Le message emploie des mots à haut risque (crédit, hypothèque, préapprobation)",
    whyFr:
      "Les catégories dites SHAFT et le crédit à la consommation sont filtrés d'office par les opérateurs, et « mauvais crédit », « préapprobation » ou « refinancement » figurent dans toutes les listes publiques (CTIA) — y compris quand le courtier qui les écrit est parfaitement légitime.",
    fixFr:
      "Ajoutez ces mots à la règle « Termes interdits » des garde-fous : l'assistant parlera de rencontre plutôt que de financement.",
    sourceUrl: CTIA_BEST_PRACTICES,
  }),

  evasion_characters: entry({
    id: "evasion_characters",
    family: "content",
    severity: "danger",
    metric: null,
    targetKind: "campaign",
    labelFr: "Le message contient des caractères invisibles ou mélange deux alphabets",
    whyFr:
      "Un caractère de largeur nulle, ou un « а » cyrillique glissé dans un mot latin, ne sert qu'à passer sous un filtre. La politique de messagerie de Twilio juge sur « l'intention OU l'effet » : collé par accident depuis un traitement de texte, l'effet reste le même, et la sanction aussi.",
    fixFr:
      "Retapez le message dans un champ vide au lieu de le coller : le caractère invisible vient presque toujours d'un copier-coller.",
    sourceUrl: TWILIO_MESSAGING_POLICY,
  }),

  ucs2_inflation: entry({
    id: "ucs2_inflation",
    family: "content",
    severity: "warn",
    metric: "ucs2_rate",
    targetKind: "campaign",
    labelFr: "Un caractère typographique triple le coût du message",
    whyFr:
      "Une seule apostrophe courbe fait basculer TOUT le message en UCS-2 : 70 caractères par segment au lieu de 160, donc trois fois le prix et trois fois le volume réseau pour un signe que personne ne remarque. Ce n'est pas une règle d'opérateur, c'est de la facturation.",
    fixFr:
      "Remplacez l'apostrophe courbe ’ par l'apostrophe droite ' — les caractères fautifs et leur substitut sont listés sous le constat.",
  }),

  ladder_body_unguarded: entry({
    id: "ladder_body_unguarded",
    family: "content",
    severity: "warn",
    metric: null,
    targetKind: "campaign",
    labelFr: "Un barreau écrit à la main échappe à TOUS les garde-fous",
    whyFr:
      "Constat STRUCTUREL, lu dans le code et non dans les chiffres : un corps de barreau rempli à la main part par `runTouch` → `send_sms` → `handleSendSms`, un chemin qui ne fait aucun contrôle de contenu — ni longueur maximale, ni politique de liens, ni termes interdits, ni identification de l'expéditeur.",
    fixFr:
      "Laissez le corps du barreau VIDE pour que l'assistant rédige et que les garde-fous s'appliquent — sinon, sachez que cet écran est la seule relecture que ce texte recevra jamais.",
  }),

  // ── La machine tourne-t-elle ? ────────────────────────────────────────────

  dispatcher_stale: entry({
    id: "dispatcher_stale",
    family: "engine",
    severity: "warn",
    metric: "dispatcher_age",
    targetKind: "goLive",
    labelFr: "Le répartiteur n'est pas passé depuis longtemps",
    whyFr:
      "Rien ne part tant que le répartiteur ne passe pas : les messages restent en file, les fils ont l'air traités, et le contact attend. Quinze minutes est la barre du préflight de mise en service — reprise telle quelle pour que les deux écrans ne se contredisent jamais.",
    fixFr:
      "Ouvrez « Mise en service » : la liste de contrôle y nomme ce qui empêche le répartiteur de tourner.",
  }),

  dispatch_cron_daily: entry({
    id: "dispatch_cron_daily",
    family: "engine",
    severity: "info",
    metric: null,
    targetKind: "goLive",
    labelFr: "La file ne s'écoule que lorsque quelqu'un utilise l'application",
    whyFr:
      "Constat STRUCTUREL, lu dans le fichier et non dans les chiffres : `vercel.json` déclare `/api/cron/dispatch` à « 30 12 * * * », soit UNE fois par jour, alors que le code est commenté comme s'il tournait chaque minute. La file avance donc sur les appels à `kickDispatch()` déclenchés par la navigation — une journée sans personne dans l'application est une journée sans envoi, en silence.",
    fixFr:
      "Changez la cadence dans `vercel.json` (« */5 * * * * », par exemple) si les envois doivent partir sans que personne n'ouvre l'application.",
  }),

  queue_backlog: entry({
    id: "queue_backlog",
    family: "engine",
    severity: "warn",
    metric: "queue_backlog",
    targetKind: "goLive",
    labelFr: "Des envois s'accumulent en file",
    whyFr:
      "Une file qui grossit veut dire que le répartiteur n'écoule pas ce que les campagnes y déposent. Les messages ne sont pas perdus, ils sont en retard — et un suivi qui arrive trois heures plus tard tombe sur un contact qui a perdu le fil.",
    fixFr:
      "Ouvrez « Mise en service » et regardez l'âge du plus vieux travail en attente : au-delà d'une heure, le répartiteur ne tourne pas.",
  }),

  kill_switch_on: entry({
    id: "kill_switch_on",
    family: "engine",
    severity: "danger",
    metric: null,
    targetKind: "settings",
    labelFr: "L'interrupteur d'arrêt est baissé",
    whyFr:
      "Tant qu'il est baissé, aucun message automatisé ne part : voulu le jour où on l'a baissé, oublié trois jours plus tard. Les campagnes continuent pourtant d'inscrire du monde, et tout le retard repart d'un coup à la remise en route — exactement la salve qu'il faut éviter.",
    fixFr:
      "Ouvrez Réglages et relevez l'interrupteur si la raison affichée n'a plus lieu d'être.",
  }),

  smart_encoding_off: entry({
    id: "smart_encoding_off",
    family: "engine",
    severity: "warn",
    metric: null,
    targetKind: "external",
    labelFr: "Twilio ne corrige pas les caractères typographiques (Smart Encoding désactivé)",
    whyFr:
      "Smart Encoding remplace l'apostrophe courbe, les guillemets et les tirets longs par leur équivalent GSM avant l'envoi. Désactivé, chaque message français risque de coûter trois segments au lieu d'un : c'est la case à cocher la plus rentable de tout cet écran.",
    fixFr:
      "Activez « Smart Encoding » sur le service de messagerie, dans la console Twilio.",
    sourceUrl: "https://www.twilio.com/docs/messaging/services/smart-encoding",
  }),

  sender_pool_mismatch: entry({
    id: "sender_pool_mismatch",
    family: "engine",
    severity: "warn",
    metric: null,
    targetKind: "external",
    labelFr: "Un numéro actif du CRM n'est pas rattaché au service de messagerie",
    whyFr:
      "Un numéro actif ici mais absent du bassin Twilio n'enverra rien : les messages partiront d'un autre numéro, et le contact verra un expéditeur inconnu. À l'inverse, un bassin plus large que nécessaire fait tourner les expéditeurs, ce que les opérateurs lisent comme du snowshoeing.",
    fixFr:
      "Rattachez le numéro au service de messagerie dans la console Twilio.",
  }),

  status_callback_missing: entry({
    id: "status_callback_missing",
    family: "engine",
    severity: "danger",
    metric: null,
    targetKind: "external",
    labelFr: "Le service de messagerie ne renvoie pas les accusés de remise",
    whyFr:
      "Sans rappel de statut, la base ne saura jamais si un message est arrivé : tous les fils restent « En file » et une panne d'envoi devient invisible. C'est la moitié cachée de l'incident du 25 août 2026.",
    fixFr:
      "Réglez le rappel de statut du service de messagerie sur …/api/webhooks/twilio/status, dans la console Twilio.",
    sourceUrl: TWILIO_STATUS_CALLBACK,
  }),

  twilio_key_scope: entry({
    id: "twilio_key_scope",
    family: "engine",
    severity: "info",
    metric: null,
    targetKind: "external",
    labelFr: "La clé Twilio ne donne pas accès à tout ce que cet écran interroge",
    whyFr:
      "Une clé API restreinte peut très bien envoyer des messages sans pouvoir lire Monitor ni la conformité A2P : Twilio répond 401 ou 403 et les cartes concernées restent vides. Ce n'est pas une panne, c'est une portée — confondre les deux fait chercher un problème inexistant.",
    fixFr:
      "Créez une clé API standard dans la console Twilio, puis remplacez TWILIO_API_KEY_SID et TWILIO_API_KEY_SECRET dans Vercel.",
    sourceUrl: "https://www.twilio.com/docs/iam/api-keys",
  }),

  a2p_campaign_problem: entry({
    id: "a2p_campaign_problem",
    family: "engine",
    severity: "info",
    metric: null,
    targetKind: "external",
    labelFr: "La campagne A2P déclarée chez Twilio est en difficulté",
    whyFr:
      "Une campagne 10DLC suspendue ou refusée bloque les envois vers les mobiles américains. Pour un courtier qui n'écrit qu'au Québec, ce n'est pas bloquant : l'inscription se déclenche sur la destination, pas sur l'expéditeur. À lire comme une information tant qu'aucun numéro américain n'est visé.",
    fixFr:
      "Ouvrez la conformité du service de messagerie dans la console Twilio et lisez le code d'erreur affiché — n'entamez une inscription que si vous écrivez vraiment aux États-Unis.",
    sourceUrl: TWILIO_A2P,
  }),

  account_suspended: entry({
    id: "account_suspended",
    family: "engine",
    severity: "danger",
    metric: null,
    targetKind: "external",
    labelFr: "Le compte Twilio est suspendu",
    whyFr:
      "Un compte suspendu n'envoie plus rien, et la suspension accompagne toujours les codes 30002 et 30037. C'est la seule ligne de cet écran qui rend toutes les autres sans objet tant qu'elle est vraie.",
    fixFr:
      "Ouvrez la console Twilio et suivez la démarche de rétablissement affichée sur le compte.",
  }),
};

/**
 * Le texte d'un constat dans la langue de l'ÉCRAN.
 *
 * Le français est la source, l'anglais une surcouche par identifiant. Une
 * traduction manquante retombe sur le français plutôt que d'afficher un vide :
 * lire le constat dans l'autre langue reste infiniment plus utile que de ne
 * rien lire, et le test de parité fait de toute façon échouer le build.
 *
 * À ne pas confondre avec la langue de l'ASSISTANT (règle 13 du dépôt) : rien
 * de ce fichier n'entre dans un prompt. Ce sont des mots pour l'administrateur
 * qui regarde le tableau de bord, jamais pour le contact qui reçoit un SMS.
 */
export function findingText(doc: FindingDoc, locale: DocLocale): FindingText {
  const fr: FindingText = { label: doc.labelFr, why: doc.whyFr, fix: doc.fixFr };
  if (locale === "fr") return fr;
  const en = FINDING_TEXT_EN[doc.id];
  if (!en) return fr;
  return {
    label: en.label || fr.label,
    why: en.why || fr.why,
    fix: en.fix || fr.fix,
  };
}
