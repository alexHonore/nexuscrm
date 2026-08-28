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
 * Dépense SMS réelle sur [from, to] (dates YYYY-MM-DD, inclusives).
 *
 * ⚠️ Les journées de Twilio sont bornées en **GMT**, pas au fuseau du compte et
 * surtout pas à Toronto : une journée Twilio se termine vers 20 h heure de
 * Toronto. Le montant reste celui RÉELLEMENT facturé pour ces dates, mais il ne
 * se juxtapose pas au jour près avec nos agrégats Toronto — l'écran doit le
 * dire plutôt que de laisser croire à des bornes identiques.
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

// ── Solde du compte ──────────────────────────────────────────────────────────

/**
 * Solde du compte Twilio — le chiffre du FOURNISSEUR, l'ancre de la dépense
 * SMS, exactement comme `/credits` l'est pour OpenRouter et `getBalance` pour
 * voip.ms.
 *
 * Deux pièges portés par le type :
 *
 *  · Le solde peut être **négatif** (compte à découvert, ou compte facturé à
 *    terme). On ne prend surtout pas la valeur absolue comme le fait le coût
 *    plus haut : ici le signe EST l'information.
 *  · C'est un solde **réglé**, pas un porte-monnaie temps réel. La
 *    consommation est débitée avec du retard (minutes à heures, davantage pour
 *    les frais de transporteur). L'écran l'annonce comme approximatif.
 */
export type TwilioBalance = {
  /** Le solde tel quel, signe compris ($ US en pratique — voir `currency`). */
  balanceUsd: number;
  /** ISO-4217 tel que Twilio l'écrit sur cette ressource : MAJUSCULES (« USD »). */
  currency: string;
  /** Quels identifiants ont répondu — utile quand seule la clé maîtresse passe. */
  authKind: "apiKey" | "authToken";
};

/**
 * Les identifiants à essayer pour le solde, dans l'ordre.
 *
 * La clé API d'abord : c'est celle que tout le reste du module utilise, et
 * c'est le secret le moins privilégié. Twilio ne documente PAS si
 * `Balance.json` est lisible par une clé « Standard » (la ressource vit sous
 * `/Accounts/{Sid}/`, que la documentation exclut pour ce niveau de clé) — donc
 * on ne parie pas : un 401/403 déclenche UN seul essai avec le jeton maître,
 * déjà présent dans l'environnement pour vérifier les signatures de webhooks.
 * Si les deux échouent, la tuile affiche « indisponible » — jamais 0 $.
 */
function balanceAttempts(env: Record<string, string | undefined>) {
  const creds = twilioCreds(env);
  const accountSid = creds?.accountSid ?? env.TWILIO_ACCOUNT_SID;
  if (!accountSid) return null;

  const attempts: { kind: "apiKey" | "authToken"; header: string }[] = [];
  if (creds) {
    attempts.push({
      kind: "apiKey",
      header: `Basic ${btoa(`${creds.keySid}:${creds.keySecret}`)}`,
    });
  }
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (authToken) {
    attempts.push({
      kind: "authToken",
      header: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
    });
  }
  if (attempts.length === 0) return null;
  // Volontairement SANS mémoire du gagnant : un cache de processus ferait
  // dépendre le résultat de l'ordre des appels (et des tests), pour épargner
  // un seul 401 sur une page que seul l'administrateur ouvre.
  return { accountSid, attempts };
}

