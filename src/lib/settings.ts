import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { permissionsSettingsSchema } from "@/lib/permissions/schema";

// ── Schemas des réglages ─────────────────────────────────────────────────────

/** Heure murale « HH:MM » (24 h) — ce que produit `<input type="time">`. */
const HOUR_MINUTE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Fuseau IANA reconnu par le moteur (ou chaîne vide = repli sur
 * America/Toronto, que les lecteurs appliquent déjà). Un fuseau inventé ne
 * fait pas échouer `fromZonedTime` — il rend une Invalid Date qui vide
 * silencieusement les disponibilités, puis fait planter l'affichage.
 */
function isKnownTimeZone(tz: string): boolean {
  if (tz === "") return true;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Bornes serveur des réglages de réservation. Elles sont la SEULE garde : le
 * formulaire admin n'est pas un `<form>` (ses `min`/`max` HTML ne s'appliquent
 * jamais) et un champ vidé y devient « » ou 0 — valeurs qui, stockées,
 * vidaient toutes les disponibilités sans la moindre erreur.
 */
export const bookingSettingsSchema = z
  .object({
    /** Jours réservables, 0 = dimanche … 6 = samedi */
    days: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
    startHour: z.string().regex(HOUR_MINUTE_RE).default("06:00"),
    endHour: z.string().regex(HOUR_MINUTE_RE).default("23:00"),
    meetDurationMin: z.number().int().min(5).max(480).default(30),
    inPersonDurationMin: z.number().int().min(5).max(480).default(60),
    bufferMin: z.number().int().min(0).max(480).default(15),
    /**
     * Préavis MINIMAL avant un rendez-vous (minutes) : aucun créneau plus
     * proche que ça n'est offert ni réservable — ni à l'écran, ni par l'agent
     * SMS (`book()` le revérifie et rend `too_soon`). Borne haute 7 jours.
     *
     * Défaut 180 (3 h) et non 45 comme l'ancienne constante `MIN_LEAD_MIN` :
     * l'agent a proposé le 2026-08-27 une rencontre le jour même à 17 h 30
     * alors qu'il était 15 h 07 — 2 h 23 d'avis, jugé trop court par le
     * courtier. Ce défaut est ce que voit une installation qui n'a jamais
     * enregistré la clé (le cas de la production), d'où le choix d'une valeur
     * sûre plutôt que de l'ancienne.
     */
    minNoticeMin: z.number().int().min(0).max(10_080).default(180),
    timezone: z.string().refine(isKnownTimeZone, "unknown_timezone").default("America/Toronto"),
    inPersonDefaultLocation: z.string().default(""),
    /**
     * Courriel du courtier, invité à chaque rendez-vous. Il reçoit ainsi une
     * vraie invitation dès que le compte Google connecté n'est pas ce courriel
     * (l'organisateur, lui, ne reçoit jamais de courriel — l'évènement apparaît
     * directement sur son agenda). Chaîne vide = personne d'autre n'est invité.
     */
    brokerEmail: z.email().or(z.literal("")).default("info@alexhonore.com"),
  })
  // « HH:MM » se compare en texte ; une fenêtre vide ou inversée n'a aucun sens
  // (et rendrait zéro créneau pour tout le monde, sans explication).
  .refine((s) => s.startHour < s.endHour, {
    message: "end_before_start",
    path: ["endHour"],
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

export const consumptionSettingsSchema = z.object({
  /**
   * Taux de REPLI pour estimer la dépense SMS (dollars US par segment) quand le
   * coût réel de Twilio est indisponible (non configuré, API injoignable).
   * Défaut 0,0079 $ — le tarif SMS sortant publié par Twilio pour les États-Unis
   * et le Canada (numéros longs). L'admin peut y mettre son tarif exact. Quand
   * Twilio répond, c'est son coût FACTURÉ qui prime, jamais cette estimation.
   */
  smsSegmentCostUsd: z.number().min(0).max(10).default(0.0079),
});
export type ConsumptionSettings = z.infer<typeof consumptionSettingsSchema>;

/**
 * Les NOTES D'APPEL par IA : chaque appel enregistré est transcrit puis résumé
 * par un modèle audio, et la note atterrit en commentaire sur la fiche.
 *
 * Éteint par défaut : chaque appel traité COÛTE de l'argent (l'audio entier
 * part chez le modèle), et l'admin doit choisir son modèle et son niveau de
 * détail avant que la facture ne commence. Les bornes de durée sont la garde
 * de coût : sous `minSeconds` il n'y a rien à résumer (répondeur, faux
 * numéro) ; au-delà de `maxMinutes` l'audio devient trop lourd pour une seule
 * requête.
 */
export const transcriptsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Niveau de détail de la note poussée en commentaire. `exhaustive` :
   * compte rendu chronologique horodaté où TOUT est consigné, même
   * l'accessoire — pour qui veut la mémoire complète de l'appel sur la fiche.
   */
  detail: z.enum(["brief", "standard", "detailed", "exhaustive"]).default("standard"),
  /**
   * Langue de la NOTE (une donnée de fiche, pas un texte d'interface) — même
   * logique que la langue d'un assistant : jamais le cookie NEXT_LOCALE.
   */
  language: z.enum(["fr", "en"]).default("fr"),
  /**
   * Modèle OpenRouter ACCEPTANT L'AUDIO (l'appel part en `input_audio`, pas en
   * texte). Toujours via OpenRouter : c'est le seul fournisseur câblé dont le
   * routage impose deny + ZDR (Loi 25) sur un contenu aussi sensible qu'un
   * appel enregistré.
   */
  model: z.string().trim().min(1).max(200).default("google/gemini-2.5-flash"),
  minSeconds: z.number().int().min(5).max(600).default(20),
  maxMinutes: z.number().int().min(1).max(120).default(30),
  /** Conserver le verbatim en base (la note, elle, est toujours conservée). */
  keepTranscript: z.boolean().default(true),
});
export type TranscriptsSettings = z.infer<typeof transcriptsSettingsSchema>;

