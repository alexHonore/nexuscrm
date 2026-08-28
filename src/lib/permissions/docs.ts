/**
 * La RÉFÉRENCE des droits — un texte par case cochable.
 *
 * Une matrice de droits sans explications est un champ de mines : personne ne
 * sait ce que « Historique » ferme exactement, alors on coche tout « au cas
 * où » et le réglage ne protège plus rien. Chaque entrée dit donc CE QUE c'est,
 * POURQUOI ça existe, et ce qui SURPREND (`pitfallsFr`).
 *
 * Même discipline que les autres registres du dépôt (params.ts, guardrails,
 * campagnes) : le FRANÇAIS est la source — il décide quelles entrées existent —
 * et `docs.en.ts` est une surcouche par clé. Une traduction manquante retombe
 * sur le français, jamais sur du vide, et `tests/unit-permissions-docs-locale.test.ts`
 * fait échouer le build quand une entrée part sans traduction.
 */
import type { GrantKey, PermissionGroup, PermissionKey } from "./catalog";

export type DocLocale = "fr" | "en";

/** Le texte d'une entrée, résolu dans une langue. */
export type DocText = {
  label: string;
  what: string;
  why?: string;
  pitfalls?: string;
};

/** L'entrée telle qu'écrite en français — la source. */
export type DocEntry = {
  labelFr: string;
  whatFr: string;
  whyFr?: string;
  pitfallsFr?: string;
};

export type DocOverlay = Partial<DocText> & Pick<DocText, "label" | "what">;

/** Le français rendu tel quel ; l'anglais par-dessus, champ par champ. */
export function resolveDoc(fr: DocEntry, en: DocOverlay | undefined, locale: DocLocale): DocText {
  const base: DocText = {
    label: fr.labelFr,
    what: fr.whatFr,
    why: fr.whyFr,
    pitfalls: fr.pitfallsFr,
  };
  if (locale === "fr" || !en) return base;
  return {
    label: en.label || base.label,
    what: en.what || base.what,
    why: en.why ?? base.why,
    pitfalls: en.pitfalls ?? base.pitfalls,
  };
}

// ── Les registres ────────────────────────────────────────────────────────────

/**
 * Un texte par DROIT. L'ordre suit `PERMISSION_KEYS` : c'est celui de l'écran,
 * et le relire dans l'ordre revient à relire la matrice.
 */
