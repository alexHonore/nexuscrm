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
 * Réapplique le profil commun à un sous-compte EXISTANT sans toucher au mot de
 * passe (on réutilise celui que voip.ms renvoie en clair dans la liste).
 *
 * C'est ainsi que `record_calls` finit par être activé sur les lignes créées
 * avant l'ajout du paramètre : un sous-compte adopté n'était jamais réécrit,
 * donc l'enregistrement des appels restait désactivé en silence.
 * Sert aussi à faire suivre le caller ID quand on attribue un DID.
 */
export async function applySubAccountProfile(
  acc: VoipMsSubAccount,
  calleridNumber?: string,
) {
  if (!acc.password) throw new VoipMsError("password_unavailable");
  return rewriteSubAccount(acc, { password: acc.password, calleridNumber });
}

/** Variante qui retrouve d'abord le sous-compte par son nom. */
export async function enforceSubAccountProfile(account: string, calleridNumber?: string) {
  const accounts = await getSubAccounts();
  const acc = accounts.find((a) => a.id === account || a.account === account);
  if (!acc) throw new VoipMsError("subaccount_not_found");
  return applySubAccountProfile(acc, calleridNumber);
}

/** @deprecated Utiliser enforceSubAccountProfile — conservé pour la lisibilité des appels. */
export const updateSubAccountCallerId = enforceSubAccountProfile;

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

/**
 * voip.ms veut le DID en 10 chiffres, SANS indicatif de pays : passer la forme
 * E.164 stockée en base (« +15149561693 ») fait échouer l'API avec
 * « invalid_did ». Constaté en production le 2026-08-07 : le routage entrant
 * pointait encore sur le compte principal parce que l'appel échouait.
 */
