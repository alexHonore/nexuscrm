import { GOAL_TYPES, QUALIFICATION_FIELDS } from "@/lib/assistants/schema";
import type { ParamDoc } from "./types";

/**
 * Référence de TOUS les paramètres d'un assistant, en français.
 *
 * Chaque entrée répond à quatre questions : ce que c'est, pourquoi ça existe,
 * ce que ça change dans le prompt ou à l'exécution, et ce qui va mal quand
 * c'est mal réglé — avec le symptôme visible de l'extérieur. C'est cette
 * dernière ligne qui sert vraiment : un taux de désabonnement de 4 % ne se
 * lit pas comme « persistance trop haute » tant que personne ne l'a écrit.
 *
 * `tests/unit-docs-params.test.ts` échoue si un chemin de la config zod n'a
 * pas d'entrée ici : un paramètre non documenté casse le build.
 */

let order = 0;
const next = () => (order += 1);

const doc = (d: Omit<ParamDoc, "orderIndex">): ParamDoc => ({ ...d, orderIndex: next() });

// ── Identité (L1) ────────────────────────────────────────────────────────────

const identity: ParamDoc[] = [
  doc({
    path: "identity.mode",
    section: "identity",
    labelFr: "Mode d'identité",
    type: "enum",
    required: true,
    defaultValue: "team",
    allowed: [
      { value: "team", labelFr: "Équipe — « l'équipe de Groupe Nexus »" },
      { value: "named_person", labelFr: "Personne nommée — un courtier précis" },
    ],
    whatFr:
      "Détermine au nom de qui l'assistant écrit : l'équipe, ou une personne nommée de votre organisation.",
    whyFr:
      "Écrire au nom d'une personne crée une attente : la personne qui répondra devrait être celle-là. « Équipe » évite cette promesse implicite quand le suivi est réparti.",
    effectFr:
      "Compilé dans la couche L1. En mode « personne nommée », le nom apparaît dans la présentation et le rendez-vous est annoncé avec cette personne.",
    pitfallsFr:
      "Nommer un courtier qui ne fera pas le suivi : le client demande cette personne au téléphone et on doit se rétracter. Symptôme : des clients qui disent « on m'avait dit que je parlerais à… ».",
    related: ["identity.brokerName", "identity.brokerUserId"],
    example: "team",
  }),
  doc({
    path: "identity.orgName",
    section: "identity",
    labelFr: "Nom de l'organisation",
    type: "string",
    required: true,
    defaultValue: "Groupe Nexus",
    whatFr: "Le nom d'entreprise que l'assistant emploie pour se présenter.",
    whyFr:
      "La LCAP exige que tout message commercial identifie clairement l'expéditeur. C'est cette chaîne qui remplit cette obligation.",
    effectFr:
      "Injecté en L1 et disponible comme {{org}} dans le gabarit du tour. La règle « identify_sender » vérifie que le premier message le contient.",
    pitfallsFr:
      "Un nom différent de celui que le client a vu sur l'annonce Facebook : il ne fait pas le lien et signale le message comme indésirable. Symptôme : taux de désabonnement élevé dès le premier envoi.",
    related: ["identity.brokerName"],
    example: "Groupe Nexus",
  }),
  doc({
    path: "identity.brokerName",
    section: "identity",
    labelFr: "Nom du courtier",
    type: "string",
    required: true,
    defaultValue: "Alex-Honoré",
    whatFr: "Le courtier avec qui la rencontre est prise.",
    whyFr:
      "Le client accepte un rendez-vous avec quelqu'un, pas avec une entreprise. Nommer la personne rend la proposition concrète.",
    effectFr: "Injecté en L1 et dans le titre de l'évènement d'agenda.",
    pitfallsFr:
      "Une orthographe différente de celle du permis OACIQ ou du site web sème le doute.",
    related: ["identity.mode"],
    example: "Alex-Honoré",
  }),
  doc({
    path: "identity.brokerUserId",
    section: "identity",
    labelFr: "Compte du courtier",
    type: "string",
    required: false,
    defaultValue: null,
    whatFr:
      "L'utilisateur du CRM correspondant au courtier nommé. Obligatoire en mode « personne nommée ».",
    whyFr:
      "Rattacher l'assistant à un vrai compte permet d'assigner les rendez-vous et les conversations à la bonne personne — et interdit d'inventer un nom qui n'existe pas dans l'équipe.",
    effectFr:
      "Utilisé comme propriétaire du rendez-vous créé. À l'import d'un assistant, ce champ doit être ré-associé à un utilisateur local.",
    pitfallsFr:
      "Laissé vide en mode « personne nommée » : la compilation passe, mais les rendez-vous retombent sur le premier admin actif.",
    related: ["identity.mode", "goal.primary.withUserId"],
  }),
  doc({
    path: "identity.signature",
    section: "identity",
    labelFr: "Signature",
    type: "enum",
    required: true,
    defaultValue: "none",
    allowed: [
      { value: "none", labelFr: "Aucune — le message se termine par la question" },
      { value: "first_name", labelFr: "Prénom — « — Alex »" },
      { value: "full_name", labelFr: "Nom complet — « — Alex-Honoré »" },
      { value: "org", labelFr: "Organisation — « — Groupe Nexus »" },
      { value: "custom", labelFr: "Libre — le texte que vous écrivez" },
    ],
    whatFr: "Ajoute ou non une signature à la fin des messages.",
    whyFr:
      "En SMS, une signature consomme des caractères et retarde la question. Elle humanise, mais chaque envoi la répète.",
    effectFr: "Compilé en L1 comme consigne de rédaction.",
    pitfallsFr:
      "Signer chaque message d'une conversation donne un ton de gabarit ; la valeur est surtout au premier contact.",
    related: ["approach.maxChars"],
    example: "none",
  }),
  doc({
    path: "identity.signatureText",
    section: "identity",
    labelFr: "Texte de signature",
    type: "string",
    required: false,
    defaultValue: null,
    whatFr: "La signature exacte, utilisée quand le mode de signature est « Libre ».",
    whyFr:
      "Les formes dérivées (prénom, nom complet, organisation) ne couvrent pas tout : « — L'équipe Nexus » ou « — Alex, courtier immobilier » n'entrent dans aucune.",
    effectFr: "Ajouté tel quel à la fin des messages, sans autre traitement.",
    pitfallsFr:
      "Une signature longue est répétée à CHAQUE message et compte dans les 160 caractères d'un segment : « — Alex-Honoré, courtier immobilier résidentiel » coûte 46 caractères par envoi.",
    related: ["identity.signature", "approach.maxChars"],
    example: "— Alex",
  }),
  doc({
    path: "identity.aiDisclosure",
    section: "identity",
    labelFr: "Divulgation de l'IA",
    type: "enum",
    required: true,
    defaultValue: "on_request",
    allowed: [
      { value: "on_request", labelFr: "Sur demande — répond la vérité si on demande" },
      { value: "upfront", labelFr: "D'emblée — l'annonce dès le premier message" },
    ],
    whatFr: "Quand l'assistant annonce qu'il est un système automatisé.",
    whyFr:
      "Dans les deux cas il dit la vérité si on lui demande — c'est une règle du noyau, non négociable. Ce réglage décide seulement s'il l'annonce sans qu'on demande.",
    effectFr:
      "En mode « d'emblée », une consigne L1 impose de l'indiquer dans le premier message.",
    pitfallsFr:
      "Annoncer d'emblée réduit le taux de réponse ; ne pas l'annoncer expose à la déception si la personne le découvre tard. Le garde-fou « honesty_ai » couvre le pire cas dans les deux réglages.",
    related: ["guardrails.honesty_ai"],
    example: "on_request",
  }),
];

// ── Objectif (L2) ────────────────────────────────────────────────────────────

const GOAL_TYPE_LABELS: Record<(typeof GOAL_TYPES)[number], string> = {
  video_meeting: "Rencontre vidéo — visioconférence avec le courtier",
  in_person_meeting: "Rencontre en personne — au bureau ou chez le client",
  phone_call: "Appel téléphonique — un créneau réservé",
  collect_email: "Obtenir le courriel — pour un envoi de suivi",
  collect_callback_time: "Convenir d'un moment de rappel",
  qualify_only: "Qualifier seulement — ne propose JAMAIS de rencontre",
  handoff: "Passer la main — vise la reprise par un humain",
};