export const PERMISSION_DOCS: Record<PermissionKey, DocEntry> = {
  // ── Fiches ─────────────────────────────────────────────────────────────────
  "clients.create": {
    labelFr: "Créer une fiche",
    whatFr:
      "Ouvre le bouton « Ajouter un client » de la liste Clients et la saisie manuelle qui va avec. C'est le seul chemin de création qui passe par une personne.",
    whyFr:
      "Une fiche saisie à la main double souvent une fiche déjà présente, sous une autre orthographe : on la referme aux rôles dont le métier est d'appeler ce qui arrive, pas d'alimenter la base.",
    pitfallsFr:
      "Le fermer ne tarit pas l'entrée : les leads continuent d'arriver par /api/webhooks/leads et par l'import CSV, qui ne sont pas des gestes de téléphoniste et ne lisent pas ce droit.",
  },
  "clients.edit": {
    labelFr: "Modifier une fiche",
    whatFr:
      "Ouvre la carte « Informations » de la fiche client — coordonnées, projet, notes — et son bouton « Enregistrer ».",
    whyFr:
      "Les coordonnées sont ce qui rend une fiche rappelable. Une modification malheureuse ne se remarque qu'au prochain appel, celui qui sonne dans le vide.",
    pitfallsFr:
      "Il ne couvre ni la catégorie ni l'assignation : « Changer la catégorie » dépend de son propre droit, le sélecteur « Assigner à » du sien. Le retirer seul laisse une fiche qu'on ne peut plus corriger mais qu'on peut encore reclasser et redonner.",
  },
  "clients.delete": {
    labelFr: "Supprimer une fiche",
    whatFr:
      "Ouvre le bouton « Supprimer » de la fiche client et la suppression depuis la barre de sélection. La suppression est définitive : elle emporte les appels, les rendez-vous, les suivis et les commentaires.",
    whyFr:
      "Il n'y a ni corbeille ni copie : rien ne se restaure. Ce droit est donc écrit à part plutôt que d'être un cas particulier de « Modifier une fiche ».",
    pitfallsFr:
      "Aucun compartiment ne peut le rendre : la case « Supprimer la fiche » est plafonnée par ce droit, et aucun des rôles livrés ne l'ouvre — pas même le superviseur sur ses propres fiches. Chaque suppression est consignée au journal d'audit.",
  },
  "clients.comment": {
    labelFr: "Commenter une fiche",
    whatFr:
      "Ouvre la carte « Commentaires » de la fiche et son bouton « Publier », mentions @collègue comprises.",
    whyFr:
      "Un commentaire est une note interne, jamais envoyée au client : c'est la mémoire de l'équipe entre deux appels, et il est signé.",
    pitfallsFr:
      "L'assistant SMS écrit lui aussi dans cette carte (outil « add_client_comment »). Fermer le droit ferme le bouton, pas la plume de la machine : les notes continuent d'apparaître.",
  },
  "clients.call": {
    labelFr: "Appeler",
    whatFr:
      "Ouvre le bouton « Appeler » de la fiche et le téléphone web. Fermé, le bouton reste inerte même quand la téléphonie est configurée.",
    whyFr:
      "Un rôle qui ne fait que regarder ne doit pas pouvoir composer un numéro. C'est exactement ce que ferme l'observateur.",
    pitfallsFr:
      "Avec la règle commune « Appeler une fiche du bassin la prend », ce droit devient aussi un droit d'assignation : l'appel change le détenteur de la fiche, sans qu'aucun bouton d'assignation ait été touché.",
  },
  "clients.sms": {
    labelFr: "Envoyer un SMS",
    whatFr:
      "Le plafond de tout texto écrit à la main : la carte SMS de la fiche client comme le fil de l'écran Conversations. C'est lui qui plafonne la case « Écrire un SMS » d'un compartiment.",
    whyFr:
      "Un SMS SORT de l'application. Il part chez l'opérateur, il est facturé au segment, et une fois remis il ne se rappelle pas.",
    pitfallsFr:
      "Un envoi manuel exige les DEUX droits : celui-ci, par la case « Écrire un SMS » de la fiche, et « Répondre dans un fil ». Fermer l'un suffit à fermer l'envoi — et le diagnostic est pénible quand on croyait n'avoir fermé que l'autre. Ni le désabonnement (STOP) ni les heures de silence ne sont des droits : eux ne se rouvrent pas ici.",
  },
  "clients.book": {
    labelFr: "Prendre un rendez-vous",
    whatFr:
      "Ouvre le bouton « Prendre rendez-vous » de la fiche et le choix des créneaux. L'évènement est créé dans le calendrier Google du courtier, avec le lien Meet.",
    whyFr:
      "Un rendez-vous engage l'agenda du courtier et le déplacement du client : c'est l'action de la fiche dont l'erreur se paie en heures.",
    pitfallsFr:
      "Les plages et le préavis minimal des Réglages s'appliquent par-dessus : accorder le droit ne fait apparaître aucun créneau à moins de trois heures d'avis.",
  },
  "clients.followup": {
    labelFr: "Planifier un suivi",
    whatFr:
      "Ouvre la carte « Suivis » de la fiche : créer un rappel, en modifier l'échéance, le terminer.",
    whyFr:
      "Les suivis alimentent « À appeler aujourd'hui » du tableau de bord et la notification d'échéance : ils décident du travail du lendemain.",
    pitfallsFr:
      "Un suivi créé sur la fiche d'un collègue est assigné au DÉTENTEUR de la fiche, pas à son auteur : il apparaît dans le tableau de bord de l'autre. Fermer le droit n'efface pas les suivis déjà posés, qui continuent d'échoir.",
  },
  "clients.category": {
    labelFr: "Changer la catégorie",
    whatFr:
      "Ouvre « Changer la catégorie » sur la fiche et, surtout, les boutons d'après-appel : chaque disposition écrit un statut de pipeline.",
    whyFr:
      "Le statut de pipeline décide de ce qui remonte dans l'analytique, de ce que les filtres retrouvent et de l'audience que les campagnes ont le droit d'inscrire.",
    pitfallsFr:
      "Il a l'air d'un détail d'affichage et il pilote tout l'après-appel : sans lui, un téléphoniste peut appeler mais pas conclure, et l'appel se termine sans disposition.",
  },
  "clients.assign": {
    labelFr: "Toucher à l'assignation",
    whatFr:
      "Ouvre le sélecteur « Assigner à » de la fiche. Ce n'est qu'un interrupteur général : à QUI, et à qui l'on peut PRENDRE, se règle dans l'onglet « Assignation » du rôle.",
    whyFr:
      "Séparer l'interrupteur des règles permet de fermer l'assignation d'un rôle en une case, sans avoir à défaire les quatre règles une à une.",
    pitfallsFr:
      "Accordé seul, il ne fait rien : si les règles d'assignation du rôle sont toutes fermées, le sélecteur refuse chaque choix. Fermé, aucune règle ne s'applique — même « Se servir dans le bassin » reste lettre morte.",
  },
  "clients.bulk": {
    labelFr: "Actions en masse",
    whatFr:
      "Ouvre la barre de sélection de la liste Clients : assigner, reclasser, changer la source, inscrire à une campagne, supprimer — sur toutes les fiches cochées d'un coup.",
    whyFr:
      "Le geste est le même que fiche par fiche ; c'est l'échelle qui change. Une erreur multipliée par deux cents fiches ne se rattrape pas à la main.",
    pitfallsFr:
      "Il ne remplace pas les droits qu'il déclenche : supprimer en masse exige aussi « Supprimer une fiche », inscrire à une campagne exige la campagne. Chaque fiche touchée reçoit sa propre ligne au journal d'audit, marquée « bulk ».",
  },
  "clients.export": {
    labelFr: "Exporter en CSV",
    whatFr:
      "Ouvre l'export de l'écran « Import / Export » : les fiches, filtrées ou non, dans un fichier téléchargeable — noms, téléphones, courriels, notes.",
    whyFr:
      "Un export est une copie de la clientèle qui sort de l'application et que plus rien ne protège ensuite. C'est le geste le plus lourd de conséquence de tout l'écran.",
    pitfallsFr:
      "Un CSV contient les coordonnées en clair : l'accorder à un rôle à qui l'on masque le téléphone (« Voir les coordonnées » fermé) annule le masquage d'un seul téléchargement. L'export est consigné au journal d'audit.",
  },
  "clients.import": {
    labelFr: "Importer un CSV",
    whatFr:
      "Ouvre l'import de l'écran « Import / Export » : créer des fiches en masse à partir d'un fichier, et — en mode « mettre à jour » — réécrire celles qui existent déjà.",
    whyFr:
      "Un import écrit dans la base sans qu'aucune fiche ne soit ouverte. C'est une création de masse, pas une saisie.",
    pitfallsFr:
      "Le rapprochement se fait par téléphone : en mode « mettre à jour », un fichier mal préparé réécrit des champs sur des fiches qui appartiennent à quelqu'un d'autre. C'est une porte distincte de « Créer une fiche » : la fermer ne ferme pas celle-ci.",
  },
  "clients.contact": {
    labelFr: "Voir les coordonnées",
    whatFr:
      "Affiche le téléphone et le courriel en clair. Fermé, la fiche reste lisible mais les coordonnées sont masquées (•••-4512).",
    whyFr:
      "C'est ce qui permet de montrer le travail d'un collègue — son historique, sa catégorie, son avancement — sans donner le numéro qui permettrait d'appeler son client à sa place.",
    pitfallsFr:
      "C'est le plafond, pas le robinet : même accordé, il faut encore que la case « Coordonnées en clair » soit ouverte sur le compartiment de la fiche. Et il ne masque rien dans un CSV exporté.",
  },
  "clients.recordings": {
    labelFr: "Écouter les enregistrements",
    whatFr:
      "Ouvre la lecture de l'enregistrement d'un appel, depuis l'historique de la fiche comme depuis le journal d'appels.",
    whyFr:
      "Un enregistrement contient tout ce que le client a dit, y compris ce qui n'a été noté nulle part et ce qu'il ne pensait pas voir circuler.",
    pitfallsFr:
      "Chaque écoute est consignée au journal d'audit, nommément — l'accès se donne, il ne s'oublie pas. Le droit d'ouvrir le journal d'appels ne donne pas l'audio : ce sont deux cases.",
  },
  "clients.history": {
    labelFr: "Voir l'historique",
    whatFr:
      "Ouvre la carte « Historique » de la fiche : les appels, les rendez-vous et le journal des modifications.",
    whyFr:
      "L'historique dit QUI a travaillé la fiche et ce qui a déjà été tenté. C'est ce qu'on ferme pour laisser une fiche consultable sans exposer le travail de l'équipe.",
    pitfallsFr:
      "Fermé, la fiche s'affiche quand même : seule la carte disparaît, et elle emporte de quoi éviter un doublon d'appel — la fiche paraît neuve alors qu'elle a été appelée trois fois. Pour qu'une fiche cesse d'exister, c'est la case « La fiche existe » qu'il faut fermer.",
  },

  // ── Conversations SMS ──────────────────────────────────────────────────────
  "conversations.view": {
    labelFr: "Voir les conversations",
    whatFr:
      "Ouvre l'écran Conversations — « À traiter », « En attente du client », « File d'envoi », « Refus » — et la carte SMS de la fiche client.",
    whyFr:
      "Ce que l'assistant a écrit fait partie de l'histoire du client au même titre qu'un appel : c'est la moitié de ce qui lui a été dit.",
    pitfallsFr:
      "Fermé, l'entrée disparaît de la navigation ET le fil disparaît de la fiche : le téléphoniste ne saura pas que l'assistant vient d'écrire à ce client, et il appellera par-dessus.",
  },
  "conversations.reply": {
    labelFr: "Répondre dans un fil",
    whatFr:
      "Ouvre la zone de rédaction d'un fil et son bouton « Envoyer » : un texto écrit à la main, qui part sous le numéro de l'entreprise.",
    whyFr:
      "Reprendre le clavier est ce qu'on fait quand l'assistant n'a plus la bonne réponse. C'est un droit d'écriture vers l'extérieur, pas un droit de lecture augmenté.",
    pitfallsFr:
      "Il ne suffit pas seul : l'envoi vérifie en plus la case « Écrire un SMS » sur la fiche visée, elle-même plafonnée par le droit « Envoyer un SMS ». Et écrire à la main ne met pas l'assistant en pause — sans « Piloter une conversation », il répondra par-dessus au message suivant.",
  },
  "conversations.control": {
    labelFr: "Piloter une conversation",
    whatFr:
      "Ouvre « Prendre le contrôle » et « Rendre la main à l'IA », l'assignation du fil, le marquage « traité » et l'annulation d'un envoi encore en file. CHOISIR quel assistant tient le fil est un droit à part.",
    whyFr:
      "C'est le geste d'urgence du moteur SMS : il arrête l'assistant sur UNE conversation qui dérape, sans le couper pour tout le monde.",
    pitfallsFr:
      "Annuler n'est possible que tant que le message n'a pas été remis à l'opérateur. Passé ce point, l'écran le dit et refuse : un SMS parti ne se rappelle pas.",
  },

  "conversations.assistant": {
    labelFr: "Brancher un assistant sur un client",
    whatFr:
      "Ouvre le sélecteur « Assistant » sur la fiche client et dans la boîte de réception : confier ce fil à un assistant, en changer, ou l'en retirer. Sans ce droit le sélecteur ne s'affiche pas, et l'action est refusée côté serveur.",
    whyFr:
      "Reprendre un fil est une décision de téléphoniste ; brancher un robot sur un client est une décision commerciale. On peut vouloir la première sans la seconde — d'où deux droits plutôt qu'un.",
    pitfallsFr:
      "Le droit est le plafond, la case « Assistant » du compartiment décide fiche par fiche : ouvert partout, il laisse quand même un téléphoniste sans la case sur les fiches d'un collègue. Retirer le droit ne débranche PAS les assistants déjà en place — les fils en cours continuent.",
  },

  // ── Administration ─────────────────────────────────────────────────────────
  "admin.analytics": {
    labelFr: "Analytique",
    whatFr:
      "Ouvre /admin/analytics : volumes d'appels, dispositions, conversions, par période et par téléphoniste.",
    whyFr:
      "C'est l'écran qui compare les téléphonistes entre eux. Le donner, c'est décider que le rendement de chacun est lisible par ce rôle.",
    pitfallsFr:
      "Un écran de statistiques dit toujours quelque chose des fiches qu'on ne voit pas : un total, une moyenne, le nom de celui qui a converti. Il s'accorde en le sachant.",
  },
  "admin.calls": {
    labelFr: "Journal d'appels",
    whatFr:
      "Ouvre /admin/calls : les appels de toute l'équipe, entrants comme sortants, avec leur durée, leur disposition et le renvoi vers l'enregistrement.",
    whyFr:
      "C'est la seule vue qui rassemble les appels de l'équipe : les entrants manqués s'y lisent, la fiche par fiche non.",
    pitfallsFr:
      "Le renvoi vers l'enregistrement n'ouvre l'audio qu'avec « Écouter les enregistrements ». Voir la ligne et entendre l'appel sont deux droits.",
  },
  "admin.pipeline": {
    labelFr: "Pipeline et sources",
    whatFr:
      "Ouvre /admin/pipeline : créer, renommer, colorer et réordonner les catégories du pipeline et les sources de leads.",
    whyFr:
      "Les catégories sont l'ossature du CRM : elles nomment les colonnes du tableau, les boutons d'après-appel, les filtres et l'audience des campagnes.",
    pitfallsFr:
      "Supprimer une catégorie oblige à déplacer ses clients ailleurs : le geste touche des milliers de fiches d'un coup. Renommer une catégorie renomme aussi le bouton d'après-appel qui la porte.",
  },
  "admin.users": {
    labelFr: "Comptes utilisateurs",
    whatFr:
      "Ouvre /admin/users : créer un compte, le désactiver, réinitialiser un mot de passe, et choisir le rôle de chacun.",
    whyFr:
      "Qui gère les comptes gère les rôles : il lui suffit de se nommer administrateur, ou de créer un compte qui l'est.",
    pitfallsFr:
      "Case verrouillée : seul l'administrateur la détient, quoi qu'on coche (« LOCKED_TO_ADMIN »). L'écran la grise, et le serveur la retire à l'enregistrement même si la requête arrive d'ailleurs.",
  },
  "admin.roles": {
    labelFr: "Rôles et droits",
    whatFr:
      "Ouvre cet écran-ci : créer des rôles, cocher leurs droits, régler les compartiments et les règles d'assignation.",
    whyFr:
      "Un rôle qui peut modifier la matrice s'accorde tout le reste dans la minute. Le verrou n'est pas une précaution : c'est ce qui rend la matrice sûre à ouvrir largement ailleurs.",
    pitfallsFr:
      "Case verrouillée comme « Comptes utilisateurs ». « sanitizeRole » la retire de tout rôle non administrateur au moment d'enregistrer : la cocher par un autre chemin ne donne rien.",
  },
  "admin.settings": {
    labelFr: "Réglages",
    whatFr:
      "Ouvre /admin/settings : le compte Google Agenda, les plages et le préavis de réservation, le fournisseur de téléphonie.",
    whyFr:
      "Ces réglages valent pour toute l'installation. Ils ne se règlent pas par rôle, et rien à l'écran ne signale qu'ils ont changé.",
    pitfallsFr:
      "Un seul geste arrête toute l'équipe : déconnecter Google supprime la prise de rendez-vous pour tout le monde, changer de fournisseur de téléphonie coupe le téléphone web.",
  },
  "admin.assistants": {
    labelFr: "Voir les assistants",
    whatFr:
      "Ouvre /admin/assistants en LECTURE : la liste, la configuration d'un assistant, son prompt compilé, ses essais et son historique de versions. Rien ne s'enregistre avec ce seul droit.",
    whyFr:
      "Ce que le robot dit aux clients est une information d'équipe : savoir ce qu'il promet évite de le contredire au téléphone. La modifier est un autre métier — voir « Modifier les assistants ».",
    pitfallsFr:
      "La langue de l'assistant est SON réglage, pas celle de l'écran : changer la langue de l'interface ne change rien à ce qu'il écrit.",
  },
  "admin.assistantsEdit": {
    labelFr: "Modifier les assistants",
    whatFr:
      "Créer un assistant, l'éditer, l'activer ou le désactiver, l'importer, et lancer le bac à sable. Sans ce droit, l'écran des assistants s'ouvre en LECTURE : on lit la configuration et le prompt compilé, les boutons d'enregistrement et d'activation restent fermés.",
    whyFr:
      "Un superviseur a de bonnes raisons de lire ce que le robot est censé dire à ses clients, et aucune de le réécrire un mardi soir. Lire ne casse rien ; écrire change ce que l'entreprise dit à des centaines de personnes.",
    pitfallsFr:
      "Chaque essai du bac à sable appelle un modèle et coûte de l'argent : c'est pour ça qu'il est ici et non dans « Voir les assistants ». Les paquets d'objections sont PARTAGÉS entre assistants — les modifier change tous les assistants qui s'en servent.",
  },

  "admin.campaigns": {
    labelFr: "Campagnes",
    whatFr:
      "Ouvre /admin/campaigns : l'audience, l'échelle de relances, les inscriptions et le déclenchement des envois.",
    whyFr:
      "Une campagne transforme une liste de fiches en une suite de SMS facturés, filtrables par les opérateurs et impossibles à rappeler.",
    pitfallsFr:
      "Modifier une échelle ne rattrape jamais les inscrits en cours : « Relancer les terminées » est le seul chemin, et une fiche ne se réinscrit pas deux fois à la même campagne.",
  },
  "admin.guardrails": {
    labelFr: "Garde-fous",
    whatFr:
      "Ouvre /admin/guardrails : les règles qui bloquent un message avant l'envoi — montants, liens, longueur, nombre de questions, vérification par l'IA.",
    whyFr:
      "Les garde-fous sont ce qui reste quand le prompt échoue. C'est le dernier filtre avant l'opérateur.",
    pitfallsFr:
      "Le droit ouvre autant le desserrage que le serrage, et ni l'un ni l'autre ne se voit avant l'envoi suivant : une règle retirée laisse l'assistant écrire ce qu'elle interdisait, une règle trop large le fait échouer en silence.",
  },
  "admin.deliverability": {
    labelFr: "Délivrabilité",
    whatFr:
      "Ouvre /admin/deliverability : ce qui arrive, ce qui est filtré par les opérateurs, et où le corriger.",
    whyFr:
      "Un SMS filtré ne revient jamais dire qu'il l'a été. Sans cet écran, une chute d'arrivée se lit six semaines plus tard dans le carnet de rendez-vous.",
    pitfallsFr:
      "L'écran ne corrige jamais rien tout seul : il constate. Trois écarts connus y sont signalés en permanence — les voir n'est pas une panne.",
  },
  "admin.webhooks": {
    labelFr: "Clés webhook",
    whatFr:
      "Ouvre /admin/webhooks : créer les clés API de n8n, de Facebook Lead Ads ou du site web, révéler une clé, la supprimer.",
    whyFr:
      "Une clé webhook crée des fiches sans compte et sans session : c'est un accès en écriture à la base, remis à une machine.",
    pitfallsFr:
      "Supprimer une clé coupe l'intégration à la seconde : les leads cessent d'entrer sans que rien d'autre ne le signale. Une clé révélée est une clé qui circule — elle n'est affichée qu'une fois pour cette raison.",
  },
  "admin.audit": {
    labelFr: "Journal d'audit",
    whatFr:
      "Ouvre /admin/audit : qui a supprimé, exporté, importé, écouté un enregistrement ou touché à un compte, avec la date et l'auteur.",
    whyFr:
      "C'est le contre-pouvoir du reste de cet écran : les droits disent ce qui est permis, le journal dit ce qui a été fait.",
    pitfallsFr:
      "Le lire, c'est voir passer des noms de clients et des gestes portés sur des fiches que le rôle ne verrait pas autrement.",
  },
  "admin.billing": {
    labelFr: "Consommation et dépenses",
    whatFr:
      "Ouvre /admin/billing : ce que chaque téléphoniste consomme, ce que voip.ms facture sur la période, et le solde du compte.",
    whyFr:
      "Le solde voip.ms tombe à zéro sans prévenir, et un solde vide fait échouer l'achat d'un numéro au pire moment.",
    pitfallsFr:
      "L'écran est une vue par personne : il rend l'activité de chaque téléphoniste lisible à qui l'ouvre, minutes et coût compris.",
  },
  "admin.docs": {
    labelFr: "Documentation",
    whatFr:
      "Ouvre /admin/docs : la référence des assistants, des garde-fous et des campagnes, assemblée depuis les mêmes registres que l'aide en ligne.",
    whyFr:
      "La page n'a aucun bouton et ne touche à rien : elle se lit. C'est le droit le plus tranquille de la liste.",
  },
};

