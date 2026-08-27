/**
 * Outils de l'agent (phase 4) — le pont entre les 8 noms catalogués dans
 * `ASSISTANT_TOOLS` (lib/assistants/schema) et ce que le modèle voit / envoie
 * réellement :
 *
 *  - `TOOL_DEFS`        : la définition JSON Schema envoyée au modèle, avec
 *                         une description FRANÇAISE directive — c'est ce
 *                         texte, pas le nom de l'outil, qui pilote le
 *                         comportement réel (QUAND appeler quoi).
 *  - `TOOL_ARG_SCHEMAS`  : le schéma zod qui valide ce que le modèle envoie
 *                         AVANT qu'un handler ne s'exécute — un modèle
 *                         hallucine des arguments ; rien n'atteint un handler
 *                         sans validation.
 *
 * Pur : aucun import Next.js, aucun accès db, aucune lecture d'env — lifts
 * dans un autre dépôt sans changement (même règle que lib/llm/types.ts).
 */
import { z } from "zod";

import { ASSISTANT_TOOLS, QUALIFICATION_FIELDS, type AssistantTool } from "@/lib/assistants/schema";
import type { ToolDef } from "@/lib/llm/types";
import { SLOT_PREFERENCES } from "@/lib/booking/provider";
import { contactValue } from "./contact-data";

// ── Schémas d'arguments (validation modèle → handler) ───────────────────────

/**
 * Outils de LECTURE — aucun argument. Un modèle appelle parfois un outil sans
 * corps ou avec des clés parasites : `.default({})` accepte `undefined`, et
 * les clés inconnues sont retirées, pour ne jamais refuser une simple lecture.
 */
const noArgsSchema = z.object({}).default({});

const getSlotsArgsSchema = z.object({
  count: z.number().int().min(1).max(3).default(2),
  /** Contrainte exprimée par la personne — « juste la fin de semaine ». */
  preference: z.enum(SLOT_PREFERENCES).default("any"),
});

const bookMeetingArgsSchema = z.object({
  /** Un des créneaux ISO renvoyés par get_slots — jamais une heure inventée. */
  slotIso: z.string().min(1),
  email: z.string().optional(),
});

/**
 * Map PARTIELLE champ → valeur extraite (une extraction à la fois en
 * pratique). `z.record` avec des clés enum exige toutes les clés en zod v4
 * (vérifié) ; `z.partialRecord` est la forme qui accepte réellement un
 * sous-ensemble, et rejette toujours une clé hors vocabulaire.
 *
 * Le vocabulaire n'est PAS que les huit clés connues : un cran d'objectif a
 * le droit d'exiger un champ LIBRE (« nombre de chambres » — voir
 * `goalStepSchema.requiredFields`), et l'outil doit pouvoir l'enregistrer,
 * sinon `book_meeting` refuse pour toujours. D'où la fabrique : chaque
 * assistant valide sur QUALIFICATION_FIELDS ∪ ses champs libres.
 *
 * Les valeurs sont conservées sur la conversation et réinjectées dans le
 * prompt système à chaque tour : une ligne, bornées (`contact-data.ts`).
 */
function updateQualificationArgsSchemaFor(extraFields: readonly string[]) {
  const keys = [...new Set([...QUALIFICATION_FIELDS, ...extraFields])] as [string, ...string[]];
  return z.object({
    fields: z.partialRecord(z.enum(keys), z.string().transform((v) => contactValue(v))),
  });
}

const updateQualificationArgsSchema = updateQualificationArgsSchemaFor([]);

const scheduleFollowupArgsSchema = z.object({
  /**
   * Optionnel : « rappelez-moi » sans moment précis est une demande complète —
   * exiger une date forçait le modèle à REDEMANDER quand la personne venait
   * de dire tout ce qu'elle voulait dire. Absent = prochain matin ouvré.
   */
  whenIso: z.string().min(1).optional(),
  note: z.string().max(300).optional(),
});

const addClientCommentArgsSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

