import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { CONSENT_VALIDITIES, DEFAULT_CONSENT_VALIDITY } from "@/lib/sms/consent";

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
   * Durée de validité estampillée sur les NOUVEAUX consentements du registre
   * (le registre est append-only : les rangées existantes gardent leur
   * échéance sauf recalcul explicite). Défaut : illimité (choix de l'admin) ;
   * « 6m » = fenêtre LCAP du consentement implicite après demande.
   */
  consentValidity: z.enum(CONSENT_VALIDITIES).default(DEFAULT_CONSENT_VALIDITY),
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
