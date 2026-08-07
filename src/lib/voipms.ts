import "server-only";
import { getTimezoneOffset } from "date-fns-tz";

/**
 * Client REST voip.ms (https://voip.ms/m/apidocs.php).
 *
 * L'API voip.ms exige que l'IP appelante soit autorisée (Menu principal → API).
 * En production sur Vercel (IPs dynamiques), on passe par le proxy HTTP de la
 * passerelle vocale (IP fixe) via VOIPMS_API_PROXY_URL.
 */

const DIRECT_URL = "https://voip.ms/api/v1/rest.php";

export class VoipMsError extends Error {
  constructor(
    public status: string,
    message?: string,
  ) {
    super(message ?? `voip.ms API error: ${status}`);
    this.name = "VoipMsError";
  }
}

export async function voipms<T = Record<string, unknown>>(
  method: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const username = process.env.VOIPMS_API_USERNAME;
  const password = process.env.VOIP_MS_API_PASSWORD;
  if (!username || !password) {
    throw new VoipMsError("missing_credentials", "VOIPMS_API_USERNAME / VOIP_MS_API_PASSWORD manquants");
  }

  const qs = new URLSearchParams({
    api_username: username,
    api_password: password,
    method,
    content_type: "json",
  });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== "") qs.set(k, String(v));
  }

  const proxyUrl = process.env.VOIPMS_API_PROXY_URL;
  const url = `${proxyUrl || DIRECT_URL}?${qs.toString()}`;
  const headers: Record<string, string> = {};
  if (proxyUrl && process.env.VOIPMS_API_PROXY_TOKEN) {
    headers["x-proxy-token"] = process.env.VOIPMS_API_PROXY_TOKEN;
  }

  const res = await fetch(url, { headers, cache: "no-store" });
  if (!res.ok) throw new VoipMsError("http_error", `HTTP ${res.status}`);
  const json = (await res.json()) as { status: string } & T;
  if (json.status !== "success") throw new VoipMsError(json.status);
  return json;
}

// ── Aides typées (champs principaux seulement) ──────────────────────────────

export type VoipMsSubAccount = {
  id: string;
  account: string;
  username: string;
  description: string;
  callerid_number?: string;
  /** voip.ms renvoie le mot de passe SIP en clair dans la liste des sous-comptes. */
  password?: string;
};

export async function getSubAccounts(): Promise<VoipMsSubAccount[]> {
  try {
    const r = await voipms<{ accounts: VoipMsSubAccount[] }>("getSubAccounts");
    return r.accounts ?? [];
  } catch (err) {
    // « no_account » = aucun sous-compte créé pour l'instant, pas une erreur.
    if (err instanceof VoipMsError && err.status === "no_account") return [];
    throw err;
  }
}

/**
 * Profil commun des sous-comptes (création ET réécriture — voip.ms exige de
 * renvoyer tous les champs obligatoires à chaque setSubAccount).
 * record_calls: enregistrement des appels côté voip.ms pour révision par
 * l'admin ; si la fonctionnalité n'est pas active sur le compte principal,
 * voip.ms ignore simplement le paramètre.
 */
const SUBACCOUNT_PROFILE = {
  protocol: 1, // SIP
  auth_type: 1, // user/password
  device_type: 2, // ATA/IP phone/softphone
  lock_international: 1,
  international_route: 1,
  music_on_hold: "default",
  allowed_codecs: "ulaw;g722;g729",
  dtmf_mode: "auto",
  nat: "yes",
  record_calls: 1,
} as const;

/** Crée un sous-compte SIP (un par téléphoniste). */
export async function createSubAccount(opts: {
  username: string;
  password: string;
  description: string;
  calleridNumber?: string;
}) {
  return voipms("createSubAccount", {
    username: opts.username,
    password: opts.password,
    description: opts.description,
    ...SUBACCOUNT_PROFILE,
    callerid_number: opts.calleridNumber,
  });
}

/** Réécrit un sous-compte avec le profil commun (voip.ms exige tous les champs). */
async function rewriteSubAccount(
  acc: VoipMsSubAccount,
  overrides: { password: string; calleridNumber?: string },
) {
  return voipms("setSubAccount", {
    id: acc.id,
    description: acc.description,
    password: overrides.password,
    ...SUBACCOUNT_PROFILE,
    callerid_number: overrides.calleridNumber ?? acc.callerid_number,
  });
}

