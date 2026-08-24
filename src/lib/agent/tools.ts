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

const updateQualificationArgsSchema = z.object({
  /**
   * Map PARTIELLE champ → valeur extraite (0 à 8 champs, une extraction à la
   * fois en pratique). `z.record` avec des clés enum exige les 8 clés en zod
   * v4 (vérifié) ; `z.partialRecord` est la forme qui accepte réellement un
   * sous-ensemble, et rejette toujours une clé hors vocabulaire.
   *
   * Les valeurs sont conservées sur la conversation et réinjectées dans le
   * prompt système à chaque tour : une ligne, bornées (`contact-data.ts`).
   */
  fields: z.partialRecord(z.enum(QUALIFICATION_FIELDS), z.string().transform((v) => contactValue(v))),
});

const scheduleFollowupArgsSchema = z.object({
  whenIso: z.string().min(1),
  note: z.string().max(300).optional(),
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
      "Planifie un rappel à une date/heure précise lorsque la personne demande à être recontactée PLUS TARD plutôt que de réserver maintenant. N'invente pas d'heure : utilise ce que la personne a exprimé, reformulé en ISO 8601.",
    parameters: {
      type: "object",
      properties: {
        whenIso: {
          type: "string",
          minLength: 1,
          description: "Date/heure ISO 8601 du rappel.",
        },
        note: {
          type: "string",
          maxLength: 300,
          description: "Note de contexte utile pour la relance (optionnel).",
        },
      },
      required: ["whenIso"],
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
export function toolDefsFor(enabled: string[]): ToolDef[] {
  const enabledSet = new Set(enabled);
  return ASSISTANT_TOOLS.filter((name) => enabledSet.has(name)).map((name) => TOOL_DEFS[name]);
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
export function parseToolArgs(name: string, args: unknown): ParsedToolArgs {
  if (!isAssistantTool(name)) {
    return { ok: false, error: `unknown_tool: ${name}` };
  }

  const result = TOOL_ARG_SCHEMAS[name].safeParse(args);
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