const goalStepDocs = (prefix: string, label: string, section = "goal" as const): ParamDoc[] => [
  doc({
    path: `${prefix}.type`,
    section,
    labelFr: `${label} — type`,
    type: "enum",
    required: true,
    allowed: GOAL_TYPES.map((value) => ({ value, labelFr: GOAL_TYPE_LABELS[value] })),
    whatFr: "Ce que l'assistant cherche à obtenir à ce cran de l'objectif.",
    whyFr:
      "C'est la décision structurante : elle détermine les outils utiles, les champs à recueillir et ce qui compte comme réussite.",
    effectFr:
      "Compilé en L2 et relu à chaque tour dans la couche d'exécution. Les types de rencontre déclenchent la recherche de disponibilités réelles ; « qualify_only » interdit toute proposition de rendez-vous.",
    pitfallsFr:
      "Choisir un type de rencontre sans agenda Google connecté : l'assistant n'a aucune disponibilité à offrir et tourne en rond. Symptôme : des conversations qui s'étirent sans jamais proposer d'heure.",
    related: [`${prefix}.durationMin`, `${prefix}.requiredFields`, "tools"],
    example: "video_meeting",
  }),
  doc({
    path: `${prefix}.durationMin`,
    section,
    labelFr: `${label} — durée (minutes)`,
    type: "int",
    required: false,
    defaultValue: null,
    whatFr: "Durée annoncée de la rencontre.",
    whyFr:
      "Une durée courte et nommée fait tomber l'objection « je n'ai pas le temps ». « 15 minutes » se refuse moins facilement que « une rencontre ».",
    effectFr: "Citée en L2 et reprise dans l'évènement d'agenda.",
    pitfallsFr:
      "Annoncer 15 minutes puis bloquer une heure d'agenda : le courtier se retrouve avec des trous. La durée doit correspondre à la réservation réelle.",
    related: [`${prefix}.appointmentType`],
    example: 30,
  }),
  doc({
    path: `${prefix}.appointmentType`,
    section,
    labelFr: `${label} — type de rendez-vous`,
    type: "enum",
    required: false,
    defaultValue: null,
    allowed: [
      { value: "meet", labelFr: "Visioconférence (lien Google Meet)" },
      { value: "inperson", labelFr: "En personne (adresse)" },
      { value: null, labelFr: "Aucun — ce cran ne réserve pas" },
    ],
    whatFr:
      "Le type de rendez-vous du CRM auquel ce cran est rattaché — c'est lui qui décide des disponibilités consultées.",
    whyFr:
      "Les rencontres vidéo et en personne n'ont ni la même durée ni le même tampon dans vos réglages de réservation. Le lier explicitement évite de proposer un créneau impossible.",
    effectFr:
      "Passé à la recherche de disponibilités et à la création du rendez-vous. Sans valeur, les outils d'agenda refusent d'agir.",
    pitfallsFr:
      "Un type de rencontre sans type de rendez-vous : l'assistant ne peut ni proposer ni réserver, et la conversation s'enlise.",
    related: [`${prefix}.type`, "booking"],
    example: "meet",
  }),
  doc({
    path: `${prefix}.withUserId`,
    section,
    labelFr: `${label} — courtier`,
    type: "string",
    required: false,
    defaultValue: null,
    whatFr: "L'utilisateur avec qui le rendez-vous est pris.",
    whyFr:
      "Dans une équipe, le rendez-vous doit atterrir sur le bon agenda. Ce champ est ré-associé à un utilisateur local à l'import.",
    effectFr: "Propriétaire du rendez-vous créé.",
    pitfallsFr:
      "Vide, le rendez-vous retombe sur l'assigné du client puis sur le premier admin actif — ce qui n'est pas toujours la bonne personne.",
    related: ["identity.brokerUserId"],
  }),
  doc({
    path: `${prefix}.requiredFields`,
    section,
    labelFr: `${label} — informations requises`,
    type: "array",
    required: true,
    defaultValue: [],
    allowed: QUALIFICATION_FIELDS.map((value) => ({ value, labelFr: value })),
    whatFr:
      "Les informations que l'assistant doit avoir recueillies AVANT de pouvoir réserver. Les huit clés ci-dessous sont proposées avec leur libellé ; tout autre texte est accepté tel quel (« nombre de chambres », « adresse à évaluer ») et part mot pour mot dans le prompt.",
    whyFr:
      "Sans cette barrière, un modèle réserve dès que la personne dit oui, et le courtier arrive en rencontre sans savoir si c'est un achat ou une vente.",
    effectFr:
      "L'outil de réservation REFUSE tant qu'un champ manque et renvoie une erreur que le modèle doit lire : il pose alors la question au lieu de réserver.",
    pitfallsFr:
      "Trop de champs requis : la conversation devient un formulaire et la personne décroche. Deux suffisent presque toujours. Symptôme : beaucoup de conversations longues sans rendez-vous.",
    related: ["approach.questionBudget", `${prefix}.type`],
    example: ["project_type", "timing", "nombre de chambres"],
  }),
  doc({
    path: `${prefix}.slotOfferCount`,
    section,
    labelFr: `${label} — nombre de disponibilités offertes`,
    type: "int",
    required: true,
    defaultValue: 2,
    allowed: [
      { value: 1, labelFr: "1 — une seule proposition" },
      { value: 2, labelFr: "2 — recommandé" },
      { value: 3, labelFr: "3 — maximum" },
    ],
    whatFr: "Combien de créneaux réels l'assistant propose à la fois.",
    whyFr:
      "Deux choix transforment « voulez-vous se voir? » en « lequel des deux? » — une question bien plus facile à répondre. Trois commencent à ressembler à un horaire.",
    effectFr: "Nombre de disponibilités demandées à l'agenda et citées dans le message.",
    pitfallsFr:
      "Trois créneaux dans un SMS allongent le message et diluent la question.",
    related: ["approach.maxChars"],
    example: 2,
  }),
  doc({
    path: `${prefix}.instruction`,
    section,
    labelFr: `${label} — comment le demander`,
    type: "text",
    required: false,
    defaultValue: null,
    whatFr:
      "Une consigne libre sur la FAÇON de présenter ce cran : « propose l'appel comme un dépannage de quinze minutes, pas comme une rencontre ».",
    whyFr:
      "Le type d'objectif dit ce qu'on cherche à obtenir ; il ne dit rien de la manière de le demander. C'est pourtant la manière qui fait accepter ou refuser — et elle n'entrait dans aucun réglage : il fallait réécrire une couche entière du prompt.",
    effectFr:
      "Rendue en L2 juste après le cran qu'elle concerne — pas en bloc à la fin, sinon on ne sait plus à quel repli elle s'applique.",
    pitfallsFr:
      "Une consigne qui contredit un garde-fou (« promets une évaluation gratuite ») sera bloquée à l'envoi sans que le modèle comprenne pourquoi. Elle décrit un TON, pas une permission.",
    related: [`${prefix}.type`, "layerOverrides.text"],
    example: "Présente-le comme un appel court, sans engagement.",
  }),
  doc({
    path: `${prefix}.confirmationTemplate`,
    section,
    labelFr: `${label} — message de confirmation`,
    type: "text",
    required: false,
    defaultValue: null,
    whatFr:
      "Gabarit du message envoyé une fois le rendez-vous confirmé. Vide = formulation intégrée.",
    whyFr:
      "La confirmation est le message le plus relu de la conversation : y mettre l'heure, le format et le nom évite un no-show.",
    effectFr: "Rendu avec les variables du tour au moment de la confirmation.",
    pitfallsFr:
      "Un gabarit qui oublie l'heure ou le fuseau : la personne se présente au mauvais moment.",
    related: ["turnInstructions"],
  }),
];

const goal: ParamDoc[] = [
  ...goalStepDocs("goal.primary", "Objectif principal"),
  doc({
    path: "goal.fallbacks",
    section: "goal",
    labelFr: "Chaîne de replis",
    type: "array",
    required: true,
    defaultValue: [],
    whatFr:
      "Les objectifs de rechange, dans l'ordre, quand la personne repousse sans refuser.",
    whyFr:
      "Quelqu'un qui dit « pas cette semaine » n'a pas dit non — il a dit non À CETTE demande. Descendre d'un cran (visio 30 min → appel 15 min → courriel) convertit une partie de ces gens ; réinsister sur la même demande les perd.",
    effectFr:
      "UN refus mou = UN cran plus bas. Un refus FERME ne touche jamais la chaîne : la conversation se clôt. Le cran courant est écrit dans la couche d'exécution à chaque tour.",
    pitfallsFr:
      "Une chaîne trop longue prolonge des conversations déjà perdues. Deux replis suffisent presque toujours. Attention : la chaîne ne rattrape JAMAIS un vrai refus — elle ne s'applique qu'aux reports.",
    related: ["approach.persistence", "goal.primary.type"],
    // Un repli « appel » est un cran de RÉSERVATION : l'exemple porte le type
    // de rendez-vous que les outils d'agenda exigent (le schéma le complète
    // de toute façon, mais un exemple incomplet enseigne un format boiteux).
    example: [{ type: "phone_call", durationMin: 15, appointmentType: "meet" }],
  }),
  ...goalStepDocs("goal.fallbacks[]", "Repli"),
];

// ── Approche (L3) ────────────────────────────────────────────────────────────

