import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { smsNumbers } from "@/db/schema-sms";
import { jsonLogger } from "@/lib/sms-server";
import type {
  Probe,
  TwilioA2pProbe,
  TwilioAccountProbe,
  TwilioAlertsProbe,
  TwilioProbes,
  TwilioSenderPoolProbe,
  TwilioServiceProbe,
} from "@/lib/deliverability/types";

/**
 * Ce que Twilio sait et que la base ne sait pas.
 *
 * Cinq sondes indépendantes, et la règle qui les gouverne : **une sonde ne
 * lève JAMAIS.** Elle rend son état. Le balayage RBAC de la suite de tests
 * remplace `fetch` par une fonction qui lève à tous les coups et exige qu'un
 * administrateur reçoive un 200 — mais c'est surtout le bon comportement en
 * production : une clé API à portée restreinte ne doit pas vider l'écran de
 * ses chiffres de base de données, qui eux sont complets.
 *
 * QUATRE états, jamais deux (`Probe<T>`), parce que quatre gestes différents
 * s'y cachent :
 *  · `unconfigured` — il manque une variable d'environnement. On peut la poser.
 *  · `unavailable` — Twilio n'a pas répondu, ou a refusé la portée de la clé.
 *  · `absent` — Twilio a répondu « ça n'existe pas ». Pour un envoi
 *    Canada→Canada, l'absence de campagne A2P est la situation NORMALE, et la
 *    peindre en gris « indisponible » apprend à ignorer le gris.
 *  · `ok` — la donnée.
 */

const TIMEOUT_MS = 10_000;

interface Creds {
  accountSid: string;
  keySid: string;
  keySecret: string;
}

/** Même résolution de clé que le transport d'envoi : la paire SMS, sinon la voix. */
function creds(env: Record<string, string | undefined> = process.env): Creds | null {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const hasSmsKey = Boolean(env.TWILIO_SMS_API_KEY_SID && env.TWILIO_SMS_API_KEY_SECRET);
  const keySid = hasSmsKey ? env.TWILIO_SMS_API_KEY_SID : env.TWILIO_API_KEY_SID;
  const keySecret = hasSmsKey ? env.TWILIO_SMS_API_KEY_SECRET : env.TWILIO_API_KEY_SECRET;
  if (!accountSid || !keySid || !keySecret) return null;
  return { accountSid, keySid, keySecret };
}