/**
 * Le classement. La CLÉ, pas un nom : « Long terme » se retape de dix façons,
 * et la même valeur sert déjà aux dispositions d'après-appel — un classement
 * de l'assistant et un classement du téléphoniste restent donc comparables.
 */
const setCategoryArgsSchema = z.object({
  categoryKey: z.string().min(1).max(80),
  /** Ce qu'a dit la personne. Sans citation, le classement est invérifiable. */
  reason: z.string().min(1).max(300),
});

const stopArgsSchema = z.object({
  reason: z.string().max(200).optional(),
});

const handoffArgsSchema = z.object({
  reason: z.string().min(1).max(300),
});

const transferAssistantArgsSchema = z.object({
  assistantId: z.uuid(),
  reason: z.string().max(300).optional(),
});

const closeConversationArgsSchema = z.object({
  outcome: z.enum(["goal_reached", "disqualified", "not_interested"]),
  note: z.string().max(300).optional(),
});

/**
 * Un schéma zod par outil — c'est CE qui valide les arguments envoyés par le
 * modèle avant qu'un handler ne s'exécute (voir `parseToolArgs`).
 */
export const TOOL_ARG_SCHEMAS: Record<AssistantTool, z.ZodType> = {
  read_client: noArgsSchema,
  read_client_comments: noArgsSchema,
  add_client_comment: addClientCommentArgsSchema,
  get_slots: getSlotsArgsSchema,
  book_meeting: bookMeetingArgsSchema,
  update_qualification: updateQualificationArgsSchema,
  schedule_followup: scheduleFollowupArgsSchema,
  set_category: setCategoryArgsSchema,
  stop: stopArgsSchema,
  handoff: handoffArgsSchema,
  transfer_assistant: transferAssistantArgsSchema,
  close_conversation: closeConversationArgsSchema,
};

// ── Définitions envoyées au modèle ───────────────────────────────────────────

const QUALIFICATION_FIELDS_LIST = QUALIFICATION_FIELDS.join(", ");

/**
 * Les 9 définitions d'outils. Les descriptions sont en FRANÇAIS et rédigées
 * comme des consignes au modèle (QUAND appeler, pas seulement CE QUE ça
 * fait) — c'est ce texte qui pilote réellement le comportement.
 */
