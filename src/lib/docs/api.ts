import { API_TEXT_EN, PAGE_TEXT_EN } from "./api.en";
import type { DocLocale } from "./types";
import {
  LEAD_FIELD_ALIASES,
  LEAD_MAX_BODY_BYTES,
  LEAD_REQUIRED_FIELD,
  type LeadField,
} from "@/lib/webhooks/lead-fields";

/**
 * La référence HTTP publique — module PUR (ni Next, ni base, ni environnement).
 *
 * Ce registre décrit ce qu'un intégrateur peut appeler DE L'EXTÉRIEUR. Il ne
 * décrit pas les routes internes de l'application : celles-là changent au
 * rythme des écrans, et les publier reviendrait à promettre un contrat qu'on
 * n'a pas l'intention de tenir.
 *
 * Les alias de champs ne sont pas recopiés : ils viennent de
 * `@/lib/webhooks/lead-fields`, le même module que la route lit. Une doc qui
 * se recopie ment au premier alias ajouté, et l'intégrateur ne voit pas
 * l'erreur — son lead entre simplement sans téléphone.
 *
 * Le français est la SOURCE ; l'anglais est une surcouche par clé
 * (`./api.en`), comme partout ailleurs dans le dépôt.
 */

export interface ApiFieldDoc {
  /** Le nom canonique — celui qu'on recommande d'envoyer. */
  name: string;
  required: boolean;
  /** Les autres noms acceptés pour le même champ. */
  aliases: readonly string[];
  whatFr: string;
}

export interface ApiResponseDoc {
  status: number;
  /** Le code machine renvoyé dans le corps, quand il y en a un. */
  code?: string;
  whatFr: string;
}

export interface ApiEndpointDoc {
  id: string;
  method: "POST";
  path: string;
  labelFr: string;
  /** Ce que l'appel fait. */
  whatFr: string;
  /** Pourquoi il existe — ce qu'on branche dessus en vrai. */
  whyFr: string;
  fields: ApiFieldDoc[];
  responses: ApiResponseDoc[];
  /** Les remarques qui évitent un ticket de support. */
  notesFr: string[];
  exampleBody: unknown;
  exampleResponse: unknown;
}

/** Le champ documenté, langue déjà tranchée. */
export interface ApiFieldText {
  name: string;
  required: boolean;
  aliases: readonly string[];
  what: string;
}

export interface ApiResponseText {
  status: number;
  code?: string;
  what: string;
}

export interface ApiEndpointText {
  id: string;
  method: "POST";
  path: string;
  label: string;
  what: string;
  why: string;
  fields: ApiFieldText[];
  responses: ApiResponseText[];
  notes: string[];
  exampleBody: unknown;
  exampleResponse: unknown;
}

/** Ce que la surcouche anglaise a le droit de réécrire — les mots, jamais la forme. */
export interface ApiEndpointTextEn {
  label: string;
  what: string;
  why: string;
  fields: Record<string, string>;
  responses: Record<string, string>;
  notes: string[];
}

const leadField = (name: LeadField, required: boolean, whatFr: string): ApiFieldDoc => ({
  name,
  required,
  // Le nom canonique est le premier alias : on ne le répète pas dans la liste.
  aliases: LEAD_FIELD_ALIASES[name].slice(1),
  whatFr,
});