const approach: ParamDoc[] = [
  doc({
    path: "approach.formality",
    section: "approach",
    labelFr: "Registre",
    type: "enum",
    required: true,
    defaultValue: "vous",
    allowed: [
      { value: "vous", labelFr: "Vouvoiement — recommandé au Québec pour un premier contact" },
      { value: "tu", labelFr: "Tutoiement" },
    ],
    whatFr: "Vouvoiement ou tutoiement.",
    whyFr:
      "Au Québec, un premier contact commercial au tutoiement peut passer pour de la familiarité déplacée — surtout pour une transaction de cette taille.",
    effectFr: "Consigne de rédaction en L3.",
    pitfallsFr:
      "Changer de registre en cours de conversation se remarque immédiatement et sonne faux.",
    related: ["approach.warmth"],
    example: "vous",
  }),
  doc({
    path: "approach.persistence",
    section: "approach",
    labelFr: "Persistance",
    type: "int",
    required: true,
    defaultValue: 3,
    allowed: [
      { value: 1, labelFr: "1 — une seule demande, puis lâche prise" },
      { value: 2, labelFr: "2 — une relance douce" },
      { value: 3, labelFr: "3 — jusqu'à deux relances espacées" },
      { value: 4, labelFr: "4 — relance avec constance" },
      { value: 5, labelFr: "5 — insiste" },
    ],
    whatFr:
      "Combien de fois l'assistant redemande le rendez-vous après un refus mou, la longueur de l'échelle de relances, et le moment du message de clôture.",
    whyFr:
      "Sépare un assistant de réactivation à froid, qui doit lâcher prise vite, d'un assistant sur un lead Facebook chaud, où deux relances sont normales.",
    effectFr:
      "Compilé en L3 et lu par le moteur de relances. Niveau 3 : deux redemandes, cinq touches, clôture au jour 14.",
    pitfallsFr:
      "Au-delà de 3, le taux de désabonnement grimpe avant le taux de réservation. Un taux de désabonnement supérieur à 3 % est presque toujours une persistance trop élevée, pas un mauvais message d'ouverture. La persistance ne passe JAMAIS outre un refus explicite.",
    related: ["approach.questionBudget", "goal.fallbacks", "campaign.ladder"],
    example: 3,
  }),
  doc({
    path: "approach.questionBudget",
    section: "approach",
    labelFr: "Budget de questions",
    type: "int",
    required: true,
    defaultValue: 3,
    whatFr:
      "Le nombre de questions de qualification que l'assistant consacre à toute la conversation. En mode STRICT, c'est un plafond absolu : une fois épuisé, il propose avec ce qu'il a. En mode SOUPLE, c'est une cible — le mur, c'est le plafond de questions.",
    whyFr:
      "Chaque question est une occasion de ne pas répondre. Qualifier suffisamment sans transformer l'échange en interrogatoire est l'arbitrage central d'un assistant SMS.",
    effectFr:
      "Consigne chiffrée en L3. Ce que ce nombre VEUT DIRE dépend du mode de qualification : en mode strict c'est un plafond absolu (depuis le 2026-08-22 — la formulation précédente, « avant la première proposition », laissait l'assistant relancer un interrogatoire après un premier refus) ; en mode souple c'est une cible, et c'est le plafond de questions qui devient le mur.",
    pitfallsFr:
      "Au-delà de 3, le taux d'abandon en cours de conversation monte nettement. Symptôme : des fils qui s'arrêtent après la deuxième ou troisième question. En mode STRICT, un budget plus petit que le nombre d'informations requises est contradictoire : l'assistant n'aura jamais le droit de réserver. C'est exactement ce que le mode souple corrige.",
    related: ["goal.primary.requiredFields", "approach.persistence", "approach.qualificationMode"],
    example: 3,
  }),
  doc({
    path: "approach.qualificationMode",
    section: "approach",
    labelFr: "Mode de qualification",
    type: "enum",
    required: true,
    defaultValue: "strict",
    allowed: [
      { value: "strict", labelFr: "Strict — le budget est un mur" },
      { value: "flexible", labelFr: "Souple — le budget est une cible, l'assistant s'adapte" },
    ],
    whatFr:
      "Comment se lit le budget de questions. « Strict » : l'assistant pose son nombre de questions, puis propose. « Souple » : le budget devient une cible et le plafond de questions devient le mur — répondre à une question de la personne ne consomme rien, une information déjà connue ne se redemande pas, et l'assistant propose dès qu'il tient les informations requises au lieu de finir son quota.",
    whyFr:
      "Un nombre fixe traite de la même façon quelqu'un qui a tout dit dans son premier message et quelqu'un qui répond par « ok ». Le mode souple laisse la conversation décider, sans lâcher l'objectif : l'assistant peut écrire moins quand il en sait déjà assez, et un peu plus quand la personne s'engage vraiment.",
    effectFr:
      "Change le paragraphe de qualification compilé en L3. Le mode strict produit le texte d'origine, à l'octet près — basculer d'un mode à l'autre demande une recompilation, comme tout ce qui vit dans le prompt.",
    pitfallsFr:
      "Souple n'est pas « sans limite » : le plafond de questions et le budget de messages restent des murs. Et souple ne remplace pas des informations requises bien choisies — c'est la liste des informations requises qui dit quand l'assistant a fini, le budget ne fait que le borner.",
    related: ["approach.questionBudget", "approach.questionCeiling", "goal.primary.requiredFields"],
    example: "strict",
  }),
  doc({
    path: "approach.questionCeiling",
    section: "approach",
    labelFr: "Plafond de questions",
    type: "int",
    required: true,
    defaultValue: 5,
    whatFr:
      "En mode souple : le nombre de questions de qualification au-delà duquel l'assistant n'insiste plus, quoi qu'il arrive. Il ne dépasse la cible que s'il lui manque encore une information requise ET que la personne s'engage. Ignoré en mode strict.",
    whyFr:
      "« Souple » sans mur devient un interrogatoire dès que quelqu'un répond volontiers. Le plafond est ce qui rend la souplesse tenable : la conversation décide du rythme, jamais de la fin.",
    effectFr:
      "Compilé en L3, uniquement en mode souple. Un plafond inférieur à la cible est relevé à la cible au moment de compiler : deux nombres qui se contredisent dans la même consigne la font écarter en entier.",
    pitfallsFr:
      "Un plafond très au-dessus de la cible (10 contre 3) rend la cible décorative : l'écart est ce que l'assistant s'autorise, pas une réserve. Deux de plus que la cible est un bon point de départ.",
    related: ["approach.qualificationMode", "approach.questionBudget", "approach.maxTurns"],
    example: 5,
  }),
  doc({
    path: "approach.maxChars",
    section: "approach",
    labelFr: "Longueur maximale",
    type: "int",
    required: true,
    defaultValue: 300,
    whatFr: "Longueur maximale d'un message sortant, en caractères.",
    whyFr:
      "Un SMS long se lit comme du publipostage. Il coûte aussi plus cher : au-delà de 160 caractères (ou 70 avec un accent hors table GSM), le message est facturé en plusieurs segments.",
    effectFr:
      "Consigne en L3, et une règle de garde-fou peut la faire respecter à l'envoi.",
    pitfallsFr:
      "Un maximum élevé produit des messages à deux ou trois segments : coût multiplié et lecture pénible sur un téléphone. Une limite en caractères ne tient PAS un budget : 300 caractères valent deux segments sans accents et cinq avec.",
    related: [
      "guardrails.max_chars",
      "goal.primary.slotOfferCount",
      "approach.segmentBudget.maxSegments",
    ],
    example: 300,
  }),
  doc({
    path: "approach.segmentBudget.maxSegments",
    section: "approach",
    labelFr: "Plafond de segments",
    type: "enum",
    required: false,
    defaultValue: null,
    allowed: [
      { value: null, labelFr: "Aucun plafond — la longueur seule décide" },
      { value: 1, labelFr: "1 segment — 70 caractères accentués, 160 sans accents" },
      { value: 2, labelFr: "2 segments — 134 caractères accentués, 306 sans accents" },
      { value: 3, labelFr: "3 segments — 201 caractères accentués, 459 sans accents" },
      { value: 4, labelFr: "4 segments — 268 caractères accentués, 612 sans accents" },
    ],
    whatFr:
      "Le nombre de segments SMS qu'un message de cet assistant a le droit de coûter. Le segment est l'unité que le transporteur facture, pas le message.",
    whyFr:
      "Un SMS coûte 160 caractères par segment tant que tout tient dans la table GSM, et 70 dès qu'un seul caractère en sort — « ça », « peut-être », « français » suffisent. Un message français de 300 caractères est donc facturé cinq fois, pas une. C'est le cadran qui arbitre entre économiser des segments et laisser l'assistant écrire des messages complets.",
    effectFr:
      "Compilé en L3 : la consigne de longueur devient le nombre de caractères qui tient dans ce plafond, et la plus stricte des deux limites l'emporte. Relu à chaque tour par le moteur, qui mesure le brouillon avec le même calcul que l'expéditeur.",
    pitfallsFr:
      "Un plafond serré multiplie les réécritures : chacune est un appel de modèle facturé, et une économie de texto peut coûter plus cher en IA qu'elle ne rapporte. Un segment est très court pour une proposition de rendez-vous — deux est le premier réglage raisonnable.",
    related: [
      "approach.maxChars",
      "approach.segmentBudget.onOverflow",
      "approach.segmentBudget.economy",
    ],
    example: 2,
  }),
  doc({
    path: "approach.segmentBudget.onOverflow",
    section: "approach",
    labelFr: "Quand le message dépasse",
    type: "enum",
    required: true,
    defaultValue: "rewrite",
    allowed: [
      { value: "send", labelFr: "Laisser passer — le plafond n'est qu'une consigne" },
      { value: "rewrite", labelFr: "Faire réécrire — une seule fois, puis laisser passer" },
      { value: "trim", labelFr: "Faire réécrire, puis couper — la facture est garantie" },
    ],
    whatFr:
      "Ce que le moteur fait d'un brouillon qui dépasse le plafond. Sans plafond, ce réglage ne s'applique jamais.",
    whyFr:
      "Il y a deux façons honnêtes de tenir un budget : demander un message plus court, ou en amputer un. La première coûte un appel de modèle, la seconde coûte une phrase. Le choix appartient à l'exploitant, pas au code.",
    effectFr:
      "« Laisser passer » journalise le dépassement et n'y touche pas. « Faire réécrire » réutilise la régénération unique des garde-fous, avec une consigne qui donne le nombre de caractères visé. « Couper » n'intervient qu'au dernier passage, sur une fin de phrase ou de mot, jamais au milieu d'un mot.",
    pitfallsFr:
      "« Couper » retire la fin du message — c'est-à-dire, presque toujours, la question. Un fil qui n'obtient plus de réponse après ce réglage vient de là. « Laisser passer » ne fait tenir aucun budget : c'est une mesure, pas un plafond.",
    related: ["approach.segmentBudget.maxSegments", "approach.maxChars"],
    example: "rewrite",
  }),
  doc({
    path: "approach.segmentBudget.economy",
    section: "approach",
    labelFr: "Économie de caractères",
    type: "enum",
    required: true,
    defaultValue: "off",
    allowed: [
      { value: "off", labelFr: "Aucune — le texte part tel que le modèle l'écrit" },
      { value: "typography", labelFr: "Ponctuation droite — sans perte de sens" },
      { value: "ascii", labelFr: "Sans accents — « ça » devient « ca »" },
    ],
    whatFr:
      "Jusqu'où le moteur a le droit de retoucher les caractères avant l'envoi, pour faire tenir le même texte dans moins de segments.",
    whyFr:
      "C'est le levier le plus rentable et le seul qui ne retire rien au propos : une apostrophe courbe, un tiret cadratin ou des points de suspension font basculer tout le message de 160 à 70 caractères par segment. Les retirer ne change pas une phrase, mais peut diviser la facture par deux.",
    effectFr:
      "Appliqué au brouillon avant les garde-fous, pour qu'ils jugent le texte qui part vraiment. La retouche n'est CONSERVÉE que si elle fait réellement tomber un segment : un texte court qui tenait déjà garde ses accents.",
    pitfallsFr:
      "« Sans accents » abîme l'orthographe et se voit : pour un courtier, c'est une décision de marque, pas un réglage technique. Si le service Twilio a l'encodage intelligent activé, la ponctuation est déjà corrigée chez le transporteur — le réglage reste utile, il rend seulement le compte enregistré ici conforme à la facture.",
    related: [
      "approach.segmentBudget.maxSegments",
      "approach.emoji",
      "approach.segmentBudget.onOverflow",
    ],
    example: "typography",
  }),
  doc({
    path: "approach.proactivity",
    section: "approach",
    labelFr: "Proactivité",
    type: "int",
    required: true,
    defaultValue: 3,
    whatFr: "À quel point l'assistant propose au lieu d'attendre.",
    whyFr:
      "Une proactivité basse répond aux questions ; une proactivité haute ramène systématiquement vers la prise de rendez-vous.",
    effectFr: "Ton et cadrage en L3.",
    pitfallsFr:
      "Trop haute, chaque réponse se termine par la même demande et le fil devient répétitif.",
    related: ["approach.persistence"],
    example: 3,
  }),
  doc({
    path: "approach.warmth",
    section: "approach",
    labelFr: "Chaleur",
    type: "int",
    required: true,
    defaultValue: 3,
    whatFr: "Registre émotionnel : sec et efficace, ou chaleureux.",
    whyFr:
      "Le même message peut rassurer ou paraître expéditif selon le ton. Un vendeur inquiet répond mieux à de la chaleur ; un acheteur pressé, à de l'efficacité.",
    effectFr: "Ton en L3.",
    pitfallsFr:
      "Une chaleur maximale produit des formules toutes faites (« Excellente nouvelle! ») qui sonnent artificielles en SMS.",
    related: ["approach.formality"],
    example: 3,
  }),
  doc({
    path: "approach.emoji",
    section: "approach",
    labelFr: "Émojis",
    type: "enum",
    required: true,
    defaultValue: "none",
    allowed: [
      { value: "none", labelFr: "Aucun — capacité maximale, coût minimal" },
      { value: "rare", labelFr: "Rare — au plus un, occasionnellement" },
      { value: "moderate", labelFr: "Modéré — un par message quand le ton s'y prête" },
      { value: "lots", labelFr: "Beaucoup — deux ou trois par message, ton franchement familier" },
    ],
    whatFr: "Autorise ou non les émojis.",
    whyFr:
      "Au-delà du ton, un émoji fait basculer tout le message en encodage UCS-2 : la capacité tombe de 160 à 70 caractères et le coût d'envoi augmente.",
    effectFr: "Consigne en L3 ; l'analyseur de segments mesure l'effet réel.",
    pitfallsFr:
      "Un seul émoji peut doubler le nombre de segments d'un message déjà long — un coût invisible jusqu'à la facture. « Beaucoup » double donc le coût de presque tous les envois, et un ton très familier au premier contact fait signaler le message comme indésirable.",
    related: ["approach.maxChars"],
    example: "none",
  }),
  doc({
    path: "approach.replySpeed",
    section: "approach",
    labelFr: "Vitesse de réponse",
    type: "enum",
    required: true,
    defaultValue: "natural",
    allowed: [
      { value: "instant", labelFr: "Immédiate" },
      { value: "natural", labelFr: "Naturelle — environ 30 secondes" },
      { value: "deliberate", labelFr: "Posée — environ 90 secondes" },
    ],
    whatFr: "Délai avant l'envoi de la réponse.",
    whyFr:
      "Une réponse en 400 millisecondes signale une machine plus sûrement que n'importe quelle formulation. Un léger délai se lit comme quelqu'un d'occupé mais attentif.",
    effectFr: "Décale la mise en file de l'envoi ; les heures de politesse s'appliquent ensuite.",
    pitfallsFr:
      "« Posée » sur une conversation en cours donne l'impression d'être ignoré ; c'est surtout utile pour un premier contact.",
    related: ["campaign.quietHours"],
    example: "natural",
  }),
  doc({
    path: "approach.maxTurns",
    section: "approach",
    labelFr: "Budget de messages",
    type: "int",
    required: true,
    defaultValue: 16,
    whatFr:
      "Nombre total de messages que l'assistant peut envoyer dans une conversation avant de passer la main.",
    whyFr:
      "Une conversation qui n'aboutit pas en une quinzaine de messages n'aboutira pas toute seule. Cette limite garantit qu'un humain finit par voir le fil.",
    effectFr:
      "Seuls les messages de l'ASSISTANT comptent — la réponse manuelle d'un téléphoniste n'entame pas le budget. Au plafond, la conversation est marquée « à traiter » et l'IA se tait.",
    pitfallsFr:
      "Trop bas, des conversations prometteuses sont interrompues au milieu. Trop haut, personne ne regarde jamais les fils qui tournent en rond.",
    related: ["approach.persistence"],
    example: 16,
  }),
  doc({
    path: "approach.quietHours.tz",
    section: "approach",
    labelFr: "Fuseau de la fenêtre",
    type: "string",
    required: true,
    defaultValue: "America/Toronto",
    whatFr: "Fuseau horaire dans lequel s'interprètent les heures de travail.",
    whyFr:
      "« De 9 h à 20 h » n'a de sens que dans un fuseau ; l'app est au Québec, donc heure de Toronto.",
    effectFr: "Toutes les heures de fenêtre (semaine, samedi, dimanche) s'entendent dans ce fuseau.",
    pitfallsFr: "À ne pas changer sans raison : le CRM et l'affichage supposent partout America/Toronto.",
    related: ["approach.quietHours.weekday"],
    example: "America/Toronto",
  }),
  doc({
    path: "approach.quietHours.weekday",
    section: "approach",
    labelFr: "Heures de travail — semaine",
    type: "array",
    required: true,
    defaultValue: [9, 20],
    whatFr: "Fenêtre d'envoi du lundi au vendredi : [heure de début, heure de fin], fin exclue.",
    whyFr:
      "Le garde-fou contre un texto à 3 h : hors de cette fenêtre, tout envoi automatisé de l'assistant est reporté à la prochaine ouverture, jamais expédié.",
    effectFr:
      "Vérifiée au dernier verrou (`handleSendSms`) ET par le planificateur de campagne. Un message dû la nuit repart le matin, étalé.",
    pitfallsFr:
      "La fin doit suivre le début (9 à 20, pas 20 à 9). Une fenêtre trop serrée retarde beaucoup d'envois au même créneau.",
    related: ["approach.quietHours.saturday", "approach.quietHours.sunday"],
    example: [9, 20],
  }),
  doc({
    path: "approach.quietHours.saturday",
    section: "approach",
    labelFr: "Heures de travail — samedi",
    type: "array",
    required: true,
    defaultValue: [10, 20],
    whatFr: "Fenêtre d'envoi du samedi : [début, fin], fin exclue.",
    whyFr: "Le samedi n'ouvre pas aussi tôt qu'un jour de semaine — on ne texte pas à 8 h le week-end.",
    effectFr: "S'applique aux envois automatisés le samedi, en heure locale.",
    pitfallsFr: "La fin doit suivre le début.",
    related: ["approach.quietHours.weekday"],
    example: [10, 20],
  }),
  doc({
    path: "approach.quietHours.sunday",
    section: "approach",
    labelFr: "Heures de travail — dimanche",
    type: "array",
    required: true,
    defaultValue: [11, 19],
    whatFr: "Fenêtre d'envoi du dimanche : [début, fin], fin exclue.",
    whyFr: "Le dimanche ouvre plus tard et ferme plus tôt — la plus courte des trois par défaut.",
    effectFr: "S'applique aux envois automatisés le dimanche, en heure locale.",
    pitfallsFr: "La fin doit suivre le début.",
    related: ["approach.quietHours.weekday"],
    example: [11, 19],
  }),
];