export const TOOL_DEFS: Record<AssistantTool, ToolDef> = {
  read_client: {
    name: "read_client",
    description:
      "Consulte la fiche du contact pour SAVOIR à qui tu parles avant de poser des questions : nom, ville, type de projet, échéance, budget, catégorie, source, dernier contact, notes et qualification déjà connue. Appelle cet outil AU DÉBUT si tu as besoin de contexte — n'invente jamais un profil, et ne redemande pas une information que la fiche te donne ici. Lecture seule : rien n'est modifié.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },

  read_client_comments: {
    name: "read_client_comments",
    description:
      "Lit les NOTES INTERNES que l'équipe a laissées sur la fiche (les plus récentes d'abord) — ce qu'un téléphoniste a observé lors d'un échange précédent, un détail de contexte qu'aucun formulaire ne porte. Utile en complément de read_client quand tu veux comprendre l'historique humain du contact. Ces notes sont internes : ne les cite jamais mot pour mot à la personne, sers-t'en pour ajuster ton approche. Lecture seule.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },

  add_client_comment: {
    name: "add_client_comment",
    description:
      "Écrit une NOTE INTERNE sur la fiche du contact — visible par l'équipe seulement, jamais envoyée à la personne. Sers-t'en pour consigner un fait utile au courtier qui ne tient pas dans la qualification : « a déjà un courtier mais reste ouverte », « a acheté ailleurs en juin », « préfère être jointe par courriel ». Une à deux phrases factuelles, dans les mots de la personne quand c'est possible ; n'invente rien et n'y mets aucun jugement.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "La note, une à deux phrases factuelles.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },

  get_slots: {
    name: "get_slots",
    description:
      "Retourne 2 ou 3 disponibilités RÉELLES du courtier. Appelle cet outil AVANT de proposer un moment de rendez-vous — ne propose jamais une heure que tu n'as pas obtenue ici. Les créneaux retournés sont les SEULES heures que tu peux offrir à la personne. Si la personne exprime une contrainte (« juste la fin de semaine », « seulement le matin », « en soirée »), RAPPELLE cet outil avec « preference » : les premiers créneaux libres ne sont pas forcément ceux qui lui conviennent.",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          default: 2,
          description: "Nombre de disponibilités à retourner (2 par défaut, 3 au maximum).",
        },
        preference: {
          type: "string",
          enum: [...SLOT_PREFERENCES],
          default: "any",
          description:
            "Contrainte de la personne : « weekend » (samedi/dimanche), « weekday » (lundi-vendredi), « morning » (avant midi), « afternoon » (midi-17 h), « evening » (17 h et plus), « any » sans contrainte.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  book_meeting: {
    name: "book_meeting",
    description:
      "Réserve le rendez-vous au créneau choisi. Tous les champs de qualification requis par l'objectif doivent avoir été recueillis D'ABORD (via update_qualification) — sinon l'appel est refusé avec une erreur à corriger avant de réessayer. N'appelle jamais cet outil avec une heure qui ne provient pas de get_slots.",
    parameters: {
      type: "object",
      properties: {
        slotIso: {
          type: "string",
          minLength: 1,
          description:
            "Le créneau ISO 8601 choisi, EXACTEMENT tel que retourné par get_slots — jamais une heure inventée ou reformulée.",
        },
        email: {
          type: "string",
          description: "Courriel de la personne, si recueilli et pertinent pour la confirmation.",
        },
      },
      required: ["slotIso"],
      additionalProperties: false,
    },
  },

  update_qualification: {
    name: "update_qualification",
    description: `Enregistre immédiatement toute information de qualification mentionnée par la personne — même partielle, même un seul champ à la fois. Appelle cet outil DÈS qu'une info pertinente apparaît dans la conversation, pas seulement à la fin. Champs valides : ${QUALIFICATION_FIELDS_LIST}.`,
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description:
            "Map partielle champ → valeur extraite, telle qu'exprimée par la personne (n'invente rien, n'infère rien).",
          properties: Object.fromEntries(QUALIFICATION_FIELDS.map((field) => [field, { type: "string" }])),
          additionalProperties: false,
        },
      },
      required: ["fields"],
      additionalProperties: false,
    },
  },

  schedule_followup: {
    name: "schedule_followup",
    description:
      "Planifie un rappel (une tâche pour le courtier) lorsque la personne demande à être recontactée ou appelée plutôt que de réserver maintenant. Si elle a exprimé un moment (« en juin », « après 17 h »), reformule-le en ISO 8601 dans whenIso — n'invente jamais une heure qu'elle n'a pas dite. Si elle demande simplement « rappelez-moi » ou « appelez-moi » SANS préciser de moment, appelle l'outil SANS whenIso : le rappel sera posé au prochain matin. Mets dans note ce qu'elle attend de ce rappel.",
    parameters: {
      type: "object",
      properties: {
        whenIso: {
          type: "string",
          minLength: 1,
          description:
            "Date/heure ISO 8601 du rappel — SEULEMENT si la personne a exprimé un moment. Omets ce champ sinon.",
        },
        note: {
          type: "string",
          maxLength: 300,
          description: "Note de contexte utile pour la relance (optionnel).",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  set_category: {
    name: "set_category",
    description:
      "Range la fiche du contact dans une catégorie du pipeline, selon les règles de CLASSEMENT données dans ta consigne d'objectif. Appelle-le dès qu'une phrase de la personne tranche l'un de ces cas — n'attends pas la fin de l'échange, et ne classe jamais sur une supposition. Les seules clés acceptées sont celles que les règles nomment : toute autre valeur est refusée. Classer ne remplace ni update_qualification (qui enregistre les faits) ni stop (qui arrête tout) ; on peut classer et continuer la conversation.",
    parameters: {
      type: "object",
      properties: {
        categoryKey: {
          type: "string",
          minLength: 1,
          description:
            "La clé EXACTE indiquée par la règle qui s'applique, telle qu'elle est écrite entre parenthèses dans la liste de classement.",
        },
        reason: {
          type: "string",
          minLength: 1,
          description:
            "Ce que la personne a dit qui justifie ce classement, en une phrase et si possible dans ses mots. C'est ce que le courtier lira sur la fiche.",
        },
      },
      required: ["categoryKey", "reason"],
      additionalProperties: false,
    },
  },
  stop: {
    name: "stop",
    description:
      "Arrête la conversation SANS conclure de résultat précis — pour un refus clair et définitif ou toute situation où poursuivre serait inapproprié. Préfère close_conversation quand un résultat précis (objectif atteint, disqualifié, pas intéressé) peut être établi.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          maxLength: 200,
          description: "Raison de l'arrêt (optionnel, mais utile pour l'audit).",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  handoff: {
    name: "handoff",
    description:
      "Transfère IMMÉDIATEMENT la conversation à un humain — lead chaud, demande explicite de parler à une personne, situation hors du cadre de l'assistant, ou détresse. Appelle-le dès que ces signaux apparaissent, sans attendre la fin de l'échange.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "Raison claire et concise du transfert vers un humain.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },

  transfer_assistant: {
    name: "transfer_assistant",
    description:
      "Transfère la conversation à un AUTRE assistant configuré. N'utilise cet outil QUE si l'identifiant de l'assistant cible t'a été fourni explicitement dans le contexte de la conversation — n'invente jamais un identifiant.",
    parameters: {
      type: "object",
      properties: {
        assistantId: {
          type: "string",
          format: "uuid",
          description: "Identifiant (UUID) de l'assistant cible vers lequel transférer la conversation.",
        },
        reason: {
          type: "string",
          maxLength: 300,
          description: "Raison du transfert (optionnel).",
        },
      },
      required: ["assistantId"],
      additionalProperties: false,
    },
  },

  close_conversation: {
    name: "close_conversation",
    description:
      "Clôt la conversation avec un résultat précis. Appelle-le UNE FOIS l'objectif atteint (rendez-vous réservé, information obtenue), ou dès qu'il devient clair que la personne est disqualifiée ou pas intéressée — ne laisse jamais une conversation se terminer sans cet appel.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["goal_reached", "disqualified", "not_interested"],
          description:
            "Résultat final : objectif atteint, personne disqualifiée, ou personne pas intéressée.",
        },
        note: {
          type: "string",
          maxLength: 300,
          description: "Note de clôture (optionnel).",
        },
      },
      required: ["outcome"],
      additionalProperties: false,
    },
  },
};

// ── Sélection pour un assistant (config.tools) ──────────────────────────────

/**
 * Définitions des outils activés, dans l'ordre CANONIQUE de `ASSISTANT_TOOLS`
 * — l'ordre présenté au modèle est donc toujours le même, peu importe l'ordre
 * stocké en config. Les noms inconnus (config corrompue ou legacy) sont
 * silencieusement ignorés.
 */
export function toolDefsFor(enabled: string[], extraQualificationFields: string[] = []): ToolDef[] {
  const enabledSet = new Set(enabled);
  return ASSISTANT_TOOLS.filter((name) => enabledSet.has(name)).map((name) =>
    name === "update_qualification" && extraQualificationFields.length > 0
      ? updateQualificationDefFor(extraQualificationFields)
      : TOOL_DEFS[name],
  );
}

/**
 * Définition d'`update_qualification` élargie aux champs LIBRES de la chaîne
 * d'objectifs de CET assistant : le JSON Schema (`additionalProperties:
 * false`) doit nommer chaque clé pour que le modèle puisse l'envoyer, et la
 * description doit la lister pour qu'il sache qu'elle existe.
 */
function updateQualificationDefFor(extraFields: string[]): ToolDef {
  const base = TOOL_DEFS.update_qualification;
  const allFields = [...new Set([...QUALIFICATION_FIELDS, ...extraFields])];
  return {
    ...base,
    description: `Enregistre immédiatement toute information de qualification mentionnée par la personne — même partielle, même un seul champ à la fois. Appelle cet outil DÈS qu'une info pertinente apparaît dans la conversation, pas seulement à la fin. Champs valides : ${allFields.join(", ")}.`,
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description:
            "Map partielle champ → valeur extraite, telle qu'exprimée par la personne (n'invente rien, n'infère rien).",
          properties: Object.fromEntries(allFields.map((field) => [field, { type: "string" }])),
          additionalProperties: false,
        },
      },
      required: ["fields"],
      additionalProperties: false,
    },
  };
}

