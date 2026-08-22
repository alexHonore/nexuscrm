import {
  FIXTURE_FIELD_TEXT_EN,
  GUARDRAIL_KIND_TEXT_EN,
  GUARDRAIL_SEVERITY_TEXT_EN,
  RULE_PRESET_TEXT_EN,
} from "./docs.en";
import type { DocLocale } from "@/lib/docs/types";
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

/**
 * Langue de l'aide. Le français est la source, l'anglais une surcouche par
 * clé (`./docs.en`) — même règle que `messages/<locale>/*.json`. Ce qui n'est
 * PAS traduisible : le `promptText` et le `criterion` d'un préréglage. Ces
 * deux-là partent dans le prompt de l'assistant, dont la langue est celle de
 * l'assistant, pas celle de l'administrateur qui regarde l'écran.
 */
// Une seule définition de la langue dans tout le dépôt : `DocLocale`.
export type DocsLocale = DocLocale;

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
    labelFr: "Interdire une forme (montant, pourcentage, courriel…)",
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
    labelFr: "Interdire des mots précis",
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
    labelFr: "Limiter la longueur du message",
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
    labelFr: "Limiter le nombre de questions",
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
    labelFr: "Contrôler les liens",
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
    labelFr: "Exiger une action (arrêter, passer à un humain…)",
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
    labelFr: "Faire vérifier le sens par l'IA",
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
    labelFr: "Simple consigne d'écriture (ne bloque rien)",
    whatFr:
      "N'analyse RIEN. Ajoute simplement son texte à la couche de garde-fous du prompt compilé.",
    whenFr:
      "Pour guider la rédaction sans imposer un blocage : une préférence de ton, une tournure à éviter.",
    configFr: "Rien à configurer — seul le texte de prompt compte.",
    passesFr: "Tout passe : cette règle n'a aucun pouvoir de blocage.",
    caughtFr: "Rien n'est jamais attrapé.",
    pitfallFr:
      "Sa sévérité n'a AUCUN effet : la marquer « bloquante » l'affiche comme un garde-fou dur alors qu'elle ne peut rien refuser. Si le comportement doit être garanti, utilisez « Faire vérifier le sens par l'IA ».",
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
    labelFr: "Bloque le message",
    whatFr:
      "Le message ne part pas. L'assistant réécrit une fois ; s'il échoue encore, la conversation passe à un humain. C'est aussi ce qui rend une fixture rouge.",
  },
  warn: {
    severity: "warn",
    labelFr: "Laisse passer, mais le note",
    whatFr:
      "Le message PART quand même, mais l'écart est consigné dans la trace du tour. Utile pour observer une règle avant de la rendre bloquante.",
  },
  off: {
    severity: "off",
    labelFr: "Désactivée",
    whatFr:
      "La règle n'est ni évaluée ni injectée dans le prompt. Elle reste en place pour être réactivée sans être réécrite.",
  },
};

export function kindDoc(kind: string): GuardrailKindDoc | undefined {
  return (GUARDRAIL_KIND_DOCS as Record<string, GuardrailKindDoc>)[kind];
}

/** Le texte d'un type de règle, sans suffixe de langue. */
export interface GuardrailKindText {
  label: string;
  what: string;
  when: string;
  config: string;
  passes: string;
  caught: string;
  pitfall: string;
}

/** Une traduction manquante retombe sur le français : mieux que du vide. */
export function kindText(doc: GuardrailKindDoc, locale: DocsLocale): GuardrailKindText {
  const fr: GuardrailKindText = {
    label: doc.labelFr,
    what: doc.whatFr,
    when: doc.whenFr,
    config: doc.configFr,
    passes: doc.passesFr,
    caught: doc.caughtFr,
    pitfall: doc.pitfallFr,
  };
  return locale === "en" ? { ...fr, ...(GUARDRAIL_KIND_TEXT_EN[doc.kind] ?? {}) } : fr;
}

export interface SeverityText {
  label: string;
  what: string;
}

