import type { GuardrailKind, GuardrailSeverity } from "./types";

/**
 * Aide en ligne des garde-fous — module PUR.
 *
 * Chaque type de règle est expliqué par un EXEMPLE de ce qui passe et un
 * exemple de ce qui est attrapé. C'est la seule façon de rendre la différence
 * lisible : « motif interdit » et « termes interdits » se ressemblent
 * beaucoup sur le papier, et le choix entre les deux décide pourtant si
 * « commissionnaire » déclenche la règle sur « commission ».
 */

export interface GuardrailKindDoc {
  kind: GuardrailKind;
  labelFr: string;
  /** Ce que la règle fait, en une phrase. */
  whatFr: string;
  /** Quand la choisir plutôt qu'une autre. */
  whenFr: string;
  /** Ce qu'il faut remplir. */
  configFr: string;
  /** Un message qui PASSE, et pourquoi. */
  passesFr: string;
  /** Un message ATTRAPÉ, et pourquoi. */
  caughtFr: string;
  /** Le piège du type. */
  pitfallFr: string;
  /** Coûte-t-il un appel au modèle? Décisif sur le volume. */
  costsModelCall: boolean;
}

export const GUARDRAIL_KIND_DOCS: Record<GuardrailKind, GuardrailKindDoc> = {
  forbidden_regex: {
    kind: "forbidden_regex",
    labelFr: "Motif interdit (expression régulière)",
    whatFr:
      "Bloque le message si l'un des motifs s'y trouve. Le motif est une expression régulière, donc il peut décrire une FORME plutôt qu'un mot précis.",
    whenFr:
      "Quand ce qu'on veut interdire est une forme : un montant, un pourcentage, une adresse courriel, un numéro. Un mot fixe se traite mieux avec « Termes interdits ».",
    configFr: "Un ou plusieurs motifs, plus les drapeaux (par défaut « iu » : insensible à la casse, Unicode).",
    passesFr: "« Je laisse Alex vous expliquer les modalités. » — aucun montant n'apparaît.",
    caughtFr:
      "« Votre maison vaut environ 450 000 $ » — attrapé par le motif \\d[\\d\\s]{2,}\\s?\\$ qui décrit « un nombre suivi de $ ».",
    pitfallFr:
      "Un motif trop large attrape des messages légitimes et l'assistant se met à échouer sans raison visible. Les motifs sont testés à l'enregistrement : un motif qui ne compile pas est refusé.",
    costsModelCall: false,
  },
  forbidden_terms: {
    kind: "forbidden_terms",
    labelFr: "Termes interdits",
    whatFr: "Bloque le message si l'un des termes de la liste y apparaît.",
    whenFr:
      "Quand ce qu'on veut interdire est un mot ou une expression précise, et qu'on ne veut pas écrire d'expression régulière.",
    configFr: "La liste des termes, un par ligne.",
    passesFr: "« Je préfère laisser Alex vous expliquer ça de vive voix. »",
    caughtFr: "« Notre commission est de… » — le terme « commission » est dans la liste.",
    pitfallFr:
      "La recherche porte sur le texte brut : interdire « commission » attrape aussi « commissionnaire », et surtout empêche l'assistant de REFUSER poliment d'en parler, puisque tout refus nomme le sujet. Formulez la consigne du prompt pour qu'il détourne sans nommer.",
    costsModelCall: false,
  },
  max_chars: {
    kind: "max_chars",
    labelFr: "Longueur maximale",
    whatFr: "Bloque un message plus long que la limite, en caractères.",
    whenFr:
      "Pour tenir le coût et la lisibilité. Au-delà de 160 caractères (70 avec un accent hors table GSM), le message est facturé en plusieurs segments.",
    configFr: "Le nombre maximal de caractères.",
    passesFr: "Un message de 140 caractères — un seul segment.",
    caughtFr: "Un message de 480 caractères — trois segments facturés, et illisible sur un téléphone.",
    pitfallFr:
      "Une limite trop basse fait échouer des réponses légitimes qui doivent citer deux disponibilités. 300 laisse la place à une question et deux créneaux.",
    costsModelCall: false,
  },
  max_questions: {
    kind: "max_questions",
    labelFr: "Nombre de questions maximal",
    whatFr: "Bloque un message qui pose plus de questions que la limite.",
    whenFr:
      "Un SMS qui pose trois questions n'obtient aucune réponse. Une seule question par message est la règle qui convertit.",
    configFr: "Le nombre maximal de points d'interrogation.",
    passesFr: "« Jeudi 14 h ou vendredi 10 h? » — une seule question, deux choix.",
    caughtFr:
      "« Vous cherchez quoi? Dans quel secteur? Quel budget? » — trois questions : la personne n'en répond à aucune.",
    pitfallFr:
      "Le compte porte sur les points d'interrogation. Une question posée sans « ? » n'est pas vue par cette règle.",
    costsModelCall: false,
  },
  link_policy: {
    kind: "link_policy",
    labelFr: "Politique de liens",
    whatFr:
      "Bloque le message s'il contient un lien vers un domaine qui n'est pas dans la liste autorisée. Une liste VIDE interdit tout lien.",
    whenFr:
      "Un lien dans un premier SMS est le signal le plus fiable d'un message indésirable : les opérateurs filtrent là-dessus.",
    configFr: "Les domaines autorisés (suffixes). Vide = aucun lien permis.",
    passesFr: "« Je vous envoie l'adresse par courriel. » — aucun lien.",
    caughtFr: "« Voyez les photos ici : bit.ly/xyz » — domaine non autorisé, et un raccourcisseur en plus.",
    pitfallFr:
      "Les domaines nus (sans https://) comptent aussi : « allez sur exemple.com » est un lien. Autoriser un domaine autorise ses sous-domaines.",
    costsModelCall: false,
  },
  required_tool_on_intent: {
    kind: "required_tool_on_intent",
    labelFr: "Outil obligatoire sur une intention",
    whatFr:
      "Exige que l'assistant appelle un outil précis quand l'intention détectée correspond. Le message est bloqué si l'outil n'a pas été appelé.",
    whenFr:
      "Quand une intention DOIT produire un effet et pas seulement une phrase : un désabonnement doit appeler « stop », pas seulement répondre « d'accord ».",
    configFr: "L'intention (ex. « opt_out ») et l'outil attendu (ex. « stop »).",
    passesFr: "La personne écrit « arrêtez » et l'assistant appelle l'outil « stop ».",
    caughtFr:
      "La personne écrit « arrêtez », l'assistant répond « Entendu! » sans appeler « stop » : le numéro reste abonné et la relance repart.",
    pitfallFr:
      "L'outil doit être activé sur l'assistant, sinon la règle échoue toujours : le modèle ne peut pas appeler un outil qu'on ne lui offre pas.",
    costsModelCall: false,
  },
  llm_judge: {
    kind: "llm_judge",
    labelFr: "Jugement par le modèle",
    whatFr:
      "Fait évaluer le brouillon par le modèle classifieur selon un critère écrit en français. Le message est bloqué si le critère n'est pas respecté.",
    whenFr:
      "Quand la règle porte sur le SENS et non sur des mots : « n'invente aucun fait », « dit la vérité si on demande si c'est une IA ». Aucune expression régulière ne peut décrire ça.",
    configFr: "Le critère, formulé comme une phrase vérifiable.",
    passesFr: "« Je ne peux pas estimer votre propriété, mais Alex le fera avec vous. » — aucun fait inventé.",
    caughtFr:
      "« Le marché va monter de 8 % cette année » — une prévision inventée qu'aucune liste de mots n'aurait attrapée.",
    pitfallFr:
      "Coûte un appel de modèle à CHAQUE brouillon, et échoue FERMÉ : si le juge ne répond pas, le message est bloqué. Un critère qui dépend d'un contexte que le juge n'a pas (« s'il s'agit du premier message… ») bloque tout.",
    costsModelCall: true,
  },
  custom_instruction: {
    kind: "custom_instruction",
    labelFr: "Consigne de prompt",
    whatFr:
      "N'analyse RIEN. Ajoute simplement son texte à la couche de garde-fous du prompt compilé.",
    whenFr:
      "Pour guider la rédaction sans imposer un blocage : une préférence de ton, une tournure à éviter.",
    configFr: "Rien à configurer — seul le texte de prompt compte.",
    passesFr: "Tout passe : cette règle n'a aucun pouvoir de blocage.",
    caughtFr: "Rien n'est jamais attrapé.",
    pitfallFr:
      "Sa sévérité n'a AUCUN effet : la marquer « bloquante » l'affiche comme un garde-fou dur alors qu'elle ne peut rien refuser. Si le comportement doit être garanti, utilisez « Jugement par le modèle ».",
    costsModelCall: false,
  },
};