// ── Connaissances, objections, outils ───────────────────────────────────────

const knowledge: ParamDoc[] = [
  doc({
    path: "knowledge.claims",
    section: "knowledge",
    labelFr: "Connaissances et consignes",
    type: "array",
    required: true,
    defaultValue: [],
    whatFr:
      "La liste ORDONNÉE de ce que l'assistant sait et de ce qu'il doit faire. Une entrée est soit un fait d'affaires qu'il a le droit d'affirmer, soit une consigne de conduite — « si la personne demande le prix, réponds que c'est Alex qui en parle », « ne parle jamais de la commission », « commence par la remercier de sa demande ».",
    whyFr:
      "Le noyau interdit d'inventer quoi que ce soit : pour les faits, cette liste est la seule porte de sortie — ce qui n'y est pas ne peut pas être affirmé. Pour la conduite, c'est l'endroit où dicter le déroulé sans réécrire le prompt : « dans cet ordre, si… alors… ».",
    effectFr:
      "Compilée en L4, dans l'ordre saisi et numérotée. Le prompt annonce explicitement qu'une entrée-fait s'affirme et qu'une entrée-consigne s'applique, et qu'en cas de contradiction la PREMIÈRE l'emporte. Une liste vide interdit toute affirmation d'affaires.",
    pitfallsFr:
      "Tout ce qui est écrit ici sera affirmé PAR ÉCRIT, au nom d'un courtier titulaire d'un permis : une statistique, une promesse de délai ou un chiffre de marché y devient une déclaration dont le courtier répond devant l'OACIQ. Et une consigne d'ici ne lève JAMAIS un garde-fou — « donne le prix » écrit ici sera bloqué à l'envoi, sans que le modèle comprenne pourquoi.",
    related: ["guardrails.no_fabrication", "turnInstructions", "layerOverrides.text"],
    example: [
      "Nous couvrons la région de Québec et Lévis.",
      "Si la personne demande une évaluation gratuite, propose la rencontre de 30 minutes.",
    ],
  }),
];

