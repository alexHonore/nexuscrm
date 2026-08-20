/**
 * Câblage serveur du moteur SMS — LE SEUL endroit où l'environnement et
 * Drizzle rencontrent la lib pure `src/lib/sms`. Les routes importent d'ici ;
 * la lib, elle, ne connaît que ses ports injectés.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { suppressions } from "@/db/schema-sms";
import { smsSettingsSchema } from "@/lib/settings";
import {
  createSmsProvider,
  createTwilioTransport,
  parseAllowlist,
  resolveSmsMode,
} from "@/lib/sms/provider";
import type { Logger, SendGate, SmsProvider, SmsTransport, SuppressionStore } from "@/lib/sms/types";
import { systemClock } from "@/lib/sms/types";
import { publicWebhookUrl } from "./twilio-signature";

// ── Ports concrets ───────────────────────────────────────────────────────────

/**
 * Suppressions en base — clé = numéro E.164 (survit à la suppression et à la
 * ré-importation du client). Rien n'est jamais envoyé à un numéro présent ici.
 */
export const drizzleSuppressionStore: SuppressionStore = {
  async isSuppressed(phoneE164) {
    const rows = await db
      .select({ phone: suppressions.phoneE164 })
      .from(suppressions)
      .where(eq(suppressions.phoneE164, phoneE164))
      .limit(1);
    return rows.length > 0;
  },
  async suppress({ phoneE164, reason, note }) {
    // onConflictDoNothing : la première raison consignée reste la bonne.
    await db
      .insert(suppressions)
      .values({ phoneE164, reason, note: note ?? null })
      .onConflictDoNothing();
  },
};

/**
 * Interrupteur d'arrêt global (`sms.killSwitch`) — relu en base avant CHAQUE
 * envoi : le basculer stoppe tout SMS sortant sans redéploiement.
 *
 * Contrairement à getSetting() (qui retombe sur les défauts quand la rangée
 * est invalide — le bon réflexe pour des réglages ordinaires), l'interrupteur
 * échoue FERMÉ : une rangée `sms` illisible bloque les envois au lieu de
 * désarmer silencieusement le seul garde-fou global. Rangée absente = état
 * initial normal = envois permis.
 */
export const settingsSendGate: SendGate = {
  async isSendingAllowed() {
    const row = await db.query.settings.findFirst({ where: eq(settings.key, "sms") });
    if (!row) return true;
    const parsed = smsSettingsSchema.safeParse(row.value);
    if (!parsed.success) {
      jsonLogger.error("sms.gate.unparseable_settings", { key: "sms" });
      return false;
    }
    return !parsed.data.killSwitch;
  },
};

function logLine(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

/** Une ligne JSON par évènement — greppable dans les journaux Vercel. */
export const jsonLogger: Logger = {
  info: (msg, data) => logLine("info", msg, data),
  warn: (msg, data) => logLine("warn", msg, data),
  error: (msg, data) => logLine("error", msg, data),
};

// ── Assemblage ───────────────────────────────────────────────────────────────

/**
 * Fournisseur SMS assemblé depuis l'environnement. Fermé par défaut : mode
 * résolu par `resolveSmsMode` (dry_run sauf drapeaux explicites), et si la
 * configuration Twilio est incomplète alors que le mode voudrait envoyer, on
 * retombe en dry_run avec un avertissement — jamais d'exception à l'import.
 */
export function getSmsProvider(): SmsProvider {
  const env = process.env;
  let mode = resolveSmsMode(env);

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;
  // Clé API dédiée aux SMS si présente (paire complète), sinon la clé voix.
  const smsKeySid = env.TWILIO_SMS_API_KEY_SID;
  const smsKeySecret = env.TWILIO_SMS_API_KEY_SECRET;
  const hasSmsKey = Boolean(smsKeySid && smsKeySecret);
  const keySid = hasSmsKey ? smsKeySid : env.TWILIO_API_KEY_SID;
  const keySecret = hasSmsKey ? smsKeySecret : env.TWILIO_API_KEY_SECRET;

  let transport: SmsTransport;
  if (accountSid && keySid && keySecret && messagingServiceSid) {
    const statusCallback = publicWebhookUrl("/api/webhooks/twilio/status");
    transport = createTwilioTransport({
      accountSid,
      keySid,
      keySecret,
      messagingServiceSid,
      // Sans NEXT_PUBLIC_APP_URL l'URL serait relative — Twilio la refuserait.
      statusCallbackUrl: statusCallback.startsWith("http") ? statusCallback : undefined,
    });
  } else {
    if (mode !== "dry_run") {
      jsonLogger.warn("sms.config.incomplete", { mode });
      mode = "dry_run";
    }
    // Jamais atteint en dry_run ; filet si un futur chemin contourne le mode.
    transport = async () => {
      throw new Error("twilio_send_failed: transport_unconfigured");
    };
  }

  return createSmsProvider({
    mode,
    allowlist: parseAllowlist(env.TEST_PHONE_ALLOWLIST),
    transport,
    suppressions: drizzleSuppressionStore,
    gate: settingsSendGate,
    logger: jsonLogger,
    clock: systemClock,
  });
}

/**
 * Chemin d'écriture partagé des routes (STOP entrant, erreur transporteur,
 * action admin) vers la liste de suppression.
 */
export async function suppressPhone(phoneE164: string, reason: string, note?: string): Promise<void> {
  await drizzleSuppressionStore.suppress({ phoneE164, reason, note });
}