export function severityText(doc: SeverityDoc, locale: DocsLocale): SeverityText {
  const fr: SeverityText = { label: doc.labelFr, what: doc.whatFr };
  return locale === "en" ? { ...fr, ...(GUARDRAIL_SEVERITY_TEXT_EN[doc.severity] ?? {}) } : fr;
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



// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Aide des ATTENTES d'une fixture.
 *
 * Une fixture est un scénario rejoué contre le vrai modèle : on donne un
 * message entrant et on décrit ce que la réponse doit — ou ne doit pas — faire.
 * Le piège commun est de tout exprimer en « doit contenir », ce qui casse au
 * premier changement de formulation alors que le comportement, lui, est bon.
 */
export interface FixtureFieldDoc {
  key: string;
  labelFr: string;
  whatFr: string;
  exampleFr: string;
  pitfallFr: string;
}

export const FIXTURE_FIELD_DOCS: FixtureFieldDoc[] = [
  {
    key: "inbound",
    labelFr: "Message entrant",
    whatFr: "Ce que le client écrit. C'est le déclencheur du scénario.",
    exampleFr: "« arrêtez de m'écrire s'il vous plaît »",
    pitfallFr:
      "Un entrant trop poli ou trop long teste autre chose que ce que vous croyez : écrivez ce qu'un vrai client tape, fautes comprises.",
  },
  {
    key: "priorTurns",
    labelFr: "Historique",
    whatFr:
      "Les messages déjà échangés, dans l'ordre. « out » = l'assistant, « in » = le client.",
    exampleFr: "out: « Bonjour, ici Groupe Nexus… » puis in: « c'est quoi ça? »",
    pitfallFr:
      "Sans aucun tour « out », le scénario est un PREMIER message sortant : la règle d'identification LCAP exige alors d'y nommer l'organisation, et la fixture échoue pour une raison qui n'a rien à voir avec ce qu'elle teste.",
  },
  {
    key: "mustCallTool",
    labelFr: "Doit appeler l'outil",
    whatFr: "La réponse doit invoquer cet outil, sinon la fixture échoue.",
    exampleFr: "Sur « arrêtez », l'assistant doit appeler « stop ».",
    pitfallFr:
      "L'outil doit être activé sur l'assistant testé : le modèle ne peut pas appeler un outil qu'on ne lui offre pas, et la fixture serait rouge pour toujours.",
  },
  {
    key: "mustNotCallTool",
    labelFr: "Ne doit PAS appeler l'outil",
    whatFr: "La réponse ne doit pas invoquer cet outil.",
    exampleFr: "Avant d'avoir la qualification requise, l'assistant ne doit pas appeler « book_meeting ».",
    pitfallFr:
      "C'est la vérification la plus facile à rendre inutile : si l'outil n'est pas activé, elle passe toujours sans rien prouver.",
  },
  {
    key: "mustMatch",
    labelFr: "Doit correspondre au motif",
    whatFr: "La réponse doit contenir quelque chose qui correspond à l'expression régulière.",
    exampleFr: "/\\d{1,2}\\s?h/ pour exiger qu'une heure soit proposée.",
    pitfallFr:
      "Décrire une FORME résiste au temps ; exiger une phrase exacte casse à la première reformulation, alors que le comportement reste bon. Préférez le critère jugé quand c'est le SENS qui compte.",
  },
  {
    key: "mustNotMatch",
    labelFr: "Ne doit PAS correspondre",
    whatFr: "La réponse ne doit rien contenir qui corresponde au motif.",
    exampleFr: "/\\d[\\d\\s]{2,}\\s?\\$/ pour interdire tout montant.",
    pitfallFr: "Un motif trop large fait échouer des réponses parfaitement correctes.",
  },
  {
    key: "judge",
    labelFr: "Critère jugé par le modèle",
    whatFr:
      "Un critère en français, évalué par le modèle classifieur. Sert quand la règle porte sur le sens et non sur des mots.",
    exampleFr: "« La réponse s'arrête définitivement : aucune relance, aucune alternative proposée. »",
    pitfallFr:
      "Coûte un appel de modèle par exécution et échoue FERMÉ : un critère qui dépend d'un contexte que le juge n'a pas rend la fixture rouge sans raison lisible.",
  },
  {
    key: "maxChars",
    labelFr: "Limiter la longueur du message",
    whatFr: "La réponse ne doit pas dépasser cette longueur.",
    exampleFr: "200 pour vérifier qu'un accusé de réception reste bref.",
    pitfallFr: "Ne confondez pas avec la règle globale de longueur : ici c'est CE scénario qu'on borne.",
  },
];

export function fixtureFieldDoc(key: string): FixtureFieldDoc | undefined {
  return FIXTURE_FIELD_DOCS.find((d) => d.key === key);
}


// ── Règles prêtes à l'emploi ─────────────────────────────────────────────────

/**
 * Modèles de règles, décrits par ce qu'ils EMPÊCHENT.
 *
 * Créer un garde-fou demandait de choisir un type technique puis de remplir une
 * configuration — deux décisions d'ingénieur pour exprimer une intention
 * d'affaires (« ne parle jamais de prix »). On part donc de l'intention : on
 * choisit dans une liste, et la configuration est déjà écrite. La règle
 * personnalisée reste disponible pour les cas qui sortent du cadre.
 */
export interface RulePreset {
  key: string;
  labelFr: string;
  /** Ce que la règle empêche, en une phrase, sans jargon. */
  whatFr: string;
  kind: GuardrailKind;
  config: unknown;
  promptText: string | null;
  severity: GuardrailSeverity;
}

export const RULE_PRESETS: RulePreset[] = [
  {
    key: "aucun_prix",
    labelFr: "Ne jamais donner de prix ni de valeur",
    whatFr:
      "Bloque tout message contenant un montant ou un pourcentage — estimer une propriété demande un permis.",
    kind: "forbidden_regex",
    config: { patterns: ["\\d[\\d\\s]{2,}\\s?\\$", "\\d+\\s?%"], flags: "iu" },
    promptText:
      "Tu ne donnes jamais de montant, de valeur, de prix ni de pourcentage. Tu réfères au courtier.",
    severity: "block",
  },
  {
    key: "aucune_commission",
    labelFr: "Ne jamais parler de commission ni d'honoraires",
    whatFr: "Bloque les messages qui mentionnent la commission, les honoraires ou les tarifs.",
    kind: "forbidden_terms",
    config: { terms: ["commission", "honoraires", "pourcentage de vente", "tarif"] },
    promptText:
      "Tu ne discutes jamais de commission, d'honoraires ni de tarifs. Tu laisses le courtier en parler.",
    severity: "block",
  },
  {
    key: "une_question",
    labelFr: "Une seule question par message",
    whatFr:
      "Un SMS qui pose trois questions n'obtient aucune réponse. Bloque les messages qui en posent plus d'une.",
    kind: "max_questions",
    config: { max: 1 },
    promptText: "Tu poses une seule question par message.",
    severity: "block",
  },
  {
    key: "message_court",
    labelFr: "Garder les messages courts",
    whatFr:
      "Bloque au-delà de 300 caractères. Un message long se lit comme du publipostage et coûte plusieurs segments.",
    kind: "max_chars",
    config: { max: 300 },
    promptText: "Tu écris des messages courts, sous 300 caractères.",
    severity: "block",
  },
  {
    key: "aucun_lien",
    labelFr: "Aucun lien dans les messages",
    whatFr:
      "Un lien dans un premier SMS est le signal le plus fiable d'un message indésirable : les opérateurs filtrent là-dessus.",
    kind: "link_policy",
    config: { allowedDomains: [] },
    promptText: "Tu n'envoies jamais de lien par SMS.",
    severity: "block",
  },
  {
    key: "respecter_stop",
    labelFr: "Respecter un désabonnement",
    whatFr:
      "Exige que l'assistant arrête vraiment quand quelqu'un demande d'arrêter — répondre « d'accord » sans arrêter laisse la relance repartir.",
    kind: "required_tool_on_intent",
    config: { intent: "opt_out", tool: "stop" },
    promptText: "Dès qu'une personne demande d'arrêter, tu arrêtes définitivement.",
    severity: "block",
  },
  {
    key: "rien_inventer",
    labelFr: "Ne rien inventer",
    whatFr:
      "Fait relire chaque message par l'IA pour vérifier qu'il n'affirme aucun fait, chiffre ou promesse inventé.",
    kind: "llm_judge",
    config: {
      criterion:
        "La réponse n'affirme aucun fait, chiffre, statistique, délai ou promesse qui ne soit pas explicitement autorisé.",
    },
    promptText: "Tu n'inventes jamais un fait, un chiffre ni un délai.",
    severity: "block",
  },
  {
    key: "verite_ia",
    labelFr: "Dire la vérité si on demande si c'est un robot",
    whatFr: "Fait vérifier que l'assistant ne prétend jamais être un humain quand on le lui demande.",
    kind: "llm_judge",
    config: {
      criterion:
        "Si la personne demande si c'est un robot, une IA ou un humain, la réponse dit la vérité sans détour.",
    },
    promptText:
      "Si on te demande si tu es un robot ou une IA, tu réponds la vérité immédiatement.",
    severity: "block",
  },
];

export function rulePreset(key: string): RulePreset | undefined {
  return RULE_PRESETS.find((p) => p.key === key);
}

/**
 * Le texte d'un préréglage — ce que l'administrateur LIT.
 *
 * `promptText`, `config` et `severity` n'y sont pas : ils partent dans le
 * prompt de l'assistant ou dans le moteur. Traduire un `promptText` selon la
 * langue de l'écran ferait écrire l'assistant en anglais à des clients
 * québécois.
 */
export interface RulePresetText {
  label: string;
  what: string;
}

export function presetText(preset: RulePreset, locale: DocsLocale): RulePresetText {
  const fr: RulePresetText = { label: preset.labelFr, what: preset.whatFr };
  return locale === "en" ? { ...fr, ...(RULE_PRESET_TEXT_EN[preset.key] ?? {}) } : fr;
}

export interface FixtureFieldText {
  label: string;
  what: string;
  example: string;
  pitfall: string;
}

export function fixtureText(doc: FixtureFieldDoc, locale: DocsLocale): FixtureFieldText {
  const fr: FixtureFieldText = {
    label: doc.labelFr,
    what: doc.whatFr,
    example: doc.exampleFr,
    pitfall: doc.pitfallFr,
  };
  return locale === "en" ? { ...fr, ...(FIXTURE_FIELD_TEXT_EN[doc.key] ?? {}) } : fr;
}