const objections: ParamDoc[] = [
  doc({
    path: "objectionPacks",
    section: "objections",
    labelFr: "Paquets d'objections",
    type: "array",
    required: true,
    defaultValue: [],
    whatFr:
      "Les paquets de réponses aux objections courantes que l'assistant peut mobiliser.",
    whyFr:
      "Sans eux, le modèle improvise face à « j'ai déjà un courtier » — et improvise parfois quelque chose d'inexact ou de trop insistant. Un paquet fixe la structure : reconnaître, recadrer, redemander.",
    effectFr: "Rendus en L5, pack par pack, dans l'ordre choisi.",
    pitfallsFr:
      "Charger tous les paquets allonge le prompt sans profit : un assistant vendeur n'a pas besoin des objections d'acheteur.",
    related: ["knowledge.claims"],
    example: ["seller_fr"],
  }),
];

const TOOL_DOCS: { name: string; whatFr: string; whyFr: string; pitfallsFr: string }[] = [
  {
    name: "read_client",
    whatFr:
      "Lit la fiche du contact — nom, ville, projet, échéance, budget, catégorie, source, dernier contact, notes et qualification déjà connue.",
    whyFr:
      "L'assistant arrive dans la conversation en SACHANT à qui il parle, au lieu de reposer des questions dont la réponse dort déjà sur la fiche. Lecture seule, bornée à la fiche du contact de cette conversation.",
    pitfallsFr:
      "Le désactiver n'empêche pas l'assistant d'écrire, mais il repart alors de zéro à chaque conversation, aveugle à ce que le CRM sait déjà.",
  },
  {
    name: "read_client_comments",
    whatFr: "Lit les notes internes que l'équipe a laissées sur la fiche (le sous-outil de read_client).",
    whyFr:
      "« Sérieux, rappeler après 17 h », « a déjà un courtier mais ouvert » : le contexte humain qu'un téléphoniste a écrit après un appel, qu'aucun formulaire de lead ne porte. Lecture seule.",
    pitfallsFr:
      "Ces notes sont INTERNES : l'assistant est instruit de ne pas les citer mot pour mot à la personne. Le désactiver si ces notes ne doivent pas influencer les réponses de l'assistant.",
  },
  {
    name: "add_client_comment",
    whatFr: "Écrit une note interne sur la fiche — le pendant écriture de read_client_comments.",
    whyFr:
      "« A déjà un courtier mais reste ouverte », « a acheté ailleurs en juin » : ce que le contact révèle par SMS mérite le même sort que ce qu'un téléphoniste note après un appel — sur la fiche, pas enterré dans le fil. La note est signée de l'assistant et n'est jamais envoyée au contact.",
    pitfallsFr:
      "La note apparaît dans les commentaires de la fiche, attribuée à l'assigné (ou à un administrateur) mais SIGNÉE de l'assistant. Une note par tour au maximum.",
  },
  {
    name: "get_slots",
    whatFr: "Retourne les disponibilités RÉELLES du courtier.",
    whyFr:
      "Sans cet outil, le modèle propose des heures inventées et le client se heurte à un refus au moment de confirmer.",
    pitfallsFr:
      "Le désactiver sur un objectif de rencontre rend l'assistant incapable de proposer un moment.",
  },
  {
    name: "book_meeting",
    whatFr: "Crée le rendez-vous dans l'agenda.",
    whyFr: "C'est l'aboutissement : sans lui, l'assistant ne peut que promettre un rappel.",
    pitfallsFr:
      "Le désactiver force l'objectif en « qualifier seulement ». L'outil REFUSE tant qu'un champ requis manque.",
  },
  {
    name: "update_qualification",
    whatFr: "Enregistre ce que la personne vient de révéler.",
    whyFr:
      "Ce qui n'est pas enregistré est reperdu au tour suivant — et le client se fait reposer la même question.",
    pitfallsFr: "Le désactiver fait tourner l'assistant en rond sur les mêmes questions.",
  },
  {
    name: "schedule_followup",
    whatFr: "Pose un rappel (une tâche pour le courtier) à la date convenue — ou au prochain matin si la personne n'a pas précisé de moment.",
    whyFr:
      "« Rappelez-moi en juin » n'a de valeur que si quelque chose s'en souvient en juin — et « appelez-moi » tout court doit devenir une tâche tout de suite, pas une question de plus.",
    pitfallsFr: "Sans lui, les reports lointains et les demandes d'appel sont perdus.",
  },
  {
    name: "set_category",
    whatFr: "Range la fiche dans une catégorie du pipeline, selon les règles de classement.",
    whyFr:
      "L'assistant apprend en deux messages ce qu'un téléphoniste met un appel à découvrir — « je veux acheter, mais l'an prochain », « je suis au Saguenay ». Sans cet outil, l'information reste dans le fil et la fiche dort dans « Non contacté » jusqu'à ce que quelqu'un la relise.",
    pitfallsFr:
      "Sans règle de classement configurée, l'outil n'a AUCUNE catégorie permise et n'est jamais appelé — il ne sert à rien tant que les règles ne sont pas écrites. Une règle vers « Ne pas appeler » donnerait à l'assistant le pouvoir de sortir quelqu'un du pipeline sur une phrase mal comprise : cette catégorie-là se pose à la main.",
  },
  {
    name: "stop",
    whatFr: "Arrête définitivement et supprime le numéro.",
    whyFr:
      "C'est l'outil du respect du refus. Le désactiver n'empêche pas les désabonnements — le mot-clé STOP est traité en amont, hors du modèle — mais prive l'assistant du moyen de s'arrêter proprement sur une formulation en langage naturel.",
    pitfallsFr: "À ne jamais désactiver.",
  },
  {
    name: "handoff",
    whatFr: "Passe la conversation à un humain.",
    whyFr:
      "Un assistant qui ne peut pas passer la main insiste face à une question légale, une plainte ou de l'agressivité.",
    pitfallsFr: "À ne jamais désactiver.",
  },
  {
    name: "transfer_assistant",
    whatFr: "Bascule la conversation vers un autre assistant.",
    whyFr:
      "Un lead acheteur qui se révèle vendeur mérite l'assistant vendeur, pas une conversation mal cadrée.",
    pitfallsFr: "Un transfert en boucle est possible si deux assistants se renvoient la balle.",
  },
  {
    name: "close_conversation",
    whatFr: "Clôt la conversation avec une issue.",
    whyFr: "Distingue un fil abouti d'un fil abandonné dans les statistiques.",
    pitfallsFr: "Une clôture prématurée fausse le taux de conversion.",
  },
];

