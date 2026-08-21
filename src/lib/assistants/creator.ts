import { z } from "zod";
import {
  GOAL_TYPES,
  QUALIFICATION_FIELDS,
  assistantConfigSchema,
  type AssistantConfig,
} from "./schema";

/**
 * Création assistée — module PUR.
 *
 * Le modèle ne produit PAS une configuration complète. Il produit un BRIEF :
 * une dizaine de champs simples, tous validés. C'est nous qui en dérivons la
 * configuration, de façon déterministe.
 *
 * Pourquoi : une configuration d'assistant compte une cinquantaine de champs,
 * dont des identifiants d'utilisateur, des surcouches de prompt et un objet de
 * routage. Demander tout ça d'un coup à un modèle produit surtout des champs
 * plausibles mais faux — et un assistant mal configuré se découvre en
 * production. Un brief court se vérifie ; le reste vient de défauts que nous
 * maîtrisons.
 */

export const AUDIENCES = ["buyer", "seller", "both", "unknown"] as const;

/**
 * Le brief. Presque tout est FACULTATIF, et c'est délibéré.
 *
 * Un modèle honnête renvoie `null` pour ce qu'il ne sait pas — il ne va pas
 * inventer un nom d'assistant que personne ne lui a donné. Rejeter le brief
 * entier pour ça obligerait à tout recommencer et donnerait l'impression que
 * la fonction est cassée. Ce qui manque reçoit une valeur par défaut à l'étape
 * suivante ; l'utilisateur relit de toute façon avant de créer.
 */
export const assistantBriefSchema = z.object({
  name: z.string().trim().min(1).max(60).nullish().default(null),
  description: z.string().trim().max(300).nullish().default(null),
  audience: z.enum(AUDIENCES).nullish().default("unknown"),
  /** Le seul champ vraiment obligatoire : sans objectif, il n'y a rien à configurer. */
  goalType: z.enum(GOAL_TYPES),
  /** Durée annoncée d'une rencontre, quand l'objectif en réserve une. */
  durationMin: z.number().int().min(5).max(120).nullish().default(null),
  requiredFields: z.array(z.enum(QUALIFICATION_FIELDS)).max(4).nullish().default([]),
  persistence: z.number().int().min(1).max(5).nullish().default(3),
  warmth: z.number().int().min(1).max(5).nullish().default(3),
  questionBudget: z.number().int().min(1).max(4).nullish().default(2),
  formality: z.enum(["vous", "tu"]).nullish().default("vous"),
  /**
   * Faits d'affaires que l'assistant pourra affirmer. Le modèle n'a le droit
   * d'en proposer que si l'utilisateur les a ÉCRITS : tout le reste serait
   * inventé, et sortirait ensuite au nom d'un courtier titulaire d'un permis.
   */
  claims: z.array(z.string().trim().min(1).max(300)).max(6).nullish().default([]),
});
export type AssistantBrief = z.infer<typeof assistantBriefSchema>;

/** Ce que le modèle renvoie à chaque tour : une question, ou le brief final. */
export const creatorReplySchema = z.discriminatedUnion("done", [
  z.object({
    done: z.literal(false),
    /** UNE question à la fois — un formulaire déguisé en conversation n'aide personne. */
    question: z.string().trim().min(1).max(300),
    /** Réponses suggérées, pour pouvoir répondre d'un clic. */
    suggestions: z.array(z.string().trim().min(1).max(60)).max(4).default([]),
  }),
  z.object({
    done: z.literal(true),
    /** Ce que le modèle a compris, à relire avant de créer. */
    summary: z.string().trim().min(1).max(600),
    brief: assistantBriefSchema,
  }),
]);
export type CreatorReply = z.infer<typeof creatorReplySchema>;