export function didDigits(did: string): string {
  const digits = did.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** Route un DID vers un sous-compte ("account:username"). */
export async function routeDidToSubAccount(did: string, subAccount: string) {
  return voipms("setDIDRouting", { did: didDigits(did), routing: `account:${subAccount}` });
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

/**
 * Décalage NORMAL (hors heure avancée) de Toronto : −5. Calculé en janvier
 * plutôt qu'écrit en dur, pour rester juste si la règle change.
 *
 * C'est CE décalage qu'attend le paramètre `timezone` de getCDR : voip.ms
 * applique l'heure avancée LUI-MÊME par-dessus la valeur demandée. Mesuré en
 * production le 2026-08-09 — en demandant −4 (EDT), l'API a répondu « 11:37:53 »
 * pour un appel passé à 10:37:52 heure de Toronto, soit UTC−3 : une heure de
 * trop. En demandant −5, elle ajoute l'heure avancée et renvoie l'heure locale
 * réelle, été comme hiver.
 */
export function torontoStandardUtcOffsetHours(): number {
  return torontoUtcOffsetHours("2026-01-15");
}

/** « -4 » → « -04:00 » (suffixe ISO pour ré-interpréter une date CDR). */
export function utcOffsetSuffix(offsetHours: number): string {
  const sign = offsetHours < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;
}

/**
 * CDR du compte principal + sous-comptes. Dates au format YYYY-MM-DD (Toronto).
 * Les horodatages reviennent en heure locale de Toronto (voir
 * `torontoStandardUtcOffsetHours`) ; c'est l'appelant qui les ré-interprète
 * avec le décalage RÉEL de la journée.
 */
export async function getCdr(dateFrom: string, dateTo: string): Promise<VoipMsCdr[]> {
  const r = await voipms<{ cdr: VoipMsCdr[] }>("getCDR", {
    date_from: dateFrom,
    date_to: dateTo,
    answered: 1,
    noanswer: 1,
    busy: 1,
    failed: 1,
    timezone: torontoStandardUtcOffsetHours(),
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

/** voip.ms signale « pas d'enregistrement » par un statut, pas par une liste vide. */
const EMPTY_RECORDING_STATUSES = new Set([
  "no_recordings",
  "no_call_recordings",
  "no_recording",
  "missing_recordings",
]);

/**
 * Enregistrements d'appels d'UN sous-compte.
 *
 * `account` est OBLIGATOIRE : sans lui l'API répond « missing_account » et la
 * synchronisation n'attachait jamais rien (constaté en production le
 * 2026-08-07). La fonctionnalité « Call Recording » doit par ailleurs être
 * active sur le compte voip.ms, sinon l'API renvoie une erreur explicite que
 * l'on laisse remonter telle quelle.
 */
export async function getCallRecordings(
  account: string,
  dateFrom: string,
  dateTo: string,
): Promise<VoipMsRecording[]> {
  try {
    const r = await voipms<{ call_recordings?: VoipMsRecording[]; recordings?: VoipMsRecording[] }>(
      "getCallRecordings",
      { account, date_from: dateFrom, date_to: dateTo },
    );
    return r.call_recordings ?? r.recordings ?? [];
  } catch (err) {
    if (err instanceof VoipMsError && EMPTY_RECORDING_STATUSES.has(err.status)) return [];
    throw err;
  }
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

/** Préfixe des références internes « enregistrement voip.ms à retélécharger ». */
export const VOIPMS_RECORDING_SCHEME = "voipms:";

/**
 * Référence stockée dans `calls.recording_url` quand voip.ms ne donne PAS
 * d'URL directe (cas réel : la liste ne contient qu'un identifiant
 * `callrecording`). Format : `voipms:<compte>:<id>` — l'audio est retéléchargé
 * à la lecture par /api/admin/recordings.
 */
export function recordingRef(account: string, callrecording: string): string {
  return `${VOIPMS_RECORDING_SCHEME}${account}:${callrecording}`;
}

export function parseRecordingRef(
  ref: string,
): { account: string; callrecording: string } | null {
  if (!ref.startsWith(VOIPMS_RECORDING_SCHEME)) return null;
  const rest = ref.slice(VOIPMS_RECORDING_SCHEME.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { account: rest.slice(0, sep), callrecording: rest.slice(sep + 1) };
}

/**
 * Type MIME déduit des octets d'en-tête. voip.ms renvoie du MP3 (en-tête
 * `FF E3` mesuré en production), pas du WAV : annoncer « audio/wav » ferait
 * refuser le flux par les lecteurs stricts et donnerait une mauvaise extension
 * au téléchargement.
 */
export function sniffAudioType(buf: Buffer): string {
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  ) {
    return "audio/wav";
  }
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  // Synchronisation de trame MPEG : 11 bits à 1.
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  return "application/octet-stream";
}

export type VoipMsRecordingFile = Record<string, unknown>;

/** Contenu d'un enregistrement (URL signée ou données base64 selon le compte). */
export async function getCallRecordingFile(
  account: string,
  callrecording: string,
): Promise<VoipMsRecordingFile> {
  return voipms<VoipMsRecordingFile>("getCallRecording", { account, callrecording });
}

/**
 * Extrait l'audio d'une réponse `getCallRecording`, que voip.ms renvoie une
 * URL ou des données base64 (le nom du champ varie selon les comptes).
 * Renvoie aussi les noms de champs vus, pour diagnostiquer sans exposer de
 * données si le format change encore.
 */
export function extractRecordingAudio(
  payload: VoipMsRecordingFile,
): { url: string } | { base64: string } | { fields: string[] } {
  const direct = extractRecordingUrl(payload as VoipMsRecording);
  if (direct) return { url: direct };
  for (const [key, value] of Object.entries(payload)) {
    if (key === "status" || typeof value !== "string" || value.length < 256) continue;
    // Un WAV/MP3 encodé en base64 : long et strictement dans l'alphabet base64.
    if (/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(value)) return { base64: value };
  }
  return { fields: Object.keys(payload) };
}