/**
 * Un texte par CASE de relation. Elles se lisent toujours dans un
 * compartiment : « ses propres fiches », « le bassin », ou « les fiches
 * détenues par tel rôle ».
 */
export const GRANT_DOCS: Record<GrantKey, DocEntry> = {
  visible: {
    labelFr: "La fiche existe",
    whatFr:
      "Fermée, la fiche est ABSENTE pour ce regard : hors de la liste Clients, hors de la recherche, hors du tableau de pipeline, hors du tableau de bord, et son adresse directe répond « introuvable ».",
    whyFr:
      "C'est la demande d'origine : une fiche que le courtier a prise disparaît de l'équipe, plutôt que d'afficher un refus qui confirmerait qu'elle existe.",
    pitfallsFr:
      "Elle commande tout le reste : les onze autres cases n'ont aucun effet tant que celle-ci est fermée. C'est aussi la seule case sans droit qui la plafonne — qui voit quoi se règle ici, et nulle part ailleurs.",
  },
  contact: {
    labelFr: "Coordonnées en clair",
    whatFr:
      "Ouvre le téléphone et le courriel sur cette fiche. Fermée, ils s'affichent masqués (•••-4512) et le bouton d'appel n'a rien à composer.",
    whyFr:
      "C'est la case qui sépare « voir le travail d'un collègue » de « pouvoir appeler son client ».",
    pitfallsFr:
      "Plafonnée par le droit « Voir les coordonnées » : la cocher ne sert à rien tant que le droit est fermé plus haut, et l'écran l'indique alors par « Droit non accordé plus haut ». Fermée, la recherche cesse aussi de retrouver la fiche par son numéro — sinon taper « 418555 » révélerait chiffre par chiffre ce qu'on vient de masquer.",
  },
  history: {
    labelFr: "Historique de la fiche",
    whatFr:
      "Ouvre les appels, les rendez-vous, le fil SMS, les commentaires et le journal de modifications de cette fiche.",
    pitfallsFr:
      "Plafonnée par le droit « Voir l'historique ». Fermée sur les fiches des autres, elle cache aussi ce qui éviterait un doublon d'appel : la fiche paraît neuve alors qu'elle a déjà été travaillée.",
  },
  comment: {
    labelFr: "Commenter",
    whatFr: "Ouvre la carte « Commentaires » en écriture sur cette fiche.",
    whyFr:
      "C'est la case la plus sûre à ouvrir sur la fiche d'un autre : elle ajoute sans rien modifier, et chaque note est signée.",
    pitfallsFr: "Plafonnée par le droit « Commenter une fiche ».",
  },
  edit: {
    labelFr: "Modifier la fiche",
    whatFr:
      "Ouvre la carte « Informations » en écriture sur cette fiche : coordonnées, projet, notes.",
    pitfallsFr:
      "Plafonnée par le droit « Modifier une fiche ». Ouverte sur les fiches d'un collègue, elle permet de réécrire ses notes sans qu'il en soit averti : le journal de la fiche est le seul endroit où ça se lit.",
  },
  category: {
    labelFr: "Changer la catégorie",
    whatFr:
      "Ouvre le changement de statut de pipeline sur cette fiche, y compris par un bouton d'après-appel.",
    pitfallsFr:
      "Plafonnée par le droit « Changer la catégorie ». Fermée alors qu'« Appeler ce client » est ouverte, l'appel se termine sans disposition : le travail est fait, la fiche n'avance pas.",
  },
  call: {
    labelFr: "Appeler ce client",
    whatFr: "Ouvre le bouton « Appeler » sur cette fiche.",
    pitfallsFr:
      "Plafonnée par le droit « Appeler ». Ouverte sur le bassin avec la règle « Appeler une fiche du bassin la prend », elle devient une case d'assignation : l'appel attribue la fiche.",
  },
  sms: {
    labelFr: "Écrire un SMS",
    whatFr:
      "Ouvre l'envoi d'un texto à la main vers cette fiche, depuis sa carte SMS comme depuis l'écran Conversations.",
    pitfallsFr:
      "Plafonnée par le droit « Envoyer un SMS », et l'envoi exige en plus « Répondre dans un fil ». Ouverte sur la fiche d'un collègue, elle met deux personnes dans le même fil sans que le client sache qu'ils sont deux.",
  },
  book: {
    labelFr: "Prendre un rendez-vous",
    whatFr: "Ouvre « Prendre rendez-vous » sur cette fiche.",
    pitfallsFr:
      "Plafonnée par le droit « Prendre un rendez-vous ». Le rendez-vous se pose dans l'agenda du courtier et non dans celui de qui le prend : l'ouvrir largement remplit un seul agenda.",
  },
  followup: {
    labelFr: "Planifier un suivi",
    whatFr: "Ouvre la carte « Suivis » en écriture sur cette fiche.",
    pitfallsFr:
      "Plafonnée par le droit « Planifier un suivi ». Le suivi est assigné au détenteur de la fiche : posé sur la fiche d'un collègue, il apparaît dans le tableau de bord de l'autre.",
  },
  assign: {
    labelFr: "Changer de détenteur",
    whatFr:
      "Ouvre la prise, la remise au bassin et la réassignation de cette fiche. C'est la case que les règles d'assignation viennent affiner.",
    whyFr:
      "Elle dit OÙ un rôle peut toucher à l'assignation ; les règles disent CE QU'il peut en faire. Les deux se lisent ensemble.",
    pitfallsFr:
      "Plafonnée par le droit « Toucher à l'assignation », et jamais suffisante seule : sur une fiche déjà prise, il faut encore « Retirer une fiche à son détenteur », ou attendre l'expiration du verrou.",
  },
  assistant: {
    labelFr: "Brancher un assistant",
    whatFr:
      "Confier le fil de cette fiche à un assistant, en changer, ou l'en retirer. Plafonné par le droit « Brancher un assistant sur un client ».",
    whyFr:
      "C'est la case qui décide si un téléphoniste peut mettre un robot sur le client d'un collègue, ou seulement sur les siens.",
    pitfallsFr:
      "Fermer la case n'ARRÊTE pas l'assistant déjà en place : elle empêche d'en changer. Pour couper le robot sur un fil, c'est « Prendre le contrôle » (Piloter une conversation).",
  },
  delete: {
    labelFr: "Supprimer la fiche",
    whatFr:
      "Ouvre la suppression définitive de cette fiche, avec ses appels, ses rendez-vous, ses suivis et ses commentaires.",
    whyFr:
      "Une fiche supprimée emporte l'historique de toute l'équipe, pas seulement le travail de qui la supprime.",
    pitfallsFr:
      "Plafonnée par le droit « Supprimer une fiche ». Aucun rôle livré ne l'ouvre, pas même sur ses propres fiches : c'est le seul geste de l'écran qui ne se défait pas.",
  },
};

