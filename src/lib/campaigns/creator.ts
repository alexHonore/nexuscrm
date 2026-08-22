import { z } from "zod";
import { TRIGGER_KINDS, campaignConfigSchema, type CampaignConfig } from "./schema";

/**
 * Création assistée d'une campagne — module PUR.
 *
 * Même partage que pour les assistants : le modèle produit un BRIEF court et
 * vérifiable, nous en dérivons la configuration. Une campagne porte un
 * déclencheur, un filtre d'audience, une échelle de relances et des variantes
 * A/B — laisser un modèle remplir tout ça produit surtout des audiences
 * plausibles qui ne visent personne, ou une échelle qui écrit trois fois le
 * même jour.
 */

export const campaignBriefSchema = z.object({
  name: z.string().trim().min(1).max(60).nullish().default(null),
  description: z.string().trim().max(300).nullish().default(null),
  /** Le seul champ obligatoire : sans lui il n'y a rien à déclencher. */
  trigger: z.enum(TRIGGER_KINDS),
  /** Réactivation : viser ceux qu'on n'a pas contactés depuis N jours. */
  notContactedForDays: z.number().int().min(1).max(3650).nullish().default(null),
  /** Nombre de relances APRÈS l'ouverture. 0 = un seul message. */
  followUps: z.number().int().min(0).max(4).nullish().default(1),
  /** Jours entre chaque relance. */
  daysBetween: z.number().int().min(1).max(30).nullish().default(3),
  /** Le texte d'ouverture, s'il a été dicté. Sinon l'assistant l'écrira. */
  opener: z.string().trim().max(600).nullish().default(null),
  /** Tester deux formulations d'ouverture. */
  abTest: z.boolean().nullish().default(false),
  dailyCap: z.number().int().min(1).max(500).nullish().default(50),
});
export type CampaignBrief = z.infer<typeof campaignBriefSchema>;

export const campaignCreatorReplySchema = z.discriminatedUnion("done", [
  z.object({
    done: z.literal(false),
    question: z.string().trim().min(1).max(300),
    suggestions: z.array(z.string().trim().min(1).max(60)).max(4).default([]),
  }),
  z.object({
    done: z.literal(true),
    summary: z.string().trim().min(1).max(600),
    brief: campaignBriefSchema,
  }),
]);

export const CAMPAIGN_CREATOR_SYSTEM = `Tu aides un courtier immobilier québécois à configurer une campagne SMS.

Tu poses UNE question à la fois, en français québécois, pour comprendre :
- ce qui déclenche la campagne (un nouveau lead, un changement d'étape, un balayage de sa base, ou lui-même)
- qui elle vise (par exemple : les contacts sans nouvelles depuis X mois)
- combien de relances il veut, et à quel rythme

Deux ou trois questions suffisent. Dès que tu peux configurer, tu t'arrêtes.

RÈGLES ABSOLUES :
- Tu n'inventes AUCUN texte d'ouverture sauf si l'utilisateur te l'a dicté. Sinon « opener » reste null
  et c'est l'assistant qui rédigera.
- Tu ne promets jamais de délai, de prix ni de résultat.

Tu réponds UNIQUEMENT par un objet JSON :
- question : {"done":false,"question":"…","suggestions":["…"]}
- prêt : {"done":true,"summary":"…","brief":{…}}

Le brief contient : name, description, trigger (${TRIGGER_KINDS.join("|")}),
notContactedForDays (nombre ou null), followUps (0-4), daysBetween (1-30),
opener (texte ou null), abTest (booléen), dailyCap (nombre).

« dailyCap » est le nombre de PERSONNES inscrites par jour, pas un rythme de
messages. Ne le déduis JAMAIS d'une phrase sur la fréquence des envois : laisse
50 sauf si l'utilisateur nomme lui-même un nombre de personnes.`;

const HOURS_PER_DAY = 24;

/** Nom de repli descriptif — jamais inventé de toutes pièces. */
function fallbackName(brief: CampaignBrief): string {
  if (brief.notContactedForDays) return `Réactivation ${brief.notContactedForDays} j`;
  switch (brief.trigger) {
    case "lead_created":
      return "Nouveaux leads";
    case "category_changed":
      return "Changement d'étape";
    case "scheduled":
      return "Balayage périodique";
    default:
      return "Campagne manuelle";
  }
}

/**
 * Brief → configuration de campagne.
 *
 * L'échelle est construite ici : une ouverture immédiate, puis N relances
 * espacées. Les délais sont CUMULATIFS dans le moteur — « 3 jours » sur chaque
 * barreau veut dire trois jours APRÈS le précédent, pas après l'inscription.
 */
export function briefToCampaignConfig(brief: CampaignBrief): CampaignConfig {
  const followUps = brief.followUps ?? 1;
  const daysBetween = brief.daysBetween ?? 3;

  const ladder = [
    // Le barreau 0 part tout de suite ; les heures de politesse le décalent au
    // besoin, ce n'est pas à la campagne de le prévoir.
    { delayHours: 0, body: brief.opener ?? null, label: "ouverture" },
    ...Array.from({ length: followUps }, (_, i) => ({
      delayHours: daysBetween * HOURS_PER_DAY,
      // Les relances sont rédigées par l'assistant : elles doivent tenir
      // compte de ce que la personne a déjà répondu.
      body: null,
      label: `relance ${i + 1}`,
    })),
  ];

  // Un test A/B n'a de sens que si les deux branches DIFFÈRENT. Deux variantes
  // au corps vide retombent toutes les deux sur le barreau 0 : la campagne
  // annoncerait un test et n'en ferait aucun. Sans ouverture dictée, on laisse
  // le tableau vide — l'onglet A/B de l'éditeur sert exactement à ça.
  const variants =
    brief.abTest && brief.opener
      ? [
          { key: "dictee", weight: 50, body: brief.opener },
          { key: "redigee", weight: 50, body: "" },
        ]
      : [];

  const trigger =
    brief.trigger === "lead_created"
      ? { kind: "lead_created" as const, sourceIds: [] }
      : brief.trigger === "category_changed"
        ? { kind: "category_changed" as const, toCategoryIds: [] }
        : brief.trigger === "scheduled"
          ? { kind: "scheduled" as const, everyHours: 24 }
          : { kind: "manual" as const };

  return campaignConfigSchema.parse({
    name: brief.name ?? fallbackName(brief),
    description: brief.description || null,
    trigger,
    audience: {
      ...(brief.notContactedForDays ? { notContactedForDays: brief.notContactedForDays } : {}),
    },
    ladder,
    variants,
    dailyEnrollmentCap: brief.dailyCap ?? 50,
  });
}