// ── Validation des arguments envoyés par le modèle ──────────────────────────

function isAssistantTool(name: string): name is AssistantTool {
  return (ASSISTANT_TOOLS as readonly string[]).includes(name);
}

export type ParsedToolArgs = { ok: true; name: AssistantTool; args: unknown } | { ok: false; error: string };

/**
 * Valide les arguments envoyés par le modèle pour un outil, AVANT qu'aucun
 * handler ne s'exécute — ne lève JAMAIS, quelle que soit l'entrée (nom ou
 * arguments farfelus). Un nom inconnu ou un échec zod renvoie une erreur
 * structurée plutôt qu'une exception.
 */
export function parseToolArgs(
  name: string,
  args: unknown,
  extraQualificationFields: string[] = [],
): ParsedToolArgs {
  if (!isAssistantTool(name)) {
    return { ok: false, error: `unknown_tool: ${name}` };
  }

  // Le validateur doit accepter exactement ce que la définition offre : les
  // champs libres déclarés au modèle seraient sinon refusés ici.
  const schema =
    name === "update_qualification" && extraQualificationFields.length > 0
      ? updateQualificationArgsSchemaFor(extraQualificationFields)
      : TOOL_ARG_SCHEMAS[name];
  const result = schema.safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".") || "(racine)";
    return { ok: false, error: `invalid_args: ${path}: ${issue.message}` };
  }

  return { ok: true, name, args: result.data };
}