/** Les trois familles de droits, dans l'ordre de l'onglet « Droits ». */
export const GROUP_DOCS: Record<PermissionGroup, DocEntry> = {
  clients: {
    labelFr: "Fiches clients",
    whatFr:
      "Tout ce qui se fait sur une fiche : la lire, l'appeler, la modifier, la classer, la donner, la sortir de l'application.",
    whyFr:
      "Ces droits sont le PLAFOND. L'onglet « Fiches des autres » dit ensuite sur quelles fiches ils s'appliquent : une action n'est possible que si les deux sont ouverts.",
    pitfallsFr:
      "Un droit fermé ici ne peut être rendu par aucune relation. C'est ce qui permet d'ouvrir l'onglet suivant largement sans jamais dépasser le rôle.",
  },
  conversations: {
    labelFr: "Conversations SMS",
    whatFr:
      "L'écran Conversations et la carte SMS de la fiche : lire les fils, y écrire à la main, reprendre la main à l'assistant.",
    whyFr:
      "Le fil SMS est le seul endroit où une machine parle au client en votre nom. Lire, écrire et arrêter sont trois droits distincts parce que ce sont trois responsabilités distinctes.",
  },
  admin: {
    labelFr: "Administration",
    whatFr:
      "Les écrans de la section « Administration » : réglages, comptes, assistants, campagnes, garde-fous, journaux, consommation.",
    whyFr:
      "Ces droits ouvrent des écrans, pas des fiches : les compartiments n'y peuvent rien. Ce qui est accordé ici l'est sur toute l'installation.",
    pitfallsFr:
      "« Comptes utilisateurs » et « Rôles et droits » restent réservés à l'administrateur, quoi qu'on coche : sans ce verrou, un rôle s'accorderait tout le reste en une visite.",
  },
};

