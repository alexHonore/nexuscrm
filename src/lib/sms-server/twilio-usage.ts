import "server-only";
import { jsonLogger } from "./index";

/**
 * Coût SMS RÉEL depuis Twilio (API Usage Records).
 *
 * Twilio facture les SMS et l'expose : `GET /2010-04-01/Accounts/{sid}/Usage/
 * Records.json?Category=sms&StartDate=…&EndDate=…` renvoie le prix TOTAL de la
 * période (entrants + sortants confondus). On préfère toujours ce chiffre à
 * l'estimation par segments — c'est la vraie dépense.
 *
 * Retour `null` quand Twilio n'est pas configuré ou injoignable : l'appelant
 * retombe alors sur l'estimation (segments × tarif documenté).
 */

const TWILIO_TIMEOUT_MS = 12_000;

export type TwilioSmsCost = { costUsd: number; priceUnit: string };

/** Identifiants Twilio résolus comme pour l'envoi (clé SMS dédiée, sinon voix). */
function twilioCreds(env: Record<string, string | undefined> = process.env) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const hasSmsKey = Boolean(env.TWILIO_SMS_API_KEY_SID && env.TWILIO_SMS_API_KEY_SECRET);
  const keySid = hasSmsKey ? env.TWILIO_SMS_API_KEY_SID : env.TWILIO_API_KEY_SID;
  const keySecret = hasSmsKey ? env.TWILIO_SMS_API_KEY_SECRET : env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !keySid || !keySecret) return null;
  return { accountSid, keySid, keySecret };
}

/**
 * Dépense SMS réelle sur [from, to] (dates YYYY-MM-DD, inclusives). Les bornes
 * suivent le fuseau du compte Twilio — un léger décalage avec le jour Toronto
 * de l'app, mais c'est le montant RÉELLEMENT facturé pour ces dates.
 */
export async function getTwilioSmsCost(
  from: string,
  to: string,
  env: Record<string, string | undefined> = process.env,
): Promise<TwilioSmsCost | null> {
  const creds = twilioCreds(env);
  if (!creds) return null;

  const url =
    `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Usage/Records.json` +
    `?Category=sms&StartDate=${from}&EndDate=${to}&PageSize=1`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${btoa(`${creds.keySid}:${creds.keySecret}`)}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    if (!res.ok) {
      jsonLogger.warn("consumption.twilio.http", { status: res.status });
      return null;
    }
    const json = (await res.json()) as {
      usage_records?: { price?: unknown; price_unit?: unknown }[];
    };
    const record = json.usage_records?.[0];
    if (!record) return null;
    const price = Number(record.price ?? NaN);
    if (!Number.isFinite(price)) return null;
    // Le prix est le coût facturé ; Twilio le rend positif, on borne au cas où.
    return {
      costUsd: Math.abs(price),
      priceUnit: typeof record.price_unit === "string" ? record.price_unit : "usd",
    };
  } catch (err) {
    jsonLogger.warn("consumption.twilio.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