const tools: ParamDoc[] = [
  doc({
    path: "tools",
    section: "tools",
    labelFr: "Outils activés",
    type: "array",
    required: true,
    whatFr: "Les outils que l'assistant a le droit d'appeler.",
    whyFr:
      "Un outil absent est une capacité absente : le modèle ne peut pas contourner la liste. C'est un garde-fou de capacité, pas seulement une commodité.",
    effectFr: "Seuls les outils cochés sont présentés au modèle à chaque tour.",
    pitfallsFr:
      "Offrir sept outils à un modèle qui ne les gère pas échoue en silence et ressemble à un bogue de prompt — le sélecteur de modèle affiche le support des outils pour cette raison.",
    related: ["model.model", "goal.primary.type"],
    example: ["get_slots", "book_meeting", "stop", "handoff"],
  }),
  ...TOOL_DOCS.map((t) =>
    doc({
      path: `tools.${t.name}`,
      section: "tools" as const,
      labelFr: `Outil « ${t.name} »`,
      type: "bool" as const,
      required: false,
      whatFr: t.whatFr,
      whyFr: t.whyFr,
      pitfallsFr: t.pitfallsFr,
      related: ["tools"],
    }),
  ),
];

// ── Modèle ───────────────────────────────────────────────────────────────────

const model: ParamDoc[] = [
  doc({
    path: "model.provider",
    section: "model",
    labelFr: "Fournisseur",
    type: "enum",
    required: true,
    defaultValue: "openrouter",
    allowed: [
      { value: "openrouter", labelFr: "OpenRouter — un accès, tous les modèles" },
      { value: "anthropic", labelFr: "Anthropic — direct" },
      { value: "google", labelFr: "Google — direct" },
      { value: "openai", labelFr: "OpenAI — direct" },
    ],
    whatFr: "Par où passent les appels au modèle.",
    whyFr:
      "OpenRouter offre une seule intégration et le changement de modèle sans redéploiement ; il coûte un saut réseau, une marge, et UN intermédiaire de plus à inscrire dans une évaluation Loi 25. Un fournisseur direct retire cet intermédiaire au prix d'une deuxième clé.",
    effectFr: "Choisit l'implémentation utilisée ; l'objet de routage ne vaut que pour OpenRouter.",
    pitfallsFr:
      "Changer de fournisseur change aussi les identifiants de modèle : « anthropic/claude-sonnet-5 » chez OpenRouter s'appelle « claude-sonnet-5 » en direct.",
    related: ["model.model", "model.routing.zdr"],
    example: "openrouter",
  }),
  doc({
    path: "model.model",
    section: "model",
    labelFr: "Modèle générateur",
    type: "string",
    required: true,
    defaultValue: "anthropic/claude-sonnet-5",
    whatFr: "Le modèle qui rédige les messages.",
    whyFr:
      "C'est lui qui tient — ou non — les contraintes : une seule question, pas de prix, pas d'invention. Les écarts entre modèles se voient surtout là.",
    effectFr: "Utilisé à chaque tour ; le modèle réellement servi est consigné dans la trace.",
    pitfallsFr:
      "Un identifiant inexistant fait échouer TOUS les appels : les juges échouent alors par fermeture et plus aucun message ne part. Vérifiez l'identifiant dans le sélecteur plutôt que de le taper. Évitez les alias « -latest », qui disparaissent sans préavis.",
    related: ["model.provider", "model.classifier.model"],
    example: "anthropic/claude-sonnet-5",
  }),
  doc({
    path: "model.temperature",
    section: "model",
    labelFr: "Température",
    type: "int",
    required: true,
    defaultValue: 0.6,
    whatFr: "Degré de variation des réponses, de 0 à 1.",
    whyFr:
      "Trop bas, les messages deviennent identiques d'un lead à l'autre — et les opérateurs de réseau détectent le contenu répété. Trop haut, le modèle s'écarte des consignes.",
    effectFr: "Passé tel quel au fournisseur.",
    pitfallsFr:
      "Au-delà de 0,8, les écarts aux garde-fous augmentent et le taux de blocage monte.",
    related: ["model.model"],
    example: 0.6,
  }),
  doc({
    path: "model.maxTokens",
    section: "model",
    labelFr: "Jetons maximum",
    type: "int",
    required: true,
    defaultValue: 300,
    whatFr: "Longueur maximale de la réponse du modèle, en jetons.",
    whyFr: "Un SMS est court ; laisser de la marge coûte sans rien apporter.",
    effectFr: "Plafond envoyé au fournisseur.",
    pitfallsFr:
      "Trop bas, la réponse est coupée en plein milieu et part tronquée. 300 laisse la marge nécessaire.",
    related: ["approach.maxChars"],
    example: 300,
  }),
  doc({
    path: "model.reasoningEffort",
    section: "model",
    labelFr: "Niveau de réflexion",
    type: "enum",
    required: true,
    defaultValue: "none",
    allowed: [
      { value: "none", labelFr: "Aucun — le modèle répond directement" },
      { value: "low", labelFr: "Léger" },
      { value: "medium", labelFr: "Moyen" },
      { value: "high", labelFr: "Élevé — réfléchit longuement avant d'écrire" },
    ],
    whatFr:
      "Combien le modèle réfléchit avant de répondre, quand il sait le faire.",
    whyFr:
      "Plus de réflexion améliore les décisions difficiles — quel outil appeler, faut-il passer la main. Sur un SMS de deux phrases, ça ne change presque rien à la formulation.",
    effectFr: "Envoyé au fournisseur (routeur ou direct) dans son dialecte, à chaque appel, seulement si différent de « aucun ».",
    pitfallsFr:
      "La réflexion est FACTURÉE en jetons et ajoute de la latence : un niveau élevé peut ajouter plusieurs secondes avant chaque réponse, ce qui se remarque dans une conversation. L'envoyer à un modèle qui ne le gère pas fait rejeter la requête entière — le sélecteur n'offre l'étape que pour les modèles compatibles.",
    related: ["model.model", "approach.replySpeed"],
    example: "none",
  }),
  doc({
    path: "model.classifier.provider",
    section: "model",
    labelFr: "Fournisseur du classifieur",
    type: "enum",
    required: true,
    defaultValue: "openrouter",
    allowed: [
      { value: "openrouter", labelFr: "OpenRouter" },
      { value: "anthropic", labelFr: "Anthropic — direct" },
      { value: "google", labelFr: "Google — direct" },
      { value: "openai", labelFr: "OpenAI — direct" },
    ],
    whatFr: "Par où passent les appels du classifieur et des juges.",
    whyFr:
      "Le classifieur tourne à chaque message entrant et les juges à chaque brouillon : c'est le poste de coût le plus sensible du moteur.",
    effectFr: "Utilisé pour la classification et les règles « llm_judge ».",
    pitfallsFr: "Un fournisseur non configuré fait échouer les juges — donc tout bloquer.",
    related: ["model.classifier.model"],
    example: "openrouter",
  }),
  doc({
    path: "model.classifier.model",
    section: "model",
    labelFr: "Modèle classifieur",
    type: "string",
    required: true,
    defaultValue: "google/gemini-2.5-flash",
    whatFr:
      "Le modèle qui classe les messages entrants (désabonnement, refus, qualification) et qui juge les brouillons.",
    whyFr:
      "Ces tâches sont mécaniques : un modèle économique et rapide y suffit. Mélanger un classifieur bon marché et un générateur fort est la configuration PRÉVUE, pas un cas limite.",
    effectFr: "Appelé une fois par message entrant, plus une fois par règle « llm_judge ».",
    pitfallsFr:
      "Un identifiant invalide fait échouer les juges, qui échouent par fermeture : plus AUCUN message ne part et la conversation est marquée « garde-fou indisponible ». C'est exactement ce qui arrive avec un alias « -latest » retiré.",
    related: ["model.model", "guardrails.llm_judge"],
    example: "google/gemini-2.5-flash",
  }),
  doc({
    path: "model.retry.attempts",
    section: "model",
    labelFr: "Tentatives",
    type: "int",
    required: true,
    defaultValue: 3,
    whatFr:
      "Combien de fois un appel est tenté quand l'amont refuse pour cause d'encombrement (429) ou de panne passagère (5xx), AVANT de changer de modèle.",
    whyFr:
      "« openai/gpt-5.6-luna is temporarily rate-limited upstream. Please retry shortly » : l'amont demande lui-même une reprise. Un refus d'encombrement n'a rien produit — le rejouer ne coûte rien de plus, et une seconde d'attente vaut mieux qu'une conversation escaladée ou une fixture rouge.",
    effectFr:
      "1 = aucune reprise, on passe directement au repli. La reprise s'applique au générateur comme au classifieur, en production, dans le bac à sable et dans la suite.",
    pitfallsFr:
      "Monter à 5 avec un écart long fait patienter chaque tour d'agent : le cycle de répartition a quatre minutes pour TOUTES les conversations. L'attente cumulée d'un appel reste plafonnée (20 s), donc au-delà d'un certain réglage les dernières tentatives n'ont simplement pas lieu.",
    related: ["model.retry.delaySec", "model.fallbacks"],
    example: 3,
  }),
  doc({
    path: "model.retry.delaySec",
    section: "model",
    labelFr: "Écart avant la reprise (s)",
    type: "int",
    required: true,
    defaultValue: 0.8,
    whatFr:
      "L'attente avant la PREMIÈRE reprise, en secondes. Les suivantes triplent (0,8 s puis 2,4 s, etc.), avec un bruit de ±25 %.",
    whyFr:
      "Reprendre à la milliseconde près ne fait que consommer un deuxième refus, et relancer douze conversations exactement en même temps recrée l'embouteillage qu'on fuit.",
    effectFr:
      "Quand l'amont renvoie un en-tête « Retry-After », c'est LUI qui gagne : il sait quand il sera de nouveau disponible. Une attente est plafonnée à 10 s, et l'attente cumulée d'un appel à 20 s.",
    pitfallsFr:
      "Un écart long sur un modèle souvent saturé retarde chaque réponse SMS sans rien garantir : au-delà de deux ou trois secondes, mieux vaut un repli chez un autre fournisseur.",
    related: ["model.retry.attempts", "model.fallbacks"],
    example: 0.8,
  }),
  doc({
    path: "model.fallbacks",
    section: "model",
    labelFr: "Chaîne de replis",
    type: "object",
    required: false,
    whatFr:
      "Les fournisseurs et modèles appelés, DANS L'ORDRE, si le principal échoue de façon rejouable. Jusqu'à trois crans.",
    whyFr:
      "Une panne 5xx, un délai dépassé ou un compte à sec ne doit pas faire taire l'assistant. Le repli est explicite ici, jamais décidé par le routeur — et un seul remplaçant ne suffit pas les jours où l'incident touche tout le monde.",
    effectFr:
      "Un encombrement passager (429, 5xx) est d'abord REPRIS sur le modèle principal, brièvement. S'il persiste, les crans sont essayés dans l'ordre, le premier qui répond gagne. Une erreur non rejouable (requête fautive) remonte telle quelle, sans descendre la chaîne.",
    pitfallsFr:
      "Oublier que l'identifiant du modèle diffère chez le repli : le nouvel essai échoue alors aussi. Symptôme : une alerte qui nomme la panne d'origine suivie de « (repli 1 … : llm_http_404) ».",
    related: ["model.provider", "model.routing.allowFallbacks"],
  }),
  doc({
    path: "model.routing.dataCollection",
    section: "model",
    labelFr: "Collecte de données (OpenRouter)",
    type: "enum",
    required: true,
    defaultValue: "deny",
    allowed: [
      { value: "deny", labelFr: "Refuser — recommandé" },
      { value: "allow", labelFr: "Autoriser" },
    ],
    whatFr: "Interdit aux fournisseurs en aval d'entraîner leurs modèles sur ces échanges.",
    whyFr:
      "Ces prompts contiennent des noms, des numéros, des budgets et des projets de déménagement de résidents du Québec. Ce n'est pas de la donnée d'essai.",
    effectFr: "Envoyé dans l'objet de routage à chaque appel.",
    pitfallsFr:
      "Ce réglage n'est PAS le même que ZDR : l'un interdit l'entraînement, l'autre la rétention. Il faut les deux.",
    related: ["model.routing.zdr"],
    example: "deny",
  }),
  doc({
    path: "model.routing.zdr",
    section: "model",
    labelFr: "Rétention nulle (ZDR)",
    type: "bool",
    required: true,
    defaultValue: true,
    whatFr: "N'achemine que vers des fournisseurs qui ne conservent pas les prompts au repos.",
    whyFr:
      "Complément indispensable du réglage précédent : un fournisseur peut respecter l'un sans l'autre.",
    effectFr: "Envoyé dans l'objet de routage ; restreint le bassin de fournisseurs disponibles.",
    pitfallsFr:
      "Restreindre le bassin peut augmenter la latence ou réduire la disponibilité. C'est attendu — ne pas « régler » ça en désactivant l'option.",
    related: ["model.routing.dataCollection"],
    example: true,
  }),
  doc({
    path: "model.routing.allowFallbacks",
    section: "model",
    labelFr: "Reroutage automatique (OpenRouter)",
    type: "bool",
    required: true,
    defaultValue: false,
    whatFr: "Autorise ou non le routeur à basculer seul vers un autre fournisseur en aval.",
    whyFr:
      "Un reroutage silencieux vers un fournisseur dont le chemin de données n'a pas été validé annule précisément la garantie qu'on vient de poser. Mieux vaut une panne visible.",
    effectFr: "Envoyé dans l'objet de routage. Notre propre repli reste explicite.",
    pitfallsFr:
      "L'activer pour « améliorer la disponibilité » réintroduit l'incertitude sur le traitement des données.",
    related: ["model.fallbacks"],
    example: false,
  }),
  doc({
    path: "model.routing.only",
    section: "model",
    labelFr: "Fournisseurs autorisés",
    type: "array",
    required: false,
    defaultValue: [],
    whatFr: "Restreint le routage à une liste de fournisseurs en aval.",
    whyFr: "Utile quand une évaluation de conformité n'a validé que certains hébergeurs.",
    effectFr: "Envoyé dans l'objet de routage quand la liste n'est pas vide.",
    pitfallsFr: "Une liste trop étroite provoque des indisponibilités intermittentes.",
    related: ["model.routing.zdr"],
    example: [],
  }),
];

