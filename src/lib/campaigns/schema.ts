import { z } from "zod";

/**
 * Formes d'une campagne — module PUR (ni Next, ni base, ni horloge implicite).
 *
 * Une campagne répond à quatre questions, et le schéma les sépare exprès :
 * QUI déclenche une inscription (trigger), QUI est éligible (audience), QUOI
 * est envoyé et QUAND (ladder), et QUELLE formulation (variants).
 */

// ── Déclencheur ──────────────────────────────────────────────────────────────

export const TRIGGER_KINDS = [
  "manual",
  "lead_created",
  "category_changed",
  "scheduled",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const triggerSchema = z.discriminatedUnion("kind", [
  /** L'administrateur choisit l'audience et inscrit lui-même. */
  z.object({ kind: z.literal("manual") }),
  /**
   * Un lead vient d'arriver (webhook n8n / Facebook). Le filtre de source est
   * ici et non dans l'audience : c'est l'ÉVÉNEMENT qu'on restreint, pas la
   * population — une campagne peut viser des leads Facebook sans exclure de son
   * audience les gens venus d'ailleurs.
   */
  z.object({
    kind: z.literal("lead_created"),
    sourceIds: z.array(z.number().int()).default([]),
  }),
  /** Le client change de catégorie de pipeline (ex. « à rappeler » → « chaud »). */
  z.object({
    kind: z.literal("category_changed"),
    toCategoryIds: z.array(z.number().int()).default([]),
  }),
  /**
   * Balayage périodique de l'audience — la réactivation d'une vieille base.
   * `everyHours` borne la fréquence du balayage, pas le rythme d'envoi.
   */
  z.object({
    kind: z.literal("scheduled"),
    everyHours: z.number().int().min(1).max(24 * 30).default(24),
  }),
]);
export type CampaignTrigger = z.infer<typeof triggerSchema>;

// ── Audience ─────────────────────────────────────────────────────────────────

export const audienceSchema = z.object({
  categoryIds: z.array(z.number().int()).default([]),
  sourceIds: z.array(z.number().int()).default([]),
  assignedToIds: z.array(z.uuid()).default([]),
  /** Créés depuis / avant — en jours par rapport à maintenant. */
  createdWithinDays: z.number().int().min(1).nullable().default(null),
  createdBeforeDays: z.number().int().min(1).nullable().default(null),
  /** Sans contact depuis N jours — le cœur d'une campagne de réactivation. */
  notContactedForDays: z.number().int().min(1).nullable().default(null),
  /** Langue du client. Vide = toutes. */
  languages: z.array(z.enum(["fr", "en"])).default([]),
  /**
   * Exclure les clients déjà inscrits à une AUTRE campagne active. Par défaut
   * OUI : deux campagnes qui écrivent à la même personne la même semaine, c'est
   * exactement ce qui fait signaler un numéro comme indésirable.
   */
  excludeActiveInOtherCampaign: z.boolean().default(true),
  /** `clients.doNotCall` vaut pour la voix ; l'exclure du SMS est un choix. */
  excludeDoNotCall: z.boolean().default(true),
});
export type CampaignAudience = z.infer<typeof audienceSchema>;

// ── Échelle de relances ──────────────────────────────────────────────────────

export const ladderStepSchema = z.object({
  /**
   * Délai depuis l'inscription pour le barreau 0, depuis le barreau précédent
   * ensuite. Compté en heures : plus court n'aurait pas de sens face aux heures
   * de politesse, qui repoussent de toute façon au lendemain matin.
   */
  delayHours: z.number().int().min(0).max(24 * 90),
  /**
   * Texte du message. `null` = laisser l'assistant rédiger. Un barreau écrit à
   * la main reste plus prévisible pour une ouverture ; les suivants gagnent
   * souvent à être générés, parce qu'ils doivent tenir compte de la réponse.
   */
  body: z.string().trim().max(600).nullable().default(null),
  /** Étiquette interne — n'apparaît jamais dans un message. */
  label: z.string().trim().max(80).default(""),
});
export type LadderStep = z.infer<typeof ladderStepSchema>;

export const ladderSchema = z.array(ladderStepSchema).max(8).default([]);

// ── Variantes A/B ────────────────────────────────────────────────────────────

export const variantSchema = z.object({
  /** Clé stable — c'est elle qui est écrite sur l'inscription et sur la trace. */
  key: z.string().trim().min(1).max(24),
  /** Poids relatif ; 0 = variante retirée du tirage sans perdre son historique. */
  weight: z.number().int().min(0).max(100).default(50),
  /**
   * Ouverture propre à la variante. Vide = l'ouverture du barreau 0.
   * C'est le SEUL barreau que le test A/B fait varier : faire varier toute
   * l'échelle rendrait le résultat inattribuable.
   */
  body: z.string().trim().max(600).default(""),
});
export type CampaignVariant = z.infer<typeof variantSchema>;

export const variantsSchema = z.array(variantSchema).max(4).default([]);

// ── Campagne complète ────────────────────────────────────────────────────────

export const campaignConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().default(null),
    assistantId: z.uuid().nullable().default(null),
    smsNumberId: z.uuid().nullable().default(null),
    trigger: triggerSchema,
    // `prefault` et non `default` : l'objet vide TRAVERSE le schéma, donc les
    // valeurs par défaut restent celles déclarées plus haut et ne peuvent pas
    // se décaler d'une copie oubliée ici.
    audience: audienceSchema.prefault({}),
    ladder: ladderSchema,
    variants: variantsSchema,
    dailyEnrollmentCap: z.number().int().min(1).max(5000).default(50),
    totalEnrollmentCap: z.number().int().min(1).nullable().default(null),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
    requireConsent: z.boolean().default(true),
  })
  .refine((c) => c.startsAt === null || c.endsAt === null || c.endsAt > c.startsAt, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })
  .refine((c) => c.variants.length === 0 || c.variants.some((v) => v.weight > 0), {
    // Toutes les variantes à zéro : le tirage n'a aucune issue et la campagne
    // n'enverrait rien, sans rien dire.
    message: "at least one variant must have a non-zero weight",
    path: ["variants"],
  })
  .refine((c) => new Set(c.variants.map((v) => v.key)).size === c.variants.length, {
    message: "variant keys must be unique",
    path: ["variants"],
  });
export type CampaignConfig = z.infer<typeof campaignConfigSchema>;

/** La ligne en base → config, pour que l'éditeur et le moteur voient la même chose. */
export function campaignRowToConfig(row: {
  name: string;
  description: string | null;
  assistantId: string | null;
  smsNumberId: string | null;
  trigger: unknown;
  audience: unknown;
  ladder: unknown;
  variants: unknown;
  dailyEnrollmentCap: number;
  totalEnrollmentCap: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  requireConsent: boolean;
}): CampaignConfig {
  return campaignConfigSchema.parse({
    name: row.name,
    description: row.description,
    assistantId: row.assistantId,
    smsNumberId: row.smsNumberId,
    trigger: row.trigger,
    audience: row.audience,
    ladder: row.ladder,
    variants: row.variants,
    dailyEnrollmentCap: row.dailyEnrollmentCap,
    totalEnrollmentCap: row.totalEnrollmentCap,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    requireConsent: row.requireConsent,
  });
}
