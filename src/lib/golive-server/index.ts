import "server-only";
import { and, eq, isNull, gte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistants, campaigns, consents, smsNumbers } from "@/db/schema-sms";
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

  const [numbers, consented, assistantRows, campaignRows] = await Promise.all([
    db
      .select({
        active: sql<number>`(count(*) filter (where ${smsNumbers.active}))::int`,
        withoutService: sql<number>`(count(*) filter (where ${smsNumbers.active} and ${smsNumbers.messagingServiceSid} = ''))::int`,
      })
      .from(smsNumbers),
    db
      .select({ n: sql<number>`count(distinct ${consents.clientId})::int` })
      .from(consents)
      .where(
        and(
          eq(consents.channel, "sms"),
          isNull(consents.revokedAt),
          or(isNull(consents.expiresAt), gte(consents.expiresAt, now))!,
        ),
      ),
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

  const facts: PreflightFacts = {
    mode: resolveSmsMode(process.env),
    rawMode: process.env.SMS_MODE,
    liveConfirmed: process.env.SMS_LIVE_CONFIRMED === "true",
    killSwitch: smsSettings?.killSwitch ?? false,
    killSwitchReason: smsSettings?.killSwitchReason ?? null,
    hasTwilioCredentials: Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
        (process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_API_KEY_SECRET),
    ),
    hasWebhookSignatureSecret: Boolean(process.env.TWILIO_AUTH_TOKEN),
    activeNumberCount: numbers[0]?.active ?? 0,
    numbersWithoutMessagingService: numbers[0]?.withoutService ?? 0,
    consentValidity: smsSettings?.consentValidity ?? "unlimited",
    consentedClientCount: consented[0]?.n ?? 0,
    quietHoursLabel: `${DEFAULT_QUIET_HOURS.weekday[0]}h-${DEFAULT_QUIET_HOURS.weekday[1]}h`,
    activeAssistantCount: assistantRows[0]?.active ?? 0,
    activeAssistantsWithRedSuite: assistantRows[0]?.redSuite ?? 0,
    activeCampaignCount: campaignRows[0]?.active ?? 0,
    lastDispatchAt: smsSettings?.lastDispatchAt ? new Date(smsSettings.lastDispatchAt) : null,
    now,
    llmProvidersConfigured: configuredProviders(),
  };

  return preflight(facts);
}