// ── Prompt ───────────────────────────────────────────────────────────────────

const prompt: ParamDoc[] = [
  doc({
    path: "promptMode",
    section: "prompt",
    labelFr: "Mode de prompt",
    type: "enum",
    required: true,
    defaultValue: "composed",
    allowed: [
      { value: "composed", labelFr: "Composé — assemblé depuis les onglets" },
      { value: "raw", labelFr: "Libre — un seul document que vous écrivez" },
    ],
    whatFr: "Comment le prompt système est produit.",
    whyFr:
      "Le mode composé garde la config et le prompt synchronisés. Le mode libre donne le contrôle total quand un cas sort du cadre — au prix de devoir tout maintenir à la main.",
    effectFr:
      "En mode libre, le compilateur est court-circuité : la config continue de piloter l'exécution (crans, champs requis, outils, garde-fous) mais n'écrit plus une ligne du prompt.",
    pitfallsFr:
      "Passer en libre fige le texte : une modification d'un onglet ne s'y répercute plus, et une nouvelle version du noyau non plus. Le retour au mode composé conserve le texte libre sans l'utiliser.",
    related: ["layerOverrides", "systemPromptOverride"],
    example: "composed",
  }),
  doc({
    path: "systemPromptOverride",
    section: "prompt",
    labelFr: "Prompt libre",
    type: "text",
    required: false,
    defaultValue: null,
    whatFr: "Le prompt système intégral, utilisé quand le mode est « libre ».",
    whyFr: "Permet de reprendre la main entièrement, sans perdre la configuration structurée.",
    effectFr:
      "Remplace L0 à L6. Si le texte contient {{runtime}}, la couche d'exécution s'y insère ; sinon elle est ajoutée à la fin.",
    pitfallsFr:
      "Y recopier le noyau sans ses limites OACIQ retire les protections professionnelles du prompt — les garde-fous d'exécution tiennent encore, mais le modèle n'est plus guidé.",
    related: ["promptMode", "includeRuntimeLayer"],
  }),
  doc({
    path: "layerOverrides",
    section: "prompt",
    labelFr: "Surcouches par couche",
    type: "object",
    required: false,
    defaultValue: {},
    whatFr:
      "Remplace ou complète une couche précise du prompt compilé, sans abandonner les autres.",
    whyFr:
      "Souvent, une seule couche doit être ajustée. Basculer tout le prompt en libre pour ça ferait perdre la synchronisation de tout le reste.",
    effectFr:
      "« remplacer » substitue le bloc généré ; « ajouter » l'écrit à la suite. La couche modifiée est signalée dans l'onglet Prompt, avec un différentiel contre sa version générée.",
    pitfallsFr:
      "Remplacer L0 retire le noyau professionnel de ce prompt : les limites OACIQ ne sont plus énoncées au modèle.",
    related: ["promptMode"],
    example: { L3: { mode: "append", text: "Ne propose jamais de rencontre le dimanche." } },
  }),
  doc({
    path: "turnInstructions",
    section: "prompt",
    labelFr: "Gabarit de la couche d'exécution (L7)",
    type: "text",
    required: false,
    defaultValue: null,
    whatFr:
      "Le bloc reconstruit à CHAQUE tour : contexte du lead, qualification, cran courant, disponibilités, heure locale.",
    whyFr:
      "C'est ce qui donne au modèle l'état réel de la conversation. Sans lui, il improvise à partir du seul historique.",
    effectFr: "Rendu avec les variables du tour et ajouté au prompt compilé.",
    pitfallsFr:
      "Une variable inconnue rend une chaîne vide et lève un avertissement — jamais une erreur : une faute de frappe ne doit pas interrompre une conversation. Retirer {{slots}} fait proposer des heures inventées.",
    related: ["includeRuntimeLayer"],
  }),
  doc({
    path: "includeRuntimeLayer",
    section: "prompt",
    labelFr: "Inclure la couche d'exécution",
    type: "bool",
    required: true,
    defaultValue: true,
    whatFr: "Ajoute ou non le bloc L7 au prompt à chaque tour.",
    whyFr: "Le désactiver n'a de sens que si le prompt libre reconstruit cet état autrement.",
    effectFr: "À false, le modèle ne reçoit ni le cran courant, ni les disponibilités réelles.",
    pitfallsFr:
      "Désactivé, l'assistant ignore l'objectif courant et les heures disponibles : il propose des moments qui n'existent pas. L'exécution continue d'exiger les champs requis avant de réserver, mais le modèle ne sait plus lesquels.",
    related: ["turnInstructions", "promptMode"],
    example: true,
  }),
  doc({
    path: "requireSuitePass",
    section: "guardrails",
    labelFr: "Exiger une suite verte",
    type: "bool",
    required: true,
    defaultValue: true,
    whatFr:
      "Empêche l'activation tant que la suite de garde-fous n'est pas verte.",
    whyFr:
      "C'est la barrière entre « ça compile » et « ça se comporte correctement ». La désactiver reste possible — la suite s'exécute et s'affiche quand même —, mais l'échec devient un avertissement au lieu d'un blocage.",
    effectFr:
      "Vérifié dans l'action serveur ET par un déclencheur en base : une écriture directe ne contourne pas la porte. L'exigence de recompilation, elle, tient toujours.",
    pitfallsFr:
      "Désactivé, un assistant peut partir en production avec une fixture bloquante rouge — par exemple sans respecter un STOP.",
    related: ["guardrails.severity"],
    example: true,
  }),
  doc({
    path: "name",
    section: "identity",
    labelFr: "Nom de l'assistant",
    type: "string",
    required: true,
    whatFr: "Le nom interne de l'assistant, visible seulement de votre équipe.",
    whyFr: "Sert à le distinguer dans les listes, les campagnes et les traces.",
    pitfallsFr: "Deux assistants au nom proche compliquent la lecture des statistiques.",
    related: ["description"],
    example: "Acheteur FB",
  }),
  doc({
    path: "description",
    section: "identity",
    labelFr: "Description",
    type: "text",
    required: false,
    defaultValue: null,
    whatFr: "À quoi sert cet assistant, pour votre équipe.",
    whyFr: "Six mois plus tard, « Acheteur FB 2 » ne dit plus rien à personne.",
    related: ["name"],
  }),
  doc({
    path: "language",
    section: "identity",
    labelFr: "Langue principale",
    type: "enum",
    required: true,
    defaultValue: "fr-CA",
    allowed: [
      { value: "fr-CA", labelFr: "Français québécois" },
      { value: "en-CA", labelFr: "Anglais canadien" },
    ],
    whatFr: "La langue dans laquelle l'assistant écrit TOUS ses messages, à commencer par le premier.",
    whyFr:
      "Une étiquette régionale et non « fr » : ce qu'on demande au modèle, c'est le français québécois, pas celui de France. La différence s'entend dès la première phrase d'un SMS.",
    effectFr:
      "Compilée en L3, en toutes lettres. Sans cette ligne, le modèle écrivait en français parce que le reste du prompt l'était — pas parce qu'on le lui demandait, et un assistant réglé sur l'anglais écrivait quand même en français.",
    pitfallsFr:
      "Les paquets d'objections et le gabarit du tour sont rédigés en français : sur un assistant anglophone, le modèle les traduit à la volée. Relisez le bac à sable avant d'activer.",
    related: ["secondaryLanguage", "approach.formality"],
    example: "fr-CA",
  }),
  doc({
    path: "secondaryLanguage",
    section: "identity",
    labelFr: "Seconde langue",
    type: "enum",
    required: false,
    defaultValue: null,
    allowed: [
      { value: null, labelFr: "Aucune — une seule langue" },
      { value: "fr-CA", labelFr: "Français québécois" },
      { value: "en-CA", labelFr: "Anglais canadien" },
    ],
    whatFr:
      "Une langue dans laquelle l'assistant a le droit de BASCULER quand la personne y écrit — jamais d'ouvrir.",
    whyFr:
      "Un courtier de Québec reçoit des leads anglophones. Sans ce champ, l'assistant répondait en français à quelqu'un qui venait d'écrire en anglais, et la conversation s'arrêtait là.",
    effectFr:
      "Ajoute deux lignes en L3 : réponds dans cette langue si la personne s'y met, mais garde la langue principale pour le PREMIER message — on ne devine pas la langue de quelqu'un qui n'a encore rien écrit.",
    pitfallsFr:
      "La même valeur que la langue principale est refusée à l'enregistrement : le réglage n'aurait aucun effet tout en paraissant en avoir un.",
    related: ["language"],
    example: "en-CA",
  }),
];