export const CREATOR_SYSTEM = `Tu aides un courtier immobilier québécois à configurer un assistant SMS.

Tu poses UNE question à la fois, en français québécois, pour comprendre :
- à qui il écrit (acheteurs, vendeurs, les deux)
- ce qu'il veut obtenir (une rencontre, un appel, un courriel, ou seulement qualifier)
- à quel point l'assistant doit insister
- ce qu'il doit apprendre du client avant de proposer quoi que ce soit

Trois questions suffisent presque toujours. Dès que tu as de quoi configurer, tu t'arrêtes.

RÈGLES ABSOLUES :
- Tu n'inventes AUCUN fait sur l'entreprise. Le champ « claims » ne contient QUE des
  phrases que l'utilisateur a écrites lui-même. Dans le doute, il reste vide.
- Tu ne proposes jamais de chiffre de marché, de délai de vente ni de statistique.

Tu réponds UNIQUEMENT par un objet JSON, sans texte autour :
- pour poser une question : {"done":false,"question":"…","suggestions":["…","…"]}
- quand c'est prêt : {"done":true,"summary":"…","brief":{…}}

Le brief contient : name, description, audience (buyer|seller|both|unknown),
goalType (${GOAL_TYPES.join("|")}), durationMin (nombre ou null),
requiredFields (parmi ${QUALIFICATION_FIELDS.join("|")}, 2 maximum de préférence),
persistence (1-5), warmth (1-5), questionBudget (1-4), formality (vous|tu),
claims (tableau, vide si l'utilisateur n'a rien affirmé).`;

/** Les objectifs qui réservent réellement une plage d'agenda. */
const BOOKING_GOALS = new Set(["video_meeting", "in_person_meeting", "phone_call"]);

/**
 * Brief → configuration complète.
 *
 * Déterministe et testable sans modèle : c'est ici que vivent les décisions
 * que le modèle n'a pas à prendre — le type de rendez-vous découlant de
 * l'objectif, les outils nécessaires, les paquets d'objections selon
 * l'audience.
 */
/** Nom de repli quand le modèle n'en a pas proposé — jamais inventé de toutes pièces. */
function fallbackName(audience: string, goalType: string): string {
  const who =
    audience === "buyer" ? "Acheteurs" : audience === "seller" ? "Vendeurs" : "Contacts";
  const what =
    goalType === "qualify_only" ? "qualification" : goalType === "collect_email" ? "courriel" : "rencontre";
  return `${who} — ${what}`;
}

export function briefToConfig(
  brief: AssistantBrief,
  defaults: { orgName: string; brokerName: string; brokerUserId: string | null },
): AssistantConfig {
  const books = BOOKING_GOALS.has(brief.goalType);
  const audience = brief.audience ?? "unknown";
  const appointmentType =
    brief.goalType === "in_person_meeting" ? "inperson" : books ? "meet" : null;

  // Un repli d'un cran sous l'objectif : « pas cette semaine » ne doit pas
  // clore la conversation quand une demande plus légère peut encore aboutir.
  const fallbacks =
    brief.goalType === "video_meeting" || brief.goalType === "in_person_meeting"
      ? [{ type: "phone_call" as const, durationMin: 15, appointmentType: "meet" as const }]
      : brief.goalType === "phone_call"
        ? [{ type: "collect_email" as const }]
        : [];

  const packs =
    audience === "buyer"
      ? ["buyer_fr"]
      : audience === "seller"
        ? ["seller_fr"]
        : audience === "both"
          ? ["buyer_fr", "seller_fr"]
          : [];

  return assistantConfigSchema.parse({
    name: brief.name ?? fallbackName(audience, brief.goalType),
    description: brief.description || null,
    identity: {
      mode: defaults.brokerUserId ? "named_person" : "team",
      orgName: defaults.orgName,
      brokerName: defaults.brokerName,
      brokerUserId: defaults.brokerUserId,
    },
    goal: {
      primary: {
        type: brief.goalType,
        durationMin: books ? (brief.durationMin ?? 30) : null,
        appointmentType,
        requiredFields: brief.requiredFields ?? [],
        slotOfferCount: 2,
      },
      fallbacks,
    },
    approach: {
      formality: brief.formality ?? "vous",
      persistence: brief.persistence ?? 3,
      warmth: brief.warmth ?? 3,
      questionBudget: brief.questionBudget ?? 2,
    },
    knowledge: { claims: brief.claims ?? [] },
    objectionPacks: packs,
    // « stop » et « handoff » toujours ; les outils d'agenda seulement si
    // l'objectif réserve quelque chose — offrir `book_meeting` à un assistant
    // qui ne réserve pas produit des appels d'outil qui échouent.
    tools: books
      ? ["get_slots", "book_meeting", "update_qualification", "stop", "handoff"]
      : ["update_qualification", "schedule_followup", "stop", "handoff"],
    model: {},
  });
}