// ── Erreur structurée — book_meeting avec champs manquants ──────────────────

/**
 * Erreur FRANÇAISE structurée que le modèle doit lire et sur laquelle il doit
 * agir : book_meeting doit REFUSER quand des champs requis manquent, plutôt
 * que réserver en silence. Le texte nomme les champs manquants pour que le
 * modèle les redemande précisément plutôt que de répondre vaguement.
 */
export function missingFieldsError(missing: string[]): string {
  return `Impossible de réserver : il manque encore ces informations : ${missing.join(", ")}. Demande-les avant de réserver.`;
}

/**
 * Ce que le modèle lit quand `book_meeting` échoue. Le CODE seul ne suffit
 * pas : « slot_taken » et « too_soon » appellent deux phrases opposées, et le
 * message générique (« propose autre chose ») laissait le modèle annoncer un
 * créneau pris alors qu'il était seulement trop proche. Chaque cause dit donc
 * quoi faire ensuite, et aucune n'autorise à confirmer.
 */
export function bookingFailureError(error: string): string {
  const guidance: Record<string, string> = {
    too_soon:
      "cette heure est trop proche pour être réservée (préavis minimal du courtier). Rappelle get_slots et propose une heure PLUS TARD — ne dis jamais qu'elle vient d'être prise.",
    slot_taken:
      "ce créneau vient d'être pris. Rappelle get_slots et propose les nouvelles heures libres.",
    google_error:
      "l'agenda est injoignable — n'annonce AUCUNE heure et propose de faire confirmer par un humain.",
    invalid_slot:
      "l'heure envoyée n'est pas exploitable. Reprends une heure EXACTEMENT telle que get_slots l'a rendue.",
    not_bookable:
      "la réservation est impossible sur cette fiche. N'annonce rien et passe la main à un humain.",
  };
  const what = guidance[error] ?? "la réservation a échoué. N'annonce aucune heure.";
  return `book_meeting : ÉCHEC (${error}) — ne confirme RIEN : ${what}`;
}