function missingVars(env: Record<string, string | undefined> = process.env): string[] {
  const missing: string[] = [];
  if (!env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
  const hasSmsKey = Boolean(env.TWILIO_SMS_API_KEY_SID && env.TWILIO_SMS_API_KEY_SECRET);
  if (!hasSmsKey && !(env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET)) {
    missing.push("TWILIO_SMS_API_KEY_SID / TWILIO_SMS_API_KEY_SECRET");
  }
  return missing;
}

/**
 * Un appel REST, dont l'échec est une VALEUR.
 *
 * 401/403 sort en `scope` et non en `http` : une clé Twilio « restreinte » qui
 * n'emporte pas Monitor ou TrustHub échoue exactement comme ça, c'est la panne
 * la plus déroutante de la page, et elle mérite d'être nommée.
 */
async function probe<T>(
  url: string,
  auth: Creds,
  map: (json: unknown) => T | null,
  fetchFn: typeof fetch,
  label: string,
): Promise<Probe<T>> {
  try {
    const res = await fetchFn(url, {
      headers: { Authorization: `Basic ${btoa(`${auth.keySid}:${auth.keySecret}`)}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { state: "absent" };
    if (res.status === 401 || res.status === 403) {
      return { state: "unavailable", reason: "scope", status: res.status };
    }
    if (!res.ok) {
      jsonLogger.warn("deliverability.twilio.http", { label, status: res.status });
      return { state: "unavailable", reason: "http", status: res.status };
    }
    const json: unknown = await res.json();
    const data = map(json);
    if (data === null) return { state: "unavailable", reason: "parse" };
    return { state: "ok", data };
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    jsonLogger.warn("deliverability.twilio.failed", {
      label,
      error: err instanceof Error ? err.message : String(err),
    });
    return { state: "unavailable", reason: timeout ? "timeout" : "http" };
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean => v === true;

export async function collectTwilioProbes(
  fetchFn: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<TwilioProbes> {
  const crmNumbers = await db
    .select({ e164: smsNumbers.e164 })
    .from(smsNumbers)
    .where(eq(smsNumbers.active, true))
    .then((rows) => rows.map((r) => r.e164))
    .catch(() => [] as string[]);

  const auth = creds(env);
  if (!auth) {
    const missing = missingVars(env);
    const unconfigured = { state: "unconfigured" as const, missing };
    return {
      account: unconfigured,
      service: unconfigured,
      senderPool: unconfigured,
      a2p: unconfigured,
      alerts: unconfigured,
      crmNumbers,
    };
  }

  const serviceSid = env.TWILIO_MESSAGING_SERVICE_SID;
  const serviceMissing: Probe<never> = {
    state: "unconfigured",
    missing: ["TWILIO_MESSAGING_SERVICE_SID"],
  };

  // Trente jours d'alertes : c'est la rétention de Twilio, demander plus loin
  // rend une liste vide qu'on lirait à tort comme « aucune erreur ».
  const alertsFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [account, service, senderPool, a2p, alerts] = await Promise.all([
    probe<TwilioAccountProbe>(
      `https://api.twilio.com/2010-04-01/Accounts/${auth.accountSid}.json`,
      auth,
      (json) => {
        const o = json as Record<string, unknown>;
        const status = str(o.status);
        return status === null ? null : { status, friendlyName: str(o.friendly_name) ?? "" };
      },
      fetchFn,
      "account",
    ),
    serviceSid
      ? probe<TwilioServiceProbe>(
          `https://messaging.twilio.com/v1/Services/${serviceSid}`,
          auth,
          (json) => {
            const o = json as Record<string, unknown>;
            const sid = str(o.sid);
            if (sid === null) return null;
            return {
              sid,
              friendlyName: str(o.friendly_name) ?? "",
              smartEncoding: bool(o.smart_encoding),
              stickySender: bool(o.sticky_sender),
              validityPeriod: typeof o.validity_period === "number" ? o.validity_period : null,
              statusCallback: str(o.status_callback),
              useCase: str(o.use_case),
            };
          },
          fetchFn,
          "service",
        )
      : Promise.resolve(serviceMissing as Probe<TwilioServiceProbe>),
    serviceSid
      ? probe<TwilioSenderPoolProbe>(
          `https://messaging.twilio.com/v1/Services/${serviceSid}/PhoneNumbers?PageSize=100`,
          auth,
          (json) => {
            const o = json as { phone_numbers?: unknown };
            if (!Array.isArray(o.phone_numbers)) return null;
            const numbers = o.phone_numbers
              .map((n) => str((n as Record<string, unknown>).phone_number))
              .filter((n): n is string => n !== null);
            return { numbers };
          },
          fetchFn,
          "senderPool",
        )
      : Promise.resolve(serviceMissing as Probe<TwilioSenderPoolProbe>),
    serviceSid
      ? probe<TwilioA2pProbe>(
          `https://messaging.twilio.com/v1/Services/${serviceSid}/Compliance/Usa2p`,
          auth,
          (json) => {
            const o = json as Record<string, unknown>;
            const campaignStatus = str(o.campaign_status);
            if (campaignStatus === null) return null;
            const raw = Array.isArray(o.errors) ? o.errors : [];
            return {
              campaignStatus,
              usAppToPersonUsecase: str(o.us_app_to_person_usecase),
              errors: raw.map((e) => {
                const entry = e as Record<string, unknown>;
                return {
                  code: typeof entry.error_code === "number" ? entry.error_code : null,
                  description: str(entry.description) ?? "",
                };
              }),
            };
          },
          fetchFn,
          "a2p",
        )
      : Promise.resolve(serviceMissing as Probe<TwilioA2pProbe>),
    probe<TwilioAlertsProbe>(
      `https://monitor.twilio.com/v1/Alerts?LogLevel=error&StartDate=${alertsFrom}&PageSize=50`,
      auth,
      (json) => {
        const o = json as { alerts?: unknown };
        if (!Array.isArray(o.alerts)) return null;
        const byCode = new Map<string, { count: number; mostRecent: string }>();
        for (const raw of o.alerts) {
          const entry = raw as Record<string, unknown>;
          const code = str(entry.error_code) ?? "?";
          const at = str(entry.date_created) ?? "";
          const current = byCode.get(code);
          if (current) {
            current.count += 1;
            if (at > current.mostRecent) current.mostRecent = at;
          } else {
            byCode.set(code, { count: 1, mostRecent: at });
          }
        }
        return {
          errors: [...byCode.entries()]
            .map(([code, v]) => ({ code, ...v }))
            .sort((a, b) => b.count - a.count),
        };
      },
      fetchFn,
      "alerts",
    ),
  ]);

  return { account, service, senderPool, a2p, alerts, crmNumbers };
}
