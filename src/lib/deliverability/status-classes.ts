/**
 * Le SEUL endroit qui interprète un littéral de `messages.status`.
 *
 * Module PUR (règle du dossier) : aucun import Next.js, aucun accès base,
 * aucun réseau, aucune horloge. `tests/unit-deliverability-purity.test.ts`
 * fait échouer le build si l'un de ces interdits entre ici.
 *
 * `messages.status` est un `text` libre, pas une énumération : la colonne reçoit
 * mot pour mot ce que Twilio renvoie (webhook de statut ET réconciliation REST
 * passent par `recordDeliveryOutcome`, qui écrit la chaîne telle quelle) ET les
 * quelques littéraux que notre file écrit elle-même. Deux vocabulaires dans une
 * seule colonne, sans contrainte pour les départager. Ce fichier est le seul
 * endroit qui sait lequel est lequel.
 *
 * ── CONTRADICTION C5 — « canceled » et « cancelled » ────────────────────────
 *
 * Les deux orthographes coexistent en base et ne veulent PAS dire la même
 * chose. Vérifié dans le dépôt :
 *
 *  · **`canceled`, un seul L** — l'orthographe de Twilio. Statut d'un message
 *    PROGRAMMÉ via un Messaging Service et annulé avant son heure. Il arrive
 *    par `recordDeliveryOutcome`, et `src/lib/sms/status.ts` lui donne d'ailleurs
 *    le rang 4 (terminal) sous cette graphie exacte.
 *  · **`cancelled`, deux L** — le nôtre. Écrit par
 *    `src/app/(app)/conversations/actions.ts` quand un humain annule un envoi
 *    encore en file : le job passe `cancelled` et la rangée `messages` avec.
 *    Le fil client le rend « Annulé » et barre le texte.
 *
 * Les confondre, dans un sens ou dans l'autre, produit la même erreur de
 * lecture : soit un geste humain se lit comme un incident de plateforme, soit
 * une annulation Twilio disparaît dans le décompte des messages que l'équipe a
 * retirés. D'où deux seaux distincts, et un test qui épingle les deux.
 *
 * ── Rien ne tombe par terre ─────────────────────────────────────────────────
 *
 * `bucketOf` ne lève jamais et ne jette jamais une valeur : un littéral inconnu
 * ressort en « other ». Une colonne de texte libre GAGNERA de nouvelles valeurs
 * — Twilio en a déjà (`read` en RCS), et le prochain chemin d'écriture ajoutera
 * les siennes. Un histogramme dont les colonnes ne totalisent pas le nombre de
 * rangées est un histogramme qui ment.
 */

// ── Les seaux ───────────────────────────────────────────────────────────────

/**
 * · `in_flight`           — parti, pas encore tranché. Ne compte dans AUCUN
 *                           taux de remise : diviser par ce qui vole encore
 *                           fait baisser le taux à chaque rafale.
 * · `delivered`           — accusé de remise reçu.
 * · `undelivered`         — l'opérateur a ACCEPTÉ puis renvoyé un accusé
 *                           négatif. C'est le côté RÉSEAU : filtrage, combiné
 *                           injoignable. Couplé au code 30007, c'est
 *                           l'empreinte canonique du filtrage transporteur.
 * · `failed`              — jamais passé l'acceptation de Twilio ou du premier
 *                           opérateur. C'est le côté COMPTE : file saturée,
 *                           suspension. Pas un problème de délivrabilité.
 * · `carrier_cancelled`   — Twilio, `canceled` (un L). Voir C5.
 * · `operator_cancelled`  — nous, `cancelled` (deux L). Voir C5.
 * · `never_left`          — la rangée existe, le message n'est jamais sorti de
 *                           la maison. Dénominateur SÉPARÉ, jamais mélangé aux
 *                           taux de remise.
 * · `received`            — entrant. Présent pour que le total ferme, pas pour
 *                           entrer dans un taux sortant.
 * · `other`               — voir la note sur « unknown » plus bas.
 */
export const STATUS_BUCKETS = [
  "in_flight",
  "delivered",
  "undelivered",
  "failed",
  "carrier_cancelled",
  "operator_cancelled",
  "never_left",
  "received",
  "other",
] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

/**
 * Le dictionnaire. Chaque clé est un littéral RÉELLEMENT écrit dans cette base
 * — vérifié contre les chemins d'écriture (`handleSendSms`,
 * `recordDeliveryOutcome`, `reconcileTwilioMessages`, `processInboundSms`,
 * la route `kill-switch`, `conversations/actions.ts`) et contre les clés
 * `thread.status.*` de `messages/fr/conversations.json`, qui en est
 * l'inventaire tenu à jour côté interface.
 *
 * `read` (RCS/WhatsApp) est volontairement absent : ce CRM n'envoie que du SMS,
 * et une colonne qui ne peut jamais se remplir se lit comme une surveillance
 * qui n'existe pas.
 */
