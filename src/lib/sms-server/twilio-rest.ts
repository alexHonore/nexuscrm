import "server-only";

/**
 * Authentification REST Twilio en LECTURE — même résolution d'environnement
 * que le transport d'envoi (getSmsProvider) : clé API dédiée aux SMS si
 * présente (paire complète), sinon la clé voix. null si la configuration est
 * incomplète — la réconciliation se désarme alors toute seule, exactement
 * comme le transport retombe en dry_run.
 */

export interface TwilioRestAuth {
  accountSid: string;
  keySid: string;
  keySecret: string;
}

export function getTwilioRestAuth(
  env: Record<string, string | undefined> = process.env,
): TwilioRestAuth | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const smsKeySid = env.TWILIO_SMS_API_KEY_SID;
  const smsKeySecret = env.TWILIO_SMS_API_KEY_SECRET;
  const hasSmsKey = Boolean(smsKeySid && smsKeySecret);
  const keySid = hasSmsKey ? smsKeySid : env.TWILIO_API_KEY_SID;
  const keySecret = hasSmsKey ? smsKeySecret : env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !keySid || !keySecret) return null;
  return { accountSid, keySid, keySecret };
}

/** En-tête Basic pour l'API Twilio (clé API, jamais le jeton maître). */
export function twilioBasicAuth(auth: TwilioRestAuth): string {
  return `Basic ${btoa(`${auth.keySid}:${auth.keySecret}`)}`;
}