/** Change le mot de passe SIP (ou le caller ID) d'un sous-compte. */
export async function setSubAccountPassword(id: string, password: string, calleridNumber?: string) {
  // voip.ms exige de renvoyer les champs obligatoires — on lit d'abord le compte.
  const accounts = await getSubAccounts();
  const acc = accounts.find((a) => a.id === id || a.account === id);
  if (!acc) throw new VoipMsError("subaccount_not_found");
  return rewriteSubAccount(acc, { password, calleridNumber });
}

/**
 * Met à jour le caller ID d'un sous-compte SANS changer son mot de passe
 * (réutilise le mot de passe en clair que voip.ms renvoie dans la liste).
 * À appeler quand on attribue un DID après la création du sous-compte —
 * sinon les appels sortants partent sans numéro présenté valide.
 */
export async function updateSubAccountCallerId(account: string, calleridNumber: string) {
  const accounts = await getSubAccounts();
  const acc = accounts.find((a) => a.id === account || a.account === account);
  if (!acc) throw new VoipMsError("subaccount_not_found");
  if (!acc.password) throw new VoipMsError("password_unavailable");
  return rewriteSubAccount(acc, { password: acc.password, calleridNumber });
}

export type VoipMsDid = {
  did: string;
  description: string;
  routing: string;
  pop: string;
  state: string;
};

export async function getDids(): Promise<VoipMsDid[]> {
  const r = await voipms<{ dids: VoipMsDid[] }>("getDIDsInfo");
  return r.dids ?? [];
}

/** Route un DID vers un sous-compte ("account:username"). */
export async function routeDidToSubAccount(did: string, subAccount: string) {
  return voipms("setDIDRouting", { did: did.replace(/\D/g, ""), routing: `account:${subAccount}` });
}

export type VoipMsCdr = {
  date: string;
  callerid: string;
  destination: string;
  description: string;
  account: string;
  disposition: string;
  duration: string;
  seconds: string;
  uniqueid: string;
};

/**
 * Décalage UTC (heures entières) de Toronto à la date donnée : -4 en été
 * (EDT), -5 en hiver (EST). Utilisé pour demander les CDR dans le bon fuseau
 * ET ré-interpréter leurs dates — un décalage figé à -5 fausse d'une heure
 * tous les horodatages d'été et casse le rapprochement avec `calls`.
 */
export function torontoUtcOffsetHours(dateStr: string): number {
  return Math.round(
    getTimezoneOffset("America/Toronto", new Date(`${dateStr}T12:00:00Z`)) / 3_600_000,
  );
}

/** « -4 » → « -04:00 » (suffixe ISO pour ré-interpréter une date CDR). */
export function utcOffsetSuffix(offsetHours: number): string {
  const sign = offsetHours < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;
}

/** CDR du compte principal + sous-comptes. Dates au format YYYY-MM-DD (Toronto). */
export async function getCdr(dateFrom: string, dateTo: string): Promise<VoipMsCdr[]> {
  const r = await voipms<{ cdr: VoipMsCdr[] }>("getCDR", {
    date_from: dateFrom,
    date_to: dateTo,
    answered: 1,
    noanswer: 1,
    busy: 1,
    failed: 1,
    timezone: torontoUtcOffsetHours(dateFrom),
  });
  return r.cdr ?? [];
}

export type VoipMsRecording = {
  id?: string;
  callrecording?: string;
  date?: string;
  url?: string;
  [k: string]: unknown;
};

/** Enregistrements d'appels (la fonctionnalité "Call Recording" doit être activée sur le compte). */
export async function getCallRecordings(dateFrom: string, dateTo: string): Promise<VoipMsRecording[]> {
  const r = await voipms<{ call_recordings?: VoipMsRecording[]; recordings?: VoipMsRecording[] }>(
    "getCallRecordings",
    { date_from: dateFrom, date_to: dateTo },
  );
  return r.call_recordings ?? r.recordings ?? [];
}

/**
 * URL de lecture d'un enregistrement, quel que soit le nom de champ utilisé
 * par voip.ms (url, recording_url, file, link…) : première valeur http(s).
 */
export function extractRecordingUrl(rec: VoipMsRecording): string | undefined {
  if (typeof rec.url === "string" && /^https?:\/\//i.test(rec.url)) return rec.url;
  for (const value of Object.values(rec)) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  }
  return undefined;
}