export const API_ENDPOINTS: ApiEndpointDoc[] = [
  {
    id: "leads",
    method: "POST",
    path: "/api/webhooks/leads",
    labelFr: "Déposer un lead",
    whatFr:
      "Crée une fiche client, ou complète celle qui existe déjà pour ce numéro, puis prévient les administrateurs et l'assigné. Les campagnes dont l'audience correspond sont évaluées juste après la réponse.",
    whyFr:
      "C'est la porte d'entrée des leads : Facebook Lead Ads via n8n, un formulaire de site web, ou n'importe quel outil maison. Tout ce qui entre dans le CRM sans être saisi à la main passe ici.",
    fields: [
      leadField("phone", true, "Le numéro à rappeler. Accepté dans n'importe quelle forme lisible ; il est normalisé en E.164. C'est aussi la clé de dédoublonnage."),
      leadField("name", false, "Le nom complet. Absent, la fiche prend le numéro formaté comme nom."),
      leadField("email", false, "Le courriel, s'il a été recueilli."),
      leadField("city", false, "La ville ou le secteur."),
      leadField("projectType", false, "Ce que la personne veut faire — « achat », « vente », « évaluation ». Texte libre."),
      leadField("timing", false, "L'échéance annoncée — « dans 3 mois », « le plus tôt possible ». Texte libre."),
      leadField("source", false, "Le nom d'une source EXISTANTE du CRM, comparé sans tenir compte de la casse. Inconnue ou absente, la source par défaut de la clé s'applique."),
      leadField("notes", false, "Tout ce qui n'entre pas ailleurs. Repris tel quel sur la fiche."),
    ],
    responses: [
      { status: 200, whatFr: "Le lead est entré. Le corps renvoie `{ ok: true, clientId, created }` — `created: false` signifie qu'une fiche existait déjà pour ce numéro et qu'elle a été complétée." },
      { status: 400, code: "invalid_json", whatFr: "Le corps n'est pas un objet JSON. Un tableau ou une chaîne sont refusés." },
      { status: 401, code: "unauthorized", whatFr: "Clé absente, inconnue ou désactivée." },
      { status: 413, code: "payload_too_large", whatFr: `Le corps dépasse ${LEAD_MAX_BODY_BYTES.toLocaleString("fr-CA")} octets.` },
      { status: 422, code: "invalid_phone", whatFr: `Le champ « ${LEAD_REQUIRED_FIELD} » manque ou ne donne aucun numéro exploitable. C'est le seul champ sans lequel l'appel échoue.` },
    ],
    notesFr: [
      "Les champs sont cherchés à la RACINE du corps et dans `.data` — la forme que produit n8n. Ce qui est dans `.data` gagne.",
      "Les noms de champ sont comparés en minuscules, espaces remplacés par des soulignés : « Full Name » et « full_name » sont le même champ.",
      "Le dédoublonnage se fait sur les DIX derniers chiffres du numéro, et regarde aussi le numéro secondaire de la fiche. Renvoyer deux fois le même lead ne crée pas deux clients.",
      "Sur une fiche qui existe déjà, un champ n'est rempli que s'il était VIDE : le webhook ne détruit jamais une donnée saisie par un téléphoniste.",
      "La réponse part avant que les campagnes soient évaluées : un 200 ne veut pas dire qu'une campagne a démarré. C'est délibéré — faire patienter l'appelant finissait en délai dépassé et en lead envoyé deux fois.",
    ],
    exampleBody: {
      name: "Marie Tremblay",
      phone: "418-555-0142",
      email: "marie.tremblay@example.com",
      city: "Québec",
      type: "achat",
      timing: "dans 3 mois",
      source: "Facebook Lead Ads",
      notes: "Cherche un condo 2 chambres, secteur Sainte-Foy.",
    },
    exampleResponse: { ok: true, clientId: "3f2a…", created: true },
  },
];

/**
 * L'authentification, décrite une fois : elle est la même pour tout ce qui
 * précède, et un intégrateur la lit avant le reste.
 */
export const API_AUTH = {
  headerPrimary: "x-api-key",
  headerAlternate: "Authorization: Bearer <clé>",
} as const;

// ── Langues ──────────────────────────────────────────────────────────────────

/**
 * Une traduction manquante RETOMBE sur le français plutôt que d'afficher un
 * vide — lire la fiche dans l'autre langue reste plus utile que ne rien lire,
 * et le test de parité fait de toute façon échouer le build.
 */
export function apiEndpointText(doc: ApiEndpointDoc, locale: DocLocale): ApiEndpointText {
  const en = locale === "en" ? API_TEXT_EN[doc.id] : undefined;
  return {
    id: doc.id,
    method: doc.method,
    path: doc.path,
    label: en?.label || doc.labelFr,
    what: en?.what || doc.whatFr,
    why: en?.why || doc.whyFr,
    fields: doc.fields.map((f) => ({
      name: f.name,
      required: f.required,
      aliases: f.aliases,
      what: en?.fields[f.name] || f.whatFr,
    })),
    responses: doc.responses.map((r) => ({
      status: r.status,
      code: r.code,
      what: en?.responses[r.code ?? String(r.status)] || r.whatFr,
    })),
    notes: en?.notes?.length ? en.notes : doc.notesFr,
    exampleBody: doc.exampleBody,
    exampleResponse: doc.exampleResponse,
  };
}

/** La commande à copier — construite, jamais écrite à la main deux fois. */
export function curlExample(doc: ApiEndpointText, baseUrl: string): string {
  return [
    `curl -X ${doc.method} ${baseUrl}${doc.path} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "${API_AUTH.headerPrimary}: $NEXUS_API_KEY" \\`,
    `  -d '${JSON.stringify(doc.exampleBody, null, 2)}'`,
  ].join("\n");
}

// ── Le texte de la page ──────────────────────────────────────────────────────

/**
 * Les mots de la référence publique.
 *
 * Ils vivent ICI plutôt que dans `messages/<locale>/*.json` parce que la page
 * n'appartient à aucun module de l'application : c'est un REGISTRE, comme la
 * documentation des paramètres, et il suit la même règle — le français est la
 * source, l'anglais un fichier frère, et un test refuse une clé non traduite.
 */
