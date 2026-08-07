import "server-only";

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
    protocol: 1, // SIP
    auth_type: 1, // user/password
    device_type: 2, // ATA/IP phone/softphone
    lock_international: 1,
    international_route: 1,
    music_on_hold: "default",
    allowed_codecs: "ulaw;g722;g729",
    dtmf_mode: "auto",
    nat: "yes",
    callerid_number: opts.calleridNumber,
  });
}

/** Change le mot de passe SIP (ou le caller ID) d'un sous-compte. */
export async function setSubAccountPassword(id: string, password: string, calleridNumber?: string) {
  // voip.ms exige de renvoyer les champs obligatoires — on lit d'abord le compte.
  const accounts = await getSubAccounts();
  const acc = accounts.find((a) => a.id === id || a.account === id);
  if (!acc) throw new VoipMsError("subaccount_not_found");
  return voipms("setSubAccount", {
    id: acc.id,
    description: acc.description,
    auth_type: 1,
    password,
    protocol: 1,
    device_type: 2,
    lock_international: 1,
    international_route: 1,
    music_on_hold: "default",
    allowed_codecs: "ulaw;g722;g729",
    dtmf_mode: "auto",
    nat: "yes",
    callerid_number: calleridNumber ?? acc.callerid_number,
  });
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

/** CDR du compte principal + sous-comptes. Dates au format YYYY-MM-DD. */
export async function getCdr(dateFrom: string, dateTo: string): Promise<VoipMsCdr[]> {
  const r = await voipms<{ cdr: VoipMsCdr[] }>("getCDR", {
    date_from: dateFrom,
    date_to: dateTo,
    answered: 1,
    noanswer: 1,
    busy: 1,
    failed: 1,
    timezone: -5,
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