const SCHEMAS = {
  booking: bookingSettingsSchema,
  /**
   * Rôles, droits et règles d'assignation — voir src/lib/permissions/.
   * Le schéma vit là-bas parce qu'il est LU ailleurs qu'ici (écrans, tests
   * purs) et qu'il ne doit pas traîner `server-only` derrière lui.
   */
  permissions: permissionsSettingsSchema,
  google: googleSettingsSchema,
  telephony: telephonySettingsSchema,
  sms: smsSettingsSchema,
  classification: classificationSettingsSchema,
  consumption: consumptionSettingsSchema,
  transcripts: transcriptsSettingsSchema,
} as const;

export type SettingKey = keyof typeof SCHEMAS;

// ── Accès ────────────────────────────────────────────────────────────────────

/**
 * Une valeur illisible retombe sur les valeurs par défaut — mais BRUYAMMENT.
 *
 * Le compromis est délibéré, et il est déséquilibré : relancer l'erreur ferait
 * tomber toutes les pages qui lisent ce réglage, c'est-à-dire l'application
 * entière pour une seule ligne de JSON abîmée. Se taire, en revanche, laisse
 * l'application tourner AVEC LES MAUVAISES VALEURS sans que personne ne
 * l'apprenne. On garde donc le repli, on le crie dans le journal du serveur, et
 * surtout : les schémas dont un repli silencieux serait dangereux se rendent
 * TOTAUX pour que cette branche ne les concerne jamais.
 *
 * C'est le cas de `permissions` (voir src/lib/permissions/schema.ts) : ses
 * valeurs par défaut, ce sont les quatre rôles livrés avec une table
 * d'affectation VIDE — tout superviseur et tout observateur redeviendrait
 * téléphoniste. Un magasin d'autorisations ne doit pas échouer OUVERT, et son
 * schéma accepte donc n'importe quoi (chaîne, nombre, tableau, `null`) plutôt
 * que d'échouer.
 */
export async function getSetting<K extends SettingKey>(key: K): Promise<z.infer<(typeof SCHEMAS)[K]>> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
  const schema = SCHEMAS[key];
  const parsed = schema.safeParse(row?.value ?? {});
  if (parsed.success) return parsed.data as z.infer<(typeof SCHEMAS)[K]>;
  console.error(
    `[settings] réglage « ${key} » illisible en base — repli sur les valeurs par défaut`,
    parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"}: ${i.message}`),
  );
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