export interface PageText {
  title: string;
  subtitle: string;
  toc: string;
  copy: string;
  copied: string;
  /** Le bandeau qui dit ce que cette page N'EST PAS. */
  scopeTitle: string;
  scopeBody: string;
  sections: Record<
    "start" | "auth" | "endpoints" | "assistant" | "campaign" | "guardrails" | "tools" | "spec",
    string
  >;
  start: { p1: string; p2: string; baseUrl: string };
  auth: { p1: string; p2: string; keyName: string; howTo: string };
  request: string;
  response: string;
  fields: { name: string; required: string; optional: string; aliases: string; what: string };
  statuses: string;
  notes: string;
  assistant: { p1: string; p2: string; example: string };
  campaign: { p1: string; example: string };
  guardrails: { p1: string };
  tools: { p1: string };
  spec: { p1: string; open: string };
  columns: Record<"path" | "type" | "default" | "allowed" | "what" | "kind" | "when" | "tool", string>;
}

const PAGE_FR: PageText = {
  title: "Référence développeurs",
  subtitle:
    "Ce qu'un outil extérieur peut envoyer au CRM Groupe Nexus, et comment un assistant IA se configure — au format JSON, champ par champ.",
  toc: "Sur cette page",
  copy: "Copier",
  copied: "Copié",
  scopeTitle: "Ce que couvre cette page",
  scopeBody:
    "Le webhook d'entrée des leads et le format de configuration des assistants et des campagnes. Les autres routes de l'application servent ses écrans, changent avec eux, et ne sont pas un contrat : ne les appelez pas depuis un outil.",
  sections: {
    start: "Pour commencer",
    auth: "Authentification",
    endpoints: "Points d'entrée",
    assistant: "Configuration d'un assistant",
    campaign: "Configuration d'une campagne",
    guardrails: "Garde-fous",
    tools: "Outils de l'agent",
    spec: "Spécification machine",
  },
  start: {
    p1: "Toutes les adresses sont relatives au domaine de votre instance. Le corps et les réponses sont du JSON en UTF-8.",
    p2: "Rien ici n'exige de connexion : cette page est publique pour qu'un intégrateur puisse la lire avant d'avoir un accès au CRM.",
    baseUrl: "Adresse de base",
  },
  auth: {
    p1: "Chaque appel porte une clé d'API, dans l'un ou l'autre en-tête. Les deux sont équivalents ; le premier est le plus simple à régler dans n8n.",
    p2: "Une clé n'est montrée qu'UNE fois, à sa création — le CRM n'en garde qu'une empreinte et ne peut pas vous la redonner. Chaque clé porte ses propres valeurs par défaut (catégorie, source, personne assignée), appliquées aux leads qu'elle dépose.",
    keyName: "Obtenir une clé",
    howTo:
      "Un administrateur la crée dans Administration → Webhooks. Demandez-lui aussi la source à envoyer si vous voulez que vos leads soient attribués à la bonne origine.",
  },
  request: "Corps de la requête",
  response: "Réponse",
  fields: {
    name: "Champ",
    required: "obligatoire",
    optional: "facultatif",
    aliases: "Aussi accepté",
    what: "Ce que c'est",
  },
  statuses: "Codes de réponse",
  notes: "À savoir",
  assistant: {
    p1: "Un assistant est un objet JSON. Le même format sert à l'export, à l'import et à l'onglet « Avancé (JSON) » de l'éditeur : un outil qui produit ce format produit un assistant importable.",
    p2: "Chaque chemin ci-dessous est une clé dans cet objet. « goal.primary.type » veut dire { goal: { primary: { type: … } } }.",
    example: "Exemple complet",
  },
  campaign: {
    p1: "Une campagne décide QUI reçoit des messages et QUAND. Même principe : le JSON exporté est le JSON importable.",
    example: "Exemple complet",
  },
  guardrails: {
    p1: "Les garde-fous relisent chaque message avant l'envoi. Voici les types de règle qu'une configuration peut déclarer, et ce que chaque sévérité fait du message.",
  },
  tools: {
    p1: "Les gestes qu'un assistant peut poser pendant une conversation. Un outil absent de « tools » n'est pas offert au modèle — il ne peut donc pas le faire. Les descriptions ci-dessous sont reproduites TELLES QUELLES : c'est le texte que le modèle reçoit, et il est écrit dans la langue de l'assistant, pas dans celle de cette page.",
  },
  spec: {
    p1: "La même référence, en JSON, pour engendrer un client ou un validateur sans lire cette page.",
    open: "Ouvrir la spécification",
  },
  columns: {
    path: "Chemin JSON",
    type: "Type",
    default: "Par défaut",
    allowed: "Valeurs permises",
    what: "Ce que c'est",
    kind: "Type de règle",
    when: "Quand la choisir",
    tool: "Outil",
  },
};

export function pageText(locale: DocLocale): PageText {
  return locale === "en" ? PAGE_TEXT_EN : PAGE_FR;
}
