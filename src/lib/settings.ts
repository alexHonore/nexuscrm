import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { settings } from "@/db/schema";

// ── Schemas des réglages ─────────────────────────────────────────────────────

export const bookingSettingsSchema = z.object({
  /** Jours réservables, 0 = dimanche … 6 = samedi */
  days: z.array(z.number().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
  startHour: z.string().default("06:00"),
  endHour: z.string().default("23:00"),
  meetDurationMin: z.number().default(30),
  inPersonDurationMin: z.number().default(60),
  bufferMin: z.number().default(15),
  timezone: z.string().default("America/Toronto"),
  inPersonDefaultLocation: z.string().default(""),
  /**
   * Courriel du courtier, invité à chaque rendez-vous. Il reçoit ainsi une
   * vraie invitation dès que le compte Google connecté n'est pas ce courriel
   * (l'organisateur, lui, ne reçoit jamais de courriel — l'évènement apparaît
   * directement sur son agenda). Chaîne vide = personne d'autre n'est invité.
   */
  brokerEmail: z.email().or(z.literal("")).default("info@alexhonore.com"),
});
export type BookingSettings = z.infer<typeof bookingSettingsSchema>;

export const googleSettingsSchema = z.object({
  /** Refresh token chiffré (AES-256-GCM) */
  refreshTokenEnc: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  calendarId: z.string().default("primary"),
  connectedAt: z.string().nullable().default(null),
});
export type GoogleSettings = z.infer<typeof googleSettingsSchema>;

/**
 * Le CLASSEMENT automatique : ce que l'assistant a le droit de conclure d'une
 * phrase, et où il doit alors ranger la fiche.
 *
 * Une règle est une condition en toutes lettres et une catégorie du pipeline —
 * « projet à plus de six mois » → « Long terme », « hors de Grand Québec,
 * Grand Lévis ou Grand Montréal » → « Non qualifié ». C'est du texte parce que
 * la condition est un jugement, pas un test : « l'année prochaine » ne se
 * compare à rien, il faut le comprendre.
 *
 * Les règles servent AUSSI de liste blanche : l'assistant ne peut ranger une
 * fiche que dans une catégorie nommée par une règle active. Aucune règle vers
 * « Ne pas appeler » ⇒ il ne peut pas y toucher, et il n'y a pas de second
 * réglage à tenir d'accord avec le premier.
 *
 * Ces règles valent pour toute l'entreprise, pas par assistant : le territoire
 * desservi et le seuil du « long terme » ne changent pas selon le robot qui
 * écrit. Ce qui reste par assistant, c'est le DROIT de classer — l'outil
 * `set_category` dans sa liste d'outils.
 */
export const classificationSettingsSchema = z.object({
  rules: z
    .array(
      z.object({
        id: z.string().min(1),
        /** La condition, en toutes lettres, telle que le modèle la lira. */
        when: z.string().trim().min(3).max(300),
        /** Valeur de catégorie — `key` ou « cat:<id> », comme les dispositions. */
        category: z.string().trim().min(1).max(80),
        enabled: z.boolean().default(true),
      }),
    )
    .max(30)
    .default([]),
});
export type ClassificationSettings = z.infer<typeof classificationSettingsSchema>;

export const telephonySettingsSchema = z.object({
  provider: z.enum(["voipms", "twilio"]).default("voipms"),
});
export type TelephonySettings = z.infer<typeof telephonySettingsSchema>;

export const smsSettingsSchema = z.object({
  /**
   * Interrupteur d'arrêt global du moteur SMS. À true, AUCUN message ne part,
   * peu importe le mode (dry_run/sandbox/live) ni le chemin de code.
   */
  killSwitch: z.boolean().default(false),
  killSwitchReason: z.string().nullable().default(null),
  killSwitchAt: z.string().nullable().default(null),
  /**
   * Battement du répartiteur — ISO, écrit à chaque cycle.
   *
   * C'est le SEUL signal fiable qu'il tourne encore : se fier au dernier job
   * réclamé dirait « arrêté » chaque fois que la file est simplement vide, et
   * un répartiteur arrêté est la panne la plus silencieuse du moteur (rien
   * n'échoue, rien ne part).
   */
  lastDispatchAt: z.string().nullable().default(null),
});
export type SmsSettings = z.infer<typeof smsSettingsSchema>;

const SCHEMAS = {
  booking: bookingSettingsSchema,
  google: googleSettingsSchema,
  telephony: telephonySettingsSchema,
  sms: smsSettingsSchema,
  classification: classificationSettingsSchema,
} as const;

export type SettingKey = keyof typeof SCHEMAS;

// ── Accès ────────────────────────────────────────────────────────────────────

export async function getSetting<K extends SettingKey>(key: K): Promise<z.infer<(typeof SCHEMAS)[K]>> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  const schema = SCHEMAS[key];
  const parsed = schema.safeParse(row?.value ?? {});
  if (parsed.success) return parsed.data as z.infer<(typeof SCHEMAS)[K]>;
  return schema.parse({}) as z.infer<(typeof SCHEMAS)[K]>;
}

export async function setSetting<K extends SettingKey>(
  key: K,
  // z.input : les champs à valeur par défaut restent optionnels — parse() les complète.
  value: z.input<(typeof SCHEMAS)[K]>,
): Promise<void> {
  const validated = SCHEMAS[key].parse(value);
  await db
    .insert(settings)
    .values({ key, value: validated, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: validated, updatedAt: new Date() } });
}
