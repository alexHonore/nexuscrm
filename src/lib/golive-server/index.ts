import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { assistants, campaigns, smsNumbers } from "@/db/schema-sms";
import { getSetting } from "@/lib/settings";
import { configuredProviders } from "@/lib/llm-server";
import { resolveSmsMode } from "@/lib/sms/provider";
import { DEFAULT_QUIET_HOURS } from "@/lib/sms/quiet-hours";
import { preflight, type PreflightFacts, type PreflightReport } from "@/lib/golive/preflight";

/**
 * Rassemble l'état RÉEL du système et le passe au module pur.
 *
 * Rien n'est déduit d'une variable d'environnement seule : le mode passe par
 * `resolveSmsMode` (la même fonction que le moteur), l'interrupteur par les
 * réglages, et les compteurs par la base. Un contrôle qui lirait autre chose
 * que ce que le moteur lit dirait « prêt » pendant que rien ne part.
 */
export async function collectPreflight(now = new Date()): Promise<PreflightReport> {
  const smsSettings = await getSetting("sms").catch(() => null);
  const quietHours = await getSetting("quietHours").catch(() => DEFAULT_QUIET_HOURS);

  const [numbers, assistantRows, campaignRows] = await Promise.all([
    db
      .select({
        active: sql<number>`(count(*) filter (where ${smsNumbers.active}))::int`,
        withoutService: sql<number>`(count(*) filter (where ${smsNumbers.active} and ${smsNumbers.messagingServiceSid} = ''))::int`,
      })
      .from(smsNumbers),
    db
      .select({
        active: sql<number>`(count(*) filter (where ${assistants.status} = 'active'))::int`,
        redSuite: sql<number>`(count(*) filter (where ${assistants.status} = 'active' and not ${assistants.suitePassed}))::int`,
      })
      .from(assistants),
    db
      .select({ active: sql<number>`(count(*) filter (where ${campaigns.status} = 'active'))::int` })
      .from(campaigns),
  ]);

  // La MÊME exigence que `getSmsProvider` : compte + paire de clé + service de
  // messagerie. Sans les trois, le fournisseur retombe en dry_run.
  const env = process.env;
  const smsKeyPair = Boolean(env.TWILIO_SMS_API_KEY_SID && env.TWILIO_SMS_API_KEY_SECRET);
  const voiceKeyPair = Boolean(env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET);
  const twilioMissing = [
    env.TWILIO_ACCOUNT_SID ? null : "TWILIO_ACCOUNT_SID",
    smsKeyPair || voiceKeyPair ? null : "TWILIO_API_KEY_SID/SECRET",
    env.TWILIO_MESSAGING_SERVICE_SID ? null : "TWILIO_MESSAGING_SERVICE_SID",
  ].filter((v): v is string => v !== null);

  const facts: PreflightFacts = {
    mode: resolveSmsMode(process.env),
    rawMode: process.env.SMS_MODE,
    liveConfirmed: process.env.SMS_LIVE_CONFIRMED === "true",
    killSwitch: smsSettings?.killSwitch ?? false,
    killSwitchReason: smsSettings?.killSwitchReason ?? null,
    hasTwilioCredentials: twilioMissing.length === 0,
    twilioMissing,
    hasWebhookSignatureSecret: Boolean(process.env.TWILIO_AUTH_TOKEN),
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null,
    hasMessagingServiceEnv: Boolean(env.TWILIO_MESSAGING_SERVICE_SID),
    activeNumberCount: numbers[0]?.active ?? 0,
    numbersWithoutMessagingService: numbers[0]?.withoutService ?? 0,
    quietHoursLabel: `${quietHours.weekday[0]}h-${quietHours.weekday[1]}h`,
    activeAssistantCount: assistantRows[0]?.active ?? 0,
    activeAssistantsWithRedSuite: assistantRows[0]?.redSuite ?? 0,
    activeCampaignCount: campaignRows[0]?.active ?? 0,
    lastDispatchAt: smsSettings?.lastDispatchAt ? new Date(smsSettings.lastDispatchAt) : null,
    now,
    llmProvidersConfigured: configuredProviders(),
  };

  return preflight(facts);
}