/** Solde du compte Twilio, ou `null` si non configuré / injoignable / refusé. */
export async function getTwilioBalance(
  env: Record<string, string | undefined> = process.env,
): Promise<TwilioBalance | null> {
  const resolved = balanceAttempts(env);
  if (!resolved) return null;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${resolved.accountSid}/Balance.json`;

  for (const attempt of resolved.attempts) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: attempt.header },
        cache: "no-store",
        signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      });
      if (!res.ok) {
        jsonLogger.warn("consumption.twilio.balance.http", {
          status: res.status,
          auth: attempt.kind,
        });
        // 401/403 : c'est peut-être seulement CES identifiants — on essaie les suivants.
        if (res.status === 401 || res.status === 403) continue;
        return null;
      }
      const json = (await res.json()) as { balance?: unknown; currency?: unknown };
      const balance = Number(json.balance ?? NaN);
      if (!Number.isFinite(balance)) return null;
      return {
        balanceUsd: balance,
        currency: typeof json.currency === "string" ? json.currency.toUpperCase() : "USD",
        authKind: attempt.kind,
      };
    } catch (err) {
      jsonLogger.warn("consumption.twilio.balance.failed", {
        auth: attempt.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return null;
}

// ── Dépense jour par jour ────────────────────────────────────────────────────

/**
 * Une journée de facturation Twilio.
 *
 * `date` est le jour **GMT** de Twilio (`start_date` === `end_date` sur cette
 * ressource), pas un jour Toronto : un SMS envoyé en soirée à Montréal tombe
 * sur la journée SUIVANTE. Le graphique le dit sous les colonnes plutôt que de
 * laisser croire à des bornes communes.
 */
export type TwilioDailyUsage = {
  date: string;
  /** Prix facturé pour cette journée, toutes catégories demandées confondues. */
  costUsd: number;
  /** Messages comptés par Twilio (la catégorie « frais » n'en compte aucun). */
  messages: number;
};

/**
 * Les catégories qui composent la dépense SMS réelle.
 *
 * `sms` N'INCLUT PAS les frais de transporteur : sur du trafic 10DLC ils sont
 * une ligne à part. Les demander toutes les deux est la seule façon de ne pas
 * sous-déclarer — et elles restent séparées côté appelant, pour qu'un montant
 * qu'on ne mesurait pas hier n'apparaisse pas fondu dans un total sans le dire.
 */
export const TWILIO_SMS_CATEGORIES = ["sms", "sms-messages-carrierfees"] as const;
export type TwilioSmsCategory = (typeof TWILIO_SMS_CATEGORIES)[number];

/** Une page de 100 couvre 31 jours ; la borne de pages est un garde-fou, pas une pagination réelle. */
const TWILIO_DAILY_PAGE_SIZE = 100;
const TWILIO_MAX_PAGES = 5;

/**
 * Dépense Twilio jour par jour pour UNE catégorie, sur [from, to].
 *
 * Twilio omet purement et simplement les journées sans consommation : c'est à
 * l'appelant de remplir les trous à 0 pour que l'axe du temps reste continu.
 * `null` = indisponible (non configuré, HTTP, réseau) — jamais un tableau vide,
 * qui se lirait comme « aucune dépense ».
 */
export async function getTwilioDailySmsUsage(
  from: string,
  to: string,
  category: TwilioSmsCategory = "sms",
  env: Record<string, string | undefined> = process.env,
): Promise<TwilioDailyUsage[] | null> {
  const creds = twilioCreds(env);
  if (!creds) return null;

  const header = `Basic ${btoa(`${creds.keySid}:${creds.keySecret}`)}`;
  const rows: TwilioDailyUsage[] = [];
  let next: string | null =
    `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Usage/Records/Daily.json` +
    `?Category=${category}&StartDate=${from}&EndDate=${to}` +
    `&PageSize=${TWILIO_DAILY_PAGE_SIZE}&IncludeSubaccounts=true`;

  try {
    for (let page = 0; next && page < TWILIO_MAX_PAGES; page += 1) {
      const res: Response = await fetch(next, {
        headers: { Authorization: header },
        cache: "no-store",
        signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
      });
      if (!res.ok) {
        jsonLogger.warn("consumption.twilio.daily.http", { status: res.status, category });
        return null;
      }
      const json = (await res.json()) as {
        usage_records?: { start_date?: unknown; price?: unknown; count?: unknown }[];
        next_page_uri?: unknown;
      };
      for (const record of json.usage_records ?? []) {
        const date = typeof record.start_date === "string" ? record.start_date.slice(0, 10) : "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const price = Number(record.price ?? NaN);
        const count = Number(record.count ?? NaN);
        rows.push({
          // Twilio rend le prix positif ; on borne au cas où, une DÉPENSE négative
          // n'aurait pas de sens dans une pile de coûts (le SOLDE, lui, garde son signe).
          costUsd: Number.isFinite(price) ? Math.abs(price) : 0,
          messages: Number.isFinite(count) ? count : 0,
          date,
        });
      }
      const uri = json.next_page_uri;
      next = typeof uri === "string" && uri ? `https://api.twilio.com${uri}` : null;
    }
    // Le garde-fou de pages a mordu : la série serait TRONQUÉE. Une série
    // incomplète rendue comme complète manquerait de la dépense sans le dire —
    // « indisponible » est la seule réponse honnête.
    if (next) {
      jsonLogger.warn("consumption.twilio.daily.truncated", { category });
      return null;
    }
    return rows;
  } catch (err) {
    jsonLogger.warn("consumption.twilio.daily.failed", {
      category,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
