import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistants, smsNumbers } from "@/db/schema-sms";

/**
 * Numéros SMS — lecture pour l'écran d'administration, et synchronisation
 * depuis le Messaging Service Twilio.
 *
 * Jusqu'ici `sms_numbers` ne s'écrivait que par le webhook entrant (auto-
 * enregistrement) ou à la main en SQL : l'administrateur n'avait aucun écran
 * pour enregistrer le numéro d'envoi, le nommer, fixer son plafond, l'activer
 * ou lui confier un assistant par défaut.
 */

export interface AdminSmsNumber {
  id: string;
  e164: string;
  label: string | null;
  messagingServiceSid: string;
  dailyCap: number;
  active: boolean;
  defaultAssistantId: string | null;
  /** Combien de fils pointent vers ce numéro — un numéro utilisé ne se supprime pas. */
  conversationCount: number;
}

export interface AdminSmsNumbersView {
  numbers: AdminSmsNumber[];
  assistants: { id: string; name: string; status: string }[];
}

export async function listSmsNumbersForAdmin(): Promise<AdminSmsNumbersView> {
  const [rows, assistantRows] = await Promise.all([
    db
      .select({
        id: smsNumbers.id,
        e164: smsNumbers.e164,
        label: smsNumbers.label,
        messagingServiceSid: smsNumbers.messagingServiceSid,
        dailyCap: smsNumbers.dailyCap,
        active: smsNumbers.active,
        defaultAssistantId: smsNumbers.defaultAssistantId,
        // Sous-requête corrélée en SQL brut, qualificateur EXPLICITE : dans la
        // liste des champs d'un select, drizzle rend `${smsNumbers.id}` comme
        // « "id" » tout court, que la sous-requête résout sur SA table — le
        // compte était toujours 0.
        conversationCount: sql<number>`(select count(*)::int from conversations c where c.sms_number_id = sms_numbers.id)`,
      })
      .from(smsNumbers)
      .orderBy(asc(smsNumbers.createdAt)),
    db
      .select({ id: assistants.id, name: assistants.name, status: assistants.status })
      .from(assistants)
      .where(eq(assistants.status, "active"))
      .orderBy(asc(assistants.name)),
  ]);
  return { numbers: rows, assistants: assistantRows };
}

/**
 * Les numéros rattachés au Messaging Service Twilio configuré — lecture seule.
 * Même choix de clé que le transport d'envoi : la paire SMS si elle est
 * complète, sinon la clé voix.
 */
export async function fetchTwilioServiceNumbers(
  fetchFn: typeof fetch = fetch,
): Promise<{ phoneNumber: string; sid: string }[]> {
  const env = process.env;
  const serviceSid = env.TWILIO_MESSAGING_SERVICE_SID;
  const hasSmsKey = Boolean(env.TWILIO_SMS_API_KEY_SID && env.TWILIO_SMS_API_KEY_SECRET);
  const keySid = hasSmsKey ? env.TWILIO_SMS_API_KEY_SID : env.TWILIO_API_KEY_SID;
  const keySecret = hasSmsKey ? env.TWILIO_SMS_API_KEY_SECRET : env.TWILIO_API_KEY_SECRET;
  if (!serviceSid || !keySid || !keySecret) throw new Error("twilio_unconfigured");

  const res = await fetchFn(
    `https://messaging.twilio.com/v1/Services/${serviceSid}/PhoneNumbers?PageSize=100`,
    {
      headers: { Authorization: `Basic ${btoa(`${keySid}:${keySecret}`)}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`twilio_list_failed: http ${res.status}`);
  const json = (await res.json()) as { phone_numbers?: { phone_number?: string; sid?: string }[] };
  return (json.phone_numbers ?? [])
    .filter((n): n is { phone_number: string; sid: string } => typeof n.phone_number === "string" && typeof n.sid === "string")
    .map((n) => ({ phoneNumber: n.phone_number, sid: n.sid }));
}
