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

export const telephonySettingsSchema = z.object({
  provider: z.enum(["voipms", "twilio"]).default("voipms"),
});
export type TelephonySettings = z.infer<typeof telephonySettingsSchema>;

const SCHEMAS = {
  booking: bookingSettingsSchema,
  google: googleSettingsSchema,
  telephony: telephonySettingsSchema,
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