export interface SeverityDoc {
  severity: GuardrailSeverity;
  labelFr: string;
  whatFr: string;
}

export const GUARDRAIL_SEVERITY_DOCS: Record<GuardrailSeverity, SeverityDoc> = {
  block: {
    severity: "block",
    labelFr: "Bloquante",
    whatFr:
      "Le message ne part pas. L'assistant réécrit une fois ; s'il échoue encore, la conversation passe à un humain. C'est aussi ce qui rend une fixture rouge.",
  },
  warn: {
    severity: "warn",
    labelFr: "Avertissement",
    whatFr:
      "Le message PART quand même, mais l'écart est consigné dans la trace du tour. Utile pour observer une règle avant de la rendre bloquante.",
  },
  off: {
    severity: "off",
    labelFr: "Inactive",
    whatFr:
      "La règle n'est ni évaluée ni injectée dans le prompt. Elle reste en place pour être réactivée sans être réécrite.",
  },
};

export function kindDoc(kind: string): GuardrailKindDoc | undefined {
  return (GUARDRAIL_KIND_DOCS as Record<string, GuardrailKindDoc>)[kind];
}

/** Config par défaut d'un type — sert au formulaire de création. */
export function defaultConfigFor(kind: GuardrailKind): unknown {
  switch (kind) {
    case "forbidden_regex":
      return { patterns: [], flags: "iu" };
    case "forbidden_terms":
      return { terms: [] };
    case "max_chars":
      return { max: 300 };
    case "max_questions":
      return { max: 1 };
    case "link_policy":
      return { allowedDomains: [] };
    case "required_tool_on_intent":
      return { intent: "opt_out", tool: "stop" };
    case "llm_judge":
      return { criterion: "" };
    case "custom_instruction":
      return {};
  }
}