const extras: ParamDoc[] = [
  doc({
    path: "model.fallbacks[].provider",
    section: "model",
    labelFr: "Fournisseur de repli",
    type: "enum",
    required: false,
    defaultValue: "anthropic",
    allowed: [
      { value: "openrouter", labelFr: "OpenRouter" },
      { value: "anthropic", labelFr: "Anthropic — direct" },
      { value: "google", labelFr: "Google — direct" },
      { value: "openai", labelFr: "OpenAI — direct" },
    ],
    whatFr: "Le fournisseur utilisé à ce cran quand les précédents ont échoué.",
    whyFr:
      "Un repli chez un AUTRE fournisseur protège d'une panne du premier ; un repli chez le même ne protège que d'un incident passager. Trois crans chez trois fournisseurs différents, c'est le maximum de protection possible.",
    effectFr: "Essayé dans l'ordre des crans, après une erreur rejouable au cran précédent.",
    pitfallsFr:
      "Choisir un fournisseur dont la clé n'est pas configurée : ce cran est SAUTÉ (la porte de mise en service le signale), et si tous le sont, le tour se solde par une escalade.",
    related: ["model.fallbacks[].model", "model.provider"],
    example: "anthropic",
  }),
  doc({
    path: "model.fallbacks[].model",
    section: "model",
    labelFr: "Modèle de repli",
    type: "string",
    required: false,
    defaultValue: "claude-sonnet-5",
    whatFr: "Le modèle appelé chez le fournisseur de ce cran.",
    whyFr: "Les identifiants diffèrent d'un fournisseur à l'autre : le repli a besoin du sien.",
    effectFr: "Remplace l'identifiant du modèle lors de la tentative de ce cran.",
    pitfallsFr:
      "Y recopier l'identifiant du routeur (« anthropic/claude-sonnet-5 ») alors que le direct attend « claude-sonnet-5 » : le repli échoue au moment précis où on en a besoin.",
    related: ["model.fallbacks[].provider"],
    example: "claude-sonnet-5",
  }),
  doc({
    path: "layerOverrides.mode",
    section: "prompt",
    labelFr: "Mode de surcouche",
    type: "enum",
    required: false,
    allowed: [
      { value: "replace", labelFr: "Remplacer — le bloc généré disparaît" },
      { value: "append", labelFr: "Ajouter — votre texte suit le bloc généré" },
    ],
    whatFr: "Comment votre texte s'articule avec la couche générée.",
    whyFr:
      "« Ajouter » couvre la plupart des besoins : une précision de plus sans perdre ce que la configuration produit. « Remplacer » est le geste fort.",
    effectFr: "Appliqué couche par couche à la compilation ; la couche est marquée comme modifiée.",
    pitfallsFr:
      "Remplacer une couche fige son contenu : les onglets qui l'alimentaient n'ont plus d'effet, sans autre signal que la puce « modifié ».",
    related: ["layerOverrides", "promptMode"],
    example: "append",
  }),
  doc({
    path: "layerOverrides.text",
    section: "prompt",
    labelFr: "Texte de surcouche",
    type: "text",
    required: false,
    whatFr: "Le texte qui remplace ou complète la couche.",
    whyFr: "C'est l'échappatoire quand la configuration structurée ne dit pas exactement ce qu'il faut.",
    effectFr: "Inséré tel quel dans le prompt compilé, à la place ou à la suite du bloc généré.",
    pitfallsFr:
      "Un texte qui contredit une autre couche (par exemple autoriser ce que les garde-fous interdisent) produit un modèle hésitant et des blocages à l'envoi.",
    related: ["layerOverrides.mode"],
  }),
];

export const PARAM_DOCS: ParamDoc[] = [
  ...identity,
  ...goal,
  ...approach,
  ...knowledge,
  ...objections,
  ...tools,
  ...model,
  ...prompt,
  ...extras,
];

const BY_PATH = new Map(PARAM_DOCS.map((d) => [d.path, d]));

export function getParamDoc(path: string): ParamDoc | undefined {
  const direct = BY_PATH.get(path);
  if (direct) return direct;
  // Un chemin de repli concret (« goal.fallbacks[0].type ») partage la
  // documentation du gabarit « goal.fallbacks[].type ».
  const templated = BY_PATH.get(path.replace(/\[\d+\]/g, "[]"));
  if (templated) return templated;
  // Les sept couches partagent la même fiche : « layerOverrides.L3.mode » est
  // documenté par « layerOverrides.mode ». Documenter 14 variantes identiques
  // n'apprendrait rien de plus à personne.
  const layer = /^layerOverrides\.L[0-6]\.(mode|text)$/.exec(path);
  if (layer) return BY_PATH.get(`layerOverrides.${layer[1]}`);
  return undefined;
}

export function listParamDocs(section?: string): ParamDoc[] {
  const list = section ? PARAM_DOCS.filter((d) => d.section === section) : PARAM_DOCS;
  return [...list].sort((a, b) => a.orderIndex - b.orderIndex);
}

/** Chemins documentés — sert au test qui interdit un paramètre non documenté. */
export function documentedPaths(): string[] {
  return PARAM_DOCS.map((d) => d.path);
}
