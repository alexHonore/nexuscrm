/**
 * Documentation des paramètres d'une CAMPAGNE — module PUR.
 *
 * Même contrat que le registre des assistants (src/lib/docs/params.ts) : chaque
 * feuille du schéma zod a une fiche « quoi / pourquoi », et un test fait
 * échouer le build sur un chemin non documenté. C'est ce qui permet d'annoter
 * un fichier exporté et de tenir une page de documentation qui ne dérive pas.
 */

export interface CampaignFieldDoc {
  path: string;
  labelFr: string;
  whatFr: string;
  whyFr: string;
  pitfallsFr?: string;
  /** Le champ porte un identifiant LOCAL : il voyage comme liaison, jamais tel quel. */
  binding?: "assistant" | "sms_number" | "category" | "source" | "user";
}

export const CAMPAIGN_FIELD_DOCS: CampaignFieldDoc[] = [
  {
    path: "name",
    labelFr: "Nom",
    whatFr: "Le nom de la campagne, tel qu'il apparaît dans la liste et les statistiques.",
    whyFr: "Il n'est jamais envoyé au contact ; il sert à vous y retrouver. Nommez ce qu'elle FAIT : « Réactivation 180 j », pas « Campagne 3 ».",
  },
  {
    path: "description",
    labelFr: "Description",
    whatFr: "Une phrase sur l'intention de la campagne.",
    whyFr: "Quand l'assistant rédige un barreau lui-même, cette phrase lui donne le POURQUOI du message (réactivation, nouveau lead, portes ouvertes). Elle n'est jamais citée telle quelle.",
  },
  {
    path: "assistantId",
    labelFr: "Assistant",
    whatFr: "L'assistant qui prend le fil quand le contact répond, et qui rédige les barreaux sans texte.",
    whyFr: "Sans assistant, une réponse du contact attend un humain. Une campagne de réactivation sans assistant n'a de sens que si quelqu'un surveille l'inbox.",
    pitfallsFr: "L'assistant doit être ACTIF : un assistant en brouillon ne répond pas, et le barreau « rédigé par l'assistant » reste vide.",
    binding: "assistant",
  },
  {
    path: "smsNumberId",
    labelFr: "Numéro d'envoi",
    whatFr: "La ligne SMS depuis laquelle la campagne écrit. Vide = le premier numéro actif.",
    whyFr: "Un contact qui répond doit retomber sur le même fil ; le numéro est ce qui identifie le fil.",
    binding: "sms_number",
  },
  {
    path: "trigger.kind",
    labelFr: "Déclencheur",
    whatFr: "Ce qui inscrit un contact : vous-même (manuel), l'arrivée d'un lead, un changement de catégorie, ou un balayage périodique de l'audience.",
    whyFr: "C'est le réglage qui décide QUI reçoit un SMS et QUAND. Les quatre répondent à des usages différents : un lead doit être contacté dans la minute ; une vieille base se réactive par vagues.",
  },
  {
    path: "trigger.sourceIds",
    labelFr: "Sources déclenchantes",
    whatFr: "Pour « nouveau lead » : n'inscrire que les leads venus de ces sources. Vide = toutes.",
    whyFr: "Restreindre l'ÉVÉNEMENT, pas la population : une campagne peut viser les leads Facebook sans exclure de son audience les gens venus d'ailleurs.",
    binding: "source",
  },
  {
    path: "trigger.toCategoryIds",
    labelFr: "Catégories d'arrivée",
    whatFr: "Pour « changement de catégorie » : inscrire quand un contact ENTRE dans l'une de ces catégories. Vide = n'importe laquelle.",
    whyFr: "« À rappeler » → « Chaud » est un moment ; le SMS doit partir à ce moment-là, pas au prochain balayage.",
    binding: "category",
  },
  {
    path: "trigger.everyHours",
    labelFr: "Fréquence du balayage",
    whatFr: "Pour « balayage périodique » : toutes les combien d'heures on réexamine l'audience.",
    whyFr: "Borne la fréquence du balayage, PAS le rythme d'envoi — ce sont le plafond quotidien et l'échelle qui règlent le rythme.",
  },
  {
    path: "audience.categoryIds",
    labelFr: "Catégories visées",
    whatFr: "Les contacts doivent être dans l'une de ces catégories. Vide = toutes.",
    whyFr: "La catégorie est votre pipeline : c'est le filtre le plus naturel pour dire « les gens à cette étape ».",
    binding: "category",
  },
  {
    path: "audience.sourceIds",
    labelFr: "Sources visées",
    whatFr: "Les contacts doivent venir de l'une de ces sources. Vide = toutes.",
    whyFr: "Un message qui dit « vous avez rempli notre formulaire Facebook » ne doit partir qu'aux leads Facebook.",
    binding: "source",
  },
  {
    path: "audience.assignedToIds",
    labelFr: "Assignés à",
    whatFr: "Les contacts doivent être assignés à l'un de ces utilisateurs. Vide = peu importe.",
    whyFr: "Permet à un téléphoniste de relancer SA liste sans toucher à celle des autres.",
    binding: "user",
  },
  {
    path: "audience.createdWithinDays",
    labelFr: "Créés depuis moins de",
    whatFr: "Nombre de jours : ne viser que les contacts créés récemment.",
    whyFr: "Une campagne « bienvenue » n'a de sens que pour les nouveaux.",
  },
  {
    path: "audience.createdBeforeDays",
    labelFr: "Créés depuis plus de",
    whatFr: "Nombre de jours : ne viser que les contacts créés il y a longtemps.",
    whyFr: "Le pendant du précédent, pour une réactivation.",
  },
  {
    path: "audience.notContactedForDays",
    labelFr: "Sans contact depuis",
    whatFr: "Nombre de jours sans appel ni SMS. Le cœur d'une campagne de réactivation.",
    whyFr: "Écrire à quelqu'un qu'on a eu au téléphone hier, c'est du harcèlement ; à quelqu'un silencieux depuis six mois, c'est une relance.",
    pitfallsFr: "« Jamais contacté » compte comme « sans contact depuis toujours » : un contact fraîchement importé et jamais appelé ENTRE dans l'audience. Combinez avec « créés depuis plus de » si ce n'est pas voulu.",
  },
  {
    path: "audience.languages",
    labelFr: "Langues",
    whatFr: "Ne viser que les contacts dont la fiche est dans ces langues. Vide = toutes.",
    whyFr: "Un barreau écrit en français ne doit pas partir à un contact anglophone — et l'assistant écrit dans la langue de sa configuration.",
  },
  {
    path: "audience.excludeActiveInOtherCampaign",
    labelFr: "Exclure les gens déjà dans une autre campagne",
    whatFr: "Oui par défaut : un contact inscrit et actif dans une AUTRE campagne n'est pas repris ici.",
    whyFr: "Deux campagnes qui écrivent à la même personne la même semaine, c'est exactement ce qui fait signaler un numéro comme indésirable.",
  },
  {
    path: "audience.excludeDoNotCall",
    labelFr: "Exclure « ne pas appeler »",
    whatFr: "Oui par défaut : la case « ne pas appeler » de la fiche exclut aussi du SMS.",
    whyFr: "Le drapeau vaut pour la voix ; l'étendre au SMS est un choix prudent. Décochez seulement si vous savez que le refus portait sur les appels.",
  },
  {
    path: "ladder",
    labelFr: "Échelle",
    whatFr: "La liste ordonnée des messages : ouverture, puis relances. Huit barreaux au plus.",
    whyFr: "C'est l'échelle qui décide du rythme. Un seul barreau = un message et c'est tout ; trois = on insiste. Une réponse du contact arrête l'échelle.",
  },
  {
    path: "ladder[].delayHours",
    labelFr: "Délai (heures)",
    whatFr: "Pour le premier barreau : depuis l'inscription. Pour les suivants : depuis le barreau PRÉCÉDENT. En heures.",
    whyFr: "Cumulatif, pas absolu : « 72 » sur trois barreaux veut dire trois jours entre chacun, donc le dernier part le neuvième jour. Les heures de politesse repoussent au lendemain matin de toute façon.",
    pitfallsFr: "Lire les délais comme absolus fait sous-estimer la durée de l'échelle.",
  },
  {
    path: "ladder[].body",
    labelFr: "Texte du barreau",
    whatFr: "Le message, tel quel. Vide (null) = c'est l'ASSISTANT qui rédige, en tenant compte de l'historique.",
    whyFr: "Un texte dicté est prévisible, bon pour une ouverture légale. Une relance gagne à être rédigée : elle doit tenir compte de ce qui a été dit entre-temps.",
    pitfallsFr: "Un barreau vide exige un assistant ACTIF sur la campagne ; sinon rien ne part et la trace le dit (« skipped »).",
  },
  {
    path: "ladder[].label",
    labelFr: "Étiquette",
    whatFr: "Un nom interne pour le barreau (« ouverture », « relance 2 »).",
    whyFr: "N'apparaît jamais dans un message ; sert à lire les statistiques.",
  },
  {
    path: "variants",
    labelFr: "Variantes A/B",
    whatFr: "Jusqu'à quatre formulations de l'OUVERTURE, tirées au sort par contact selon leur poids.",
    whyFr: "Seul le premier barreau varie : faire varier toute l'échelle rendrait le résultat inattribuable.",
  },
  {
    path: "variants[].key",
    labelFr: "Clé de variante",
    whatFr: "Un identifiant court et stable (« directe », « douce »).",
    whyFr: "C'est elle qui est écrite sur l'inscription ; la changer casse l'historique.",
  },
  {
    path: "variants[].weight",
    labelFr: "Poids",
    whatFr: "Part relative du tirage (0-100). 0 = variante retirée sans perdre son historique.",
    whyFr: "Deux variantes à 50/50 comparent ; 90/10 teste prudemment une nouvelle formulation.",
  },
  {
    path: "variants[].body",
    labelFr: "Texte de la variante",
    whatFr: "L'ouverture propre à cette variante. Vide = l'ouverture du premier barreau.",
    whyFr: "Deux variantes au texte vide sont identiques : le test n'en est pas un.",
  },
  {
    path: "dailyEnrollmentCap",
    labelFr: "Plafond quotidien d'inscriptions",
    whatFr: "Nombre maximal de PERSONNES inscrites par jour (jour de Toronto).",
    whyFr: "Une base de 3 000 contacts ne doit pas recevoir 3 000 SMS le même matin : c'est ce qui fait bloquer un numéro, et c'est trop de réponses à traiter d'un coup.",
    pitfallsFr: "Ce n'est PAS un rythme de messages : « 1 » veut dire une personne par jour — une campagne qui paraît active et n'écrit presque à personne.",
  },
  {
    path: "totalEnrollmentCap",
    labelFr: "Plafond total",
    whatFr: "Nombre maximal de personnes inscrites sur toute la vie de la campagne. Vide = sans limite.",
    whyFr: "Utile pour un test : « les 50 premiers, puis on regarde ».",
  },
  {
    path: "startsAt",
    labelFr: "Début",
    whatFr: "Date avant laquelle la campagne n'inscrit personne. Vide = dès l'activation.",
    whyFr: "Permet de tout préparer et de laisser partir la vague un lundi matin.",
  },
  {
    path: "endsAt",
    labelFr: "Fin",
    whatFr: "Date après laquelle la campagne n'inscrit plus personne. Vide = sans fin.",
    whyFr: "Les inscriptions déjà en cours terminent leur échelle ; seules les nouvelles s'arrêtent.",
  },
  {
    path: "requireConsent",
    labelFr: "Consentement requis",
    whatFr: "Oui par défaut : n'écrire qu'aux contacts ayant un consentement SMS valide au dossier.",
    whyFr: "Loi canadienne anti-pourriel. Décocher n'est défendable que pour une campagne dont le texte est lui-même une demande de consentement.",
    pitfallsFr: "Décocher ne contourne pas les désabonnements : un numéro sous « STOP » ne reçoit jamais rien.",
  },
];

export function getCampaignFieldDoc(path: string): CampaignFieldDoc | undefined {
  return CAMPAIGN_FIELD_DOCS.find((d) => d.path === path);
}
