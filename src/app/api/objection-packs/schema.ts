import { z } from "zod";
import { objectionItemSchema } from "@/lib/guardrails/types";

/**
 * Un identifiant STABLE, écrit une fois.
 *
 * C'est lui que `assistants.objection_packs` référence et que le fichier
 * d'export transporte : le renommer romprait chaque assistant qui l'utilise,
 * d'où l'absence de `id` dans le schéma de modification.
 */
const idSchema = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9_]+$/, "minuscules, chiffres et tirets bas seulement");

export const packInputSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(120),
  language: z.string().trim().min(2).max(10).default("fr-CA"),
  items: z.array(objectionItemSchema).max(40).default([]),
});