const BUCKET_BY_STATUS: Record<string, StatusBucket> = {
  // ── in_flight ─────────────────────────────────────────────────────────────
  queued: "in_flight",
  sending: "in_flight",
  accepted: "in_flight",
  scheduled: "in_flight",
  /**
   * `sent` = l'opérateur amont a ACCEPTÉ, aucun accusé de remise n'est encore
   * arrivé. Il vole donc toujours, d'où ce seau — mais il est le seul statut
   * qui puisse y rester pour toujours, et c'est exactement la panne du
   * 2026-08-25 : les envois partaient, les rappels de statut n'arrivaient plus,
   * 44 messages livrés affichaient « En file » sans que rien n'ait l'air cassé.
   * `NO_DLR_STATUS` existe pour ça.
   */
  sent: "in_flight",

  // ── issues ────────────────────────────────────────────────────────────────
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",

  // ── C5 : deux orthographes, deux gestes ───────────────────────────────────
  canceled: "carrier_cancelled",
  cancelled: "operator_cancelled",

  // ── never_left ────────────────────────────────────────────────────────────
  /** Porte fermée avant l'envoi : interrupteur d'arrêt, désabonnement, bac à sable. */
  skipped: "never_left",
  /** Mode essai : le corps a été calculé, rien n'a été remis à Twilio. */
  dry_run: "never_left",

  // ── entrant ───────────────────────────────────────────────────────────────
  received: "received",
  /** Twilio l'expose ; notre webhook écrit toujours `received`. Même nature. */
  receiving: "received",

  /**
   * `unknown` est le SEUL littéral connu qui tombe volontairement dans
   * « other ». Il est écrit dans deux situations, et les deux disent
   * littéralement « on ne sait pas » : un délai ou une coupure réseau pendant
   * l'appel d'envoi (Twilio a peut-être accepté — renvoyer ferait un doublon),
   * et un sid que Twilio déclare introuvable à la réconciliation.
   *
   * Le ranger dans `never_left` mentirait — il est peut-être parti. Le ranger
   * dans `failed` mentirait aussi. « other » veut donc dire ici « indéterminé
   * OU hors catalogue », et un `other` non nul est en soi un chiffre à lire,
   * pas un fond de tiroir.
   */
  unknown: "other",
};

/**
 * Le seau d'un statut. Ne lève jamais ; `null`, chaîne vide et littéral inconnu
 * donnent « other ».
 *
 * La casse et les espaces sont normalisés avant lecture : la colonne est du
 * texte libre alimenté par un tiers, et un « Delivered » majuscule qui
 * atterrirait dans « other » ferait chuter le taux de remise sans qu'aucune
 * alerte ne pointe la cause.
 */
export function bucketOf(status: string | null | undefined): StatusBucket {
  if (status === null || status === undefined) return "other";
  return BUCKET_BY_STATUS[status.trim().toLowerCase()] ?? "other";
}

// ── Les listes qui nourrissent les indicateurs ──────────────────────────────

/**
 * Ce qui n'a PAS encore quitté Twilio. Volontairement plus étroit que le seau
 * `in_flight`, qui contient aussi `sent` : `sent` est parti, il attend son
 * accusé, et il se surveille avec `NO_DLR_STATUS`, pas ici.
 */
export const IN_FLIGHT_STATUSES: readonly string[] = ["queued", "sending", "accepted", "scheduled"];

/**
 * Les trois statuts que `src/lib/jobs/reconcile.ts` relit chez Twilio — et donc
 * les seuls qu'on a le droit de déclarer « immobiles » après une heure.
 *
 * `scheduled` en est ABSENT, et ce n'est pas un oubli : un message programmé a
 * le droit d'attendre son heure, la réconciliation ne le sonde pas, et le
 * compter comme bloqué allumerait une alarme rouge sur le fonctionnement normal
 * d'un envoi différé.
 *
 * Si un jour `reconcile.ts` change sa liste, celle-ci doit suivre : un tableau
 * de bord qui désigne comme coincé ce que le moteur ne va jamais débloquer
 * envoie l'opérateur chercher une panne qui n'existe pas.
 */
export const STALE_IN_FLIGHT_STATUSES: readonly string[] = ["queued", "sending", "accepted"];

/**
 * Le statut « parti, sans accusé de remise ». Nommé plutôt qu'écrit en clair
 * dans une requête parce que c'est l'angle mort du 2026-08-25 : c'est sa
 * PERSISTANCE au-delà de 24 h qui révèle des rappels de statut qui n'arrivent
 * plus, et rien d'autre dans la base ne rend cette panne visible.
 */
/**
 * La rangée existe, le message n'est JAMAIS sorti de la maison.
 *
 * `skipped` porte toujours un motif (`skip_reason`) ; `dry_run` n'en porte
 * aucun — `handleSendSms` le traite à part et laisse le motif nul. Sans cette
 * liste, une rangée d'essai à blanc échappe aux deux tableaux de l'écran :
 * au taux de remise, qui exige un sid Twilio, et au tableau des non-envois,
 * qui exigeait un motif. Basculer le moteur en mode essai vidait alors tout
 * l'écran de conformité sans un mot d'explication.
 */
export const NEVER_LEFT_STATUSES: readonly string[] = ["skipped", "dry_run"];

export const NO_DLR_STATUS = "sent";

/**
 * Les statuts qui comptent dans le plafond quotidien d'un numéro : tout ce qui
 * a quitté la maison.
 *
 * COPIE VERBATIM de `COUNTED` dans `src/lib/sms-server/daily-cap.ts`, qui reste
 * la SOURCE DE VÉRITÉ — c'est lui que `handleSendSms` interroge pour reporter
 * un envoi au lendemain. Recopié et non importé : `daily-cap.ts` ouvre sur
 * `import "server-only"` et touche `@/db`, deux interdits du dossier. La
 * couche serveur, elle, importe la vraie constante ; c'est cette copie-ci qui
 * ne doit servir qu'à l'affichage.
 *
 * Si `COUNTED` change là-bas, il faut le recopier ici — et
 * `tests/unit-deliverability-status.test.ts` compare les deux listes pour que
 * l'oubli se voie. Un tableau de bord qui compte le plafond autrement que
 * l'exécutant est pire que pas de tableau de bord : il affiche de la marge là
 * où l'envoi refuse déjà de partir.
 */
export const BILLABLE_STATUSES: readonly string[] = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "accepted",
  "undelivered",
  "failed",
  "unknown",
];