/**
 * Les quatre règles d'assignation d'un rôle (plus son plafond), et les règles
 * communes à tout le monde. Les clés sont celles de `AssignmentRules` et de
 * `GlobalAssignmentRules` — l'écran lit les mêmes.
 */
export const ASSIGNMENT_DOCS: Record<string, DocEntry> = {
  // ── Par rôle ───────────────────────────────────────────────────────────────
  claimPool: {
    labelFr: "Se servir dans le bassin",
    whatFr:
      "Autorise « Prendre cette fiche » sur une fiche que personne ne détient. Sans elle, le bassin se lit mais ne se prend pas.",
    whyFr:
      "C'est le mode de travail normal d'un téléphoniste : il se sert, il appelle, il garde.",
    pitfallsFr:
      "La règle ne suffit pas : il faut aussi que la case « Changer de détenteur » soit ouverte sur le compartiment « Le bassin ». La règle dit ce qu'il peut faire, la relation dit où.",
  },
  release: {
    labelFr: "Rendre au bassin",
    whatFr:
      "Autorise « Rendre au bassin » sur une fiche qu'il détient : elle redevient sans détenteur, et prenable par un autre.",
    whyFr:
      "Sans elle, le plafond de fiches devient une impasse : arrivé à 50, le téléphoniste ne peut plus rien prendre et ne peut rien lâcher.",
  },
  assignToOthers: {
    labelFr: "Donner à quelqu'un",
    whatFr:
      "Autorise le choix d'un AUTRE destinataire dans « Assigner à ». Fermée, le sélecteur ne mène qu'à soi-même ou au bassin.",
    pitfallsFr:
      "Se donner la fiche à soi n'est pas couvert par cette règle : c'est une prise, avec le plafond de fiches détenues qui va avec.",
  },
  takeFromOthers: {
    labelFr: "Retirer à son détenteur",
    whatFr:
      "Autorise la prise ou la réassignation d'une fiche DÉJÀ tenue par quelqu'un d'autre, sans attendre l'expiration de son verrou.",
    whyFr:
      "C'est le verrou anti-vol de tout le dispositif : fermée, une fiche prise ne change de main que par un rôle qui a cette règle, ou après le délai des règles communes.",
    pitfallsFr:
      "C'est la case qui a l'air la plus anodine et qui décide de tout : ouverte à un rôle de téléphonistes, chacun peut se servir chez le voisin, et la notification à l'ancien détenteur reste le seul signal qu'il en reçoit.",
  },
  maxOwned: {
    labelFr: "Plafond de fiches",
    whatFr:
      "Nombre maximal de fiches détenues au-delà duquel il ne peut plus SE servir dans le bassin. 0 = sans plafond.",
    whyFr:
      "Un téléphoniste qui prend tout le bassin le matin l'assèche pour l'équipe, sans rappeler pour autant ce qu'il a pris.",
    pitfallsFr:
      "Il ne bloque QUE la prise : une fiche qu'on lui DONNE passe toujours, même au-delà du compte. Et il ne se desserre qu'en rendant — un plafond sans « Rendre au bassin » finit par tout figer.",
  },

  // ── Communes à tous les rôles ──────────────────────────────────────────────
  staleDays: {
    labelFr: "Expiration du verrou",
    whatFr:
      "Jours sans contact au bout desquels une fiche prise redevient prenable par un autre. 0 = jamais : seul un rôle qui peut retirer la redistribue alors.",
    whyFr:
      "Un lead oublié dans les fiches de quelqu'un n'est pas un lead protégé, c'est un lead perdu. Le délai remet en jeu ce qui dort.",
    pitfallsFr:
      "Le verrou expire, la fiche NE se libère PAS : elle reste au même nom tant que personne ne la réclame, et il n'y a aucune tâche de fond à surveiller. Le décompte part du dernier contact, ou à défaut de la dernière modification de la fiche.",
  },
  claimOnCall: {
    labelFr: "Appeler, c'est prendre",
    whatFr:
      "Appeler une fiche du bassin l'assigne à celui qui appelle, au moment de l'appel.",
    whyFr:
      "C'est ce qui rend le verrou vivable : sans cette règle, deux téléphonistes appellent le même lead à trois minutes d'intervalle et personne n'a rien volé.",
    pitfallsFr:
      "La prise est silencieuse — aucun bouton d'assignation n'a été touché. Seule la mention « Fiche prise : vous venez de l'appeler » la signale.",
  },
  notifyAssignee: {
    labelFr: "Prévenir le destinataire",
    whatFr:
      "Envoie une notification à la personne à qui une fiche vient d'être assignée : « Fiche assignée — untel vous a confié cette fiche ».",
    whyFr:
      "Une fiche qui apparaît en silence au milieu d'une liste n'est pas travaillée : personne ne relit sa liste pour y chercher des nouveautés.",
  },
  notifyPreviousOwner: {
    labelFr: "Prévenir l'ancien détenteur",
    whatFr:
      "Envoie une notification à celui à qui la fiche est retirée : « Fiche retirée — untel a repris cette fiche ».",
    whyFr:
      "Retirer une fiche en silence est ce qui fait naître les soupçons de vol. Le message coûte une ligne et clôt le sujet.",
    pitfallsFr:
      "Coupée, une reprise permise par l'expiration du verrou devient invisible : la fiche disparaît de la liste de son détenteur sans une explication.",
  },
};
