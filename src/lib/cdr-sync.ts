import "server-only";
import { and, eq, gte, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { APP_TZ, dayStartUtc } from "@/components/analytics/period";
import { missedCallRows } from "@/components/clients/notification-content";
import { db } from "@/db";
import { calls, clients, users } from "@/db/schema";
import { runAfterResponse } from "@/lib/after-response";
import { overlapsCall, repairCallDuplicates } from "@/lib/cdr-duplicates";
import { createNotifications } from "@/lib/notify";
import { fanoutPush, type PushableRow } from "@/lib/push/fanout";
import { normalizePhone, phoneMatchKey } from "@/lib/phone";
import { kickTranscripts } from "@/lib/jobs/kick";
import { queueTranscriptJobs } from "@/lib/transcripts/sweep";
import {
  extractRecordingUrl,
  getCallRecordings,
  getCdr,
  recordingRef,
  type VoipMsCdr,
  type VoipMsRecording,
} from "@/lib/voipms";

/**
 * Réconciliation CDR voip.ms → table `calls`, partagée entre le cron quotidien
 * (/api/cron/sync-cdr) et la synchronisation à la demande de l'admin
 * (/api/admin/calls/sync — « les enregistrements de ce matin tout de suite »,
 * ou un rattrapage au-delà de la fenêtre du cron).
 *
 * Rattache providerCallId / durée / réponse, insère les appels inconnus, puis
 * attache les URLs d'enregistrement. N'échoue jamais en bloc : les erreurs
 * partielles sont collectées et retournées.
 *
 * Concurrence : cron et synchro admin peuvent se chevaucher (l'API voip.ms
 * met parfois 90 s+). Deux passes simultanées inséreraient les mêmes CDR en
 * double — providerCallId n'a pas de contrainte d'unicité en base. Les appels
 * réseau (lents) se font donc AVANT, puis toute la phase base de données
 * s'exécute dans UNE transaction protégée par un verrou consultatif
 * (pg_try_advisory_xact_lock) : la seconde passe ressort immédiatement avec
 * l'erreur « sync_already_running » au lieu de dupliquer.
 */

type CallRowLite = {
  id: string;
  userId: string;
  startedAt: Date;
  endedAt: Date | null;
  fromNumber: string | null;
  toNumber: string | null;
  providerCallId: string | null;
  durationSec: number;
  answeredAt: Date | null;
  recordingUrl: string | null;
};

const MATCH_WINDOW_MS = 3 * 60 * 1000;

/**
 * voip.ms renvoie l'heure LOCALE de Toronto, heure avancée déjà appliquée.
 * Chaque horodatage est ré-interprété dans le fuseau réel À SON instant
 * (EDT -4 / EST -5), pas avec le décalage du premier jour de la plage : la
 * synchro tourne toujours sur hier + aujourd'hui, et le dimanche du
 * changement d'heure un décalage figé aurait décalé d'une heure tous les
 * appels du jour — hors de l'heuristique à ±3 min, donc dédoublés.
 */
function parseCdrDate(raw: string): Date | null {
  const d = fromZonedTime(raw.replace(" ", "T"), APP_TZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Le numéro d'un champ du registre. voip.ms écrit parfois l'appelant d'un
 * entrant sous la forme `"Nom" <4184311685>` — le nom est souvent le numéro
 * lui-même : lu tel quel, il donnait `+141843116854184311685` au journal.
 */
function cdrNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /<([^>]+)>/.exec(raw)?.[1] ?? raw;
}

/**
 * Ce qu'un enregistrement voip.ms dit de lui-même, quels que soient les noms
 * de champs du jour. Lu à UN seul endroit pour que la synchro de la journée
 * et la récupération d'un seul appel (`pullCallRecording`) ne puissent pas
 * rapprocher différemment le même enregistrement.
 */
type RecordingFacts = {
  /**
   * Ce qu'on range dans `calls.recording_url`. voip.ms ne fournit pas d'URL :
   * la liste ne porte qu'un identifiant `callrecording`. On mémorise alors une
   * RÉFÉRENCE et l'audio est retéléchargé au moment de l'écoute (voir
   * /api/admin/recordings).
   */
  locator: string | undefined;
  account: string | undefined;
  /**
   * `call_id` porte l'uniqueid du CDR ; `uniqueid` reste accepté au cas où
   * voip.ms harmoniserait ses noms de champs.
   */
  callUid: string | undefined;
  when: Date | null;
  callerKey: ReturnType<typeof phoneMatchKey>;
  destKey: ReturnType<typeof phoneMatchKey>;
  /** Tous les champs texte — dernier repli : un uniqueid connu cité quelque part. */
  haystack: string;
};

function recordingFacts(rec: VoipMsRecording): RecordingFacts {
  const text = (key: string): string | undefined => {
    const value = (rec as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  };
  const account = text("account");
  const recId = text("callrecording");
  const datetime = text("datetime");
  return {
    locator:
      extractRecordingUrl(rec) ?? (account && recId ? recordingRef(account, recId) : undefined),
    account,
    callUid: text("call_id") ?? text("uniqueid"),
    when: datetime ? parseCdrDate(datetime) : null,
    callerKey: phoneMatchKey(text("caller") ?? null),
    destKey: phoneMatchKey(text("destination") ?? null),
    haystack: Object.values(rec)
      .filter((v): v is string => typeof v === "string")
      .join(" "),
  };
}

/**
 * Une trace d'appel chez voip.ms — ligne CDR ou enregistrement — réduite à ce
 * qui la rapproche d'un appel du journal : son heure et ses numéros.
 */
type Sighting = {
  when: Date | null;
  callerKey: ReturnType<typeof phoneMatchKey>;
  destKey: ReturnType<typeof phoneMatchKey>;
};

/**
 * Même appel ? Même horaire à ±3 min, et un numéro de l'appel parmi ceux de la
 * trace (10 derniers chiffres). UNE règle pour les lignes CDR comme pour les
 * enregistrements, pour la synchro comme pour la récupération d'un appel.
 * (Même ligne SIP : c'est à l'appelant de n'offrir que les appels du
 * propriétaire du sous-compte.)
 */
function fitsCall(
  sighting: Sighting,
  call: { startedAt: Date; fromNumber: string | null; toNumber: string | null },
): boolean {
  if (!sighting.when) return false;
  if (Math.abs(call.startedAt.getTime() - sighting.when.getTime()) > MATCH_WINDOW_MS) return false;
  const keys = [phoneMatchKey(call.fromNumber), phoneMatchKey(call.toNumber)].filter(Boolean);
  return keys.some((k) => k === sighting.callerKey || k === sighting.destKey);
}

/** Une ligne CDR vue comme une trace (`date` en heure locale de Toronto). */
function cdrSighting(row: Pick<VoipMsCdr, "date" | "callerid" | "destination">): Sighting {
  return {
    when: row.date ? parseCdrDate(row.date) : null,
    callerKey: phoneMatchKey(row.callerid),
    destKey: phoneMatchKey(row.destination),
  };
}

/**
 * Les lignes SIP de l'équipe : par sous-compte, TOUS ses détenteurs, dans
 * l'ordre de la liste reçue (de création — voir les appelants) ; par DID.
 */
function indexLines<U extends { sipUsername: string | null; didNumber: string | null }>(
  list: U[],
): { byAccount: Map<string, U[]>; byDid: Map<string, U> } {
  const byAccount = new Map<string, U[]>();
  const byDid = new Map<string, U>();
  for (const u of list) {
    if (u.sipUsername) {
      const holders = byAccount.get(u.sipUsername);
      if (holders) holders.push(u);
      else byAccount.set(u.sipUsername, [u]);
    }
    const didKey = phoneMatchKey(u.didNumber);
    if (didKey) byDid.set(didKey, u);
  }
  return { byAccount, byDid };
}

/**
 * Qui a pu passer ou recevoir l'appel d'une ligne CDR : les détenteurs de son
 * sous-compte, sinon — compte inconnu, patte du compte principal, DID routé
 * ailleurs — l'usager dont le DID est la destination, et c'est alors un
 * entrant pour lui (auparavant ces lignes étaient écartées et les appels
 * manqués devenaient invisibles).
 *
 * D'ordinaire un seul détenteur. Une ligne PARTAGÉE — refusée désormais, mais
 * la base peut en garder : le 2026-09-13, Alex et « mikey » étaient tous deux
 * sur 551013_alex — ne dit pas qui a appelé, et la synchro donnait tout au
 * dernier lu : les appels d'Alex naissaient une seconde fois sous « mikey »,
 * avec leurs enregistrements. Le DID appelé tranche pour un entrant ; pour un
 * sortant, c'est l'appel du webphone qui dira qui c'était (voir la synchro).
 * L'identifiant d'appelant, lui, ne tranche rien : c'est un réglage du
 * sous-compte, le même pour tous ceux qui le partagent.
 */
function cdrLineOwner<U extends { didNumber: string | null }>(
  row: Pick<VoipMsCdr, "account" | "destination">,
  lines: { byAccount: Map<string, U[]>; byDid: Map<string, U> },
): { holders: U[]; forcedInbound: boolean } | null {
  const destKey = phoneMatchKey(row.destination);
  const holders = lines.byAccount.get(row.account);
  if (holders && holders.length > 0) {
    const called =
      holders.length > 1 && destKey
        ? holders.find((u) => phoneMatchKey(u.didNumber) === destKey)
        : undefined;
    return { holders: called ? [called] : holders, forcedInbound: false };
  }
  const byDid = destKey ? lines.byDid.get(destKey) : undefined;
  return byDid ? { holders: [byDid], forcedInbound: true } : null;
}

/**
 * Marge au-delà de laquelle deux lignes CDR qui se suivent ne sont plus deux
 * pattes du même appel : de quoi couvrir deux horodatages à une seconde
 * d'écart, bien trop court pour raccrocher et recomposer.
 */
const LEG_SLACK_MS = 2_000;

/** Début et fin d'une ligne CDR, en millisecondes — `null` sans date lisible. */
function cdrSpan(row: { date: string; seconds: string }): { start: number; end: number } | null {
  const at = row.date ? parseCdrDate(row.date) : null;
  if (!at) return null;
  const start = at.getTime();
  return { start, end: start + (Number.parseInt(row.seconds, 10) || 0) * 1000 };
}

/**
 * Un même appel produit PLUSIEURS lignes CDR chez voip.ms — une par patte
 * (sous-compte → passerelle, passerelle → destination). Observé en production :
 * uniqueid consécutifs (…374 / …375), même destination, seules les durées
 * diffèrent. Sans regroupement, la 1re patte s'attachait à l'appel local et la
 * 2e était insérée comme un appel fantôme.
 *
 * On garde une ligne par appel — même sous-compte, même destination, pattes
 * qui se CHEVAUCHENT dans le temps : celle qui a la plus longue durée, soit la
 * patte qui couvre tout l'appel ; à égalité, le plus petit uniqueid, pour que
 * deux synchros gardent la MÊME (l'API ne promet aucun ordre, et garder
 * l'autre patte la fois suivante l'inscrivait en double). Le chevauchement
 * plutôt que la seconde exacte : deux pattes peuvent être horodatées à une
 * seconde d'écart — le 2026-09-12, un appel de 16 min 51 est apparu deux fois.
 * Un rappel du même numéro commence APRÈS la fin du premier appel : il ne
 * chevauche pas, et reste un appel à part.
 */
export function collapseCdrLegs<
  T extends { account: string; destination: string; date: string; seconds: string; uniqueid?: string },
>(rows: T[]): T[] {
  type Leg = { row: T; index: number; start: number; end: number };
  const secs = (leg: Leg) => Number.parseInt(leg.row.seconds, 10) || 0;
  const better = (a: Leg, b: Leg) =>
    secs(a) !== secs(b) ? secs(a) > secs(b) : (a.row.uniqueid ?? "") < (b.row.uniqueid ?? "");

  const kept: Array<{ row: T; index: number }> = [];
  const legs: Leg[] = [];
  rows.forEach((row, index) => {
    const span = cdrSpan(row);
    // Sans date lisible, pas de regroupement possible : la synchro l'écartera.
    if (span) legs.push({ row, index, ...span });
    else kept.push({ row, index });
  });
  legs.sort((a, b) => a.start - b.start);

  const open = new Map<string, { best: Leg; start: number; end: number }>();
  for (const leg of legs) {
    const key = `${leg.row.account}|${phoneMatchKey(leg.row.destination) ?? leg.row.destination}`;
    const call = open.get(key);
    // Même appel : les pattes démarrent à quelques secondes l'une de l'autre
    // (un appel très court n'a presque pas de durée pour se chevaucher), ou
    // se chevauchent.
    if (call && (leg.start - call.start <= LEG_TOLERANCE_MS || leg.start <= call.end + LEG_SLACK_MS)) {
      if (better(leg, call.best)) call.best = leg;
      call.end = Math.max(call.end, leg.end);
      continue;
    }
    if (call) kept.push(call.best);
    open.set(key, { best: leg, start: leg.start, end: leg.end });
  }
  for (const call of open.values()) kept.push(call.best);
  return kept.sort((a, b) => a.index - b.index).map((k) => k.row);
}

/**
 * Deux lignes du registre sont-elles deux pattes du MÊME appel ? Même
 * destination ; même sous-compte — ou un compte inconnu (compte principal)
 * qui cite le même appelant, jamais deux sous-comptes connus (l'agent A qui
 * appelle le DID de l'agent B, ce sont deux appels) — et des durées qui se
 * chevauchent, comme pour `collapseCdrLegs`.
 */
function sameCallLegs(a: VoipMsCdr, b: VoipMsCdr, knownAccounts: ReadonlySet<string>): boolean {
  const key = (n: string) => phoneMatchKey(n) ?? n;
  if (key(a.destination) !== key(b.destination)) return false;
  if (a.account !== b.account) {
    if (knownAccounts.has(a.account) && knownAccounts.has(b.account)) return false;
    if (key(a.callerid) !== key(b.callerid)) return false;
  }
  const sa = cdrSpan(a);
  const sb = cdrSpan(b);
  if (!sa || !sb) return false;
  return (
    Math.abs(sa.start - sb.start) <= LEG_TOLERANCE_MS ||
    (sa.start <= sb.end + LEG_SLACK_MS && sb.start <= sa.end + LEG_SLACK_MS)
  );
}

/**
 * Les pattes de chaque ligne du registre, elle comprise. Le regroupement n'en
 * garde qu'une ; les autres restent utiles : un appel du journal peut porter
 * l'uniqueid de n'importe laquelle (celle qu'une synchro précédente a gardée),
 * et un enregistrement aussi.
 */
function cdrLegIndex(
  rows: VoipMsCdr[],
  knownAccounts: ReadonlySet<string>,
): (row: VoipMsCdr) => VoipMsCdr[] {
  const keyOf = (r: VoipMsCdr) => phoneMatchKey(r.destination) ?? r.destination ?? "";
  const byDest = new Map<string, VoipMsCdr[]>();
  for (const r of rows) {
    if (!r.uniqueid) continue;
    const bucket = byDest.get(keyOf(r));
    if (bucket) bucket.push(r);
    else byDest.set(keyOf(r), [r]);
  }
  return (row) =>
    (byDest.get(keyOf(row)) ?? []).filter(
      (r) => r === row || r.uniqueid === row.uniqueid || sameCallLegs(row, r, knownAccounts),
    );
}

/**
 * Un appel ENTRANT peut produire des pattes sous des comptes DIFFÉRENTS
 * (compte principal → DID, puis DID → sous-compte) : collapseCdrLegs ne les
 * regroupe pas, sa clé incluant le compte. Sans ce second regroupement, la
 * patte « compte principal » serait insérée en double par le repli
 * d'attribution par DID.
 *
 * Deux règles, apprises à la dure :
 * 1. Une patte d'un sous-compte CONNU n'est JAMAIS supprimée — chacune est une
 *    attribution à part entière. Quand l'agent A appelle le DID de l'agent B,
 *    le lot contient la patte sortante de A ET la patte entrante de B avec les
 *    mêmes numéros à la même seconde : deux appels distincts, pas deux pattes.
 *    Seules les pattes de comptes inconnus (compte principal) se font absorber.
 * 2. Les pattes d'un même appel sont écrites par des sauts différents et
 *    peuvent se chevaucher d'une seconde : la comparaison se fait à ±10 s,
 *    pas à la seconde exacte.
 */
const LEG_TOLERANCE_MS = 10_000;

export function collapseCrossAccountLegs<
  T extends { account: string; callerid: string; destination: string; date: string; seconds: string },
>(rows: T[], knownAccounts: ReadonlySet<string>): T[] {
  const numKey = (r: T) =>
    `${phoneMatchKey(r.callerid) ?? r.callerid}|${phoneMatchKey(r.destination) ?? r.destination}`;
  // Dates locales Toronto sans fuseau — seules leurs différences comptent.
  // (r.date peut manquer sur un CDR partiel : la boucle aval l'écartera.)
  const legTime = (r: T) => (r.date ? Date.parse(r.date.replace(" ", "T")) || 0 : 0);
  const secs = (r: T) => Number.parseInt(r.seconds, 10) || 0;

  const out: T[] = [];
  const knownTimes = new Map<string, number[]>();
  const unknown: T[] = [];
  for (const row of rows) {
    if (knownAccounts.has(row.account)) {
      out.push(row);
      const key = numKey(row);
      const list = knownTimes.get(key);
      if (list) list.push(legTime(row));
      else knownTimes.set(key, [legTime(row)]);
    } else {
      unknown.push(row);
    }
  }

  // Pattes inconnues : absorbées par une patte connue du même appel, sinon
  // regroupées entre elles (patte la plus longue conservée).
  unknown.sort((a, b) => legTime(a) - legTime(b));
  const lastUnknown = new Map<string, { time: number; index: number }>();
  for (const row of unknown) {
    const key = numKey(row);
    const time = legTime(row);
    const near = knownTimes.get(key);
    if (near?.some((t) => Math.abs(t - time) <= LEG_TOLERANCE_MS)) continue;
    const last = lastUnknown.get(key);
    if (last && time - last.time <= LEG_TOLERANCE_MS) {
      if (secs(row) > secs(out[last.index])) out[last.index] = row;
      lastUnknown.set(key, { time, index: last.index });
      continue;
    }
    lastUnknown.set(key, { time, index: out.length });
    out.push(row);
  }
  return out;
}

/** Ne notifier que les appels manqués récents — un rattrapage d'archives ne doit pas spammer. */
const MISSED_NOTIFY_WINDOW_MS = 48 * 3600_000;

const MAX_ERRORS = 25;
/**
 * Clé du verrou consultatif Postgres de la synchro CDR. Entier littéral —
 * même convention que le verrou de réservation (874511, voir
 * src/app/(app)/appointments/actions.ts) : pas de dépendance à hashtext(),
 * fonction interne non documentée. Les deux clés doivent rester DISTINCTES,
 * sinon une synchro bloquerait les prises de rendez-vous.
 */
const SYNC_LOCK_KEY = 874512;

export type CdrSyncResult = {
  counts: {
    cdrRows: number;
    matchedByProviderId: number;
    matchedHeuristic: number;
    inserted: number;
    unknownAccount: number;
    missedNotified: number;
    recordingsFound: number;
    recordingsAttached: number;
    recordingsWithoutUrl: number;
    /** Jobs `call_transcript` mis en file pour les enregistrements sans note IA. */
    transcriptsQueued: number;
    /** Appels en double fusionnés dans le bon (voir `repairCallDuplicates`). */
    duplicatesMerged: number;
    /** Appels rendus au compte dont le DID avait été composé. */
    callsReassigned: number;
  };
  /**
   * Noms des champs renvoyés par voip.ms pour un enregistrement SANS URL
   * directe — la seule façon de savoir quelle clé porte l'identifiant à
   * redemander. Diagnostic : aucune valeur, seulement les noms de champs.
   */
  recordingFields: string[];
  errors: string[];
};

/** Dates YYYY-MM-DD (Toronto), bornes incluses. */
export async function syncCdrRange(dateFrom: string, dateTo: string): Promise<CdrSyncResult> {
  const counts: CdrSyncResult["counts"] = {
    cdrRows: 0,
    matchedByProviderId: 0,
    matchedHeuristic: 0,
    inserted: 0,
    unknownAccount: 0,
    missedNotified: 0,
    recordingsFound: 0,
    recordingsAttached: 0,
    recordingsWithoutUrl: 0,
    transcriptsQueued: 0,
    duplicatesMerged: 0,
    callsReassigned: 0,
  };
  const errors: string[] = [];
  const recordingFields = new Set<string>();
  const pushError = (msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };

  // ── 1. Appels réseau voip.ms (lents) — AVANT la transaction ──
  let cdrRows: Awaited<ReturnType<typeof getCdr>> = [];
  try {
    cdrRows = await getCdr(dateFrom, dateTo);
  } catch (err) {
    pushError(`getCdr: ${err instanceof Error ? err.message : String(err)}`);
  }
  counts.cdrRows = cdrRows.length;

  // Les enregistrements se demandent PAR SOUS-COMPTE (paramètre `account`
  // obligatoire). On lit donc la liste des lignes avant d'interroger voip.ms.
  // Une ligne partagée par deux comptes ne se demande qu'une fois.
  const sipAccounts = [
    ...new Set(
      (await db.select({ sipUsername: users.sipUsername }).from(users))
        .map((u) => u.sipUsername)
        .filter((a): a is string => Boolean(a)),
    ),
  ];

  const recordings: VoipMsRecording[] = [];
  for (const account of sipAccounts) {
    try {
      recordings.push(...(await getCallRecordings(account, dateFrom, dateTo)));
    } catch (err) {
      // Une ligne en erreur ne doit pas priver les autres de leurs
      // enregistrements — l'erreur est remontée telle quelle à l'admin.
      pushError(
        `getCallRecordings(${account}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  counts.recordingsFound = recordings.length;

  // ── Phase base de données, sous verrou consultatif ──
  // Les lignes de notification naissent DANS la transaction, la poussée part
  // DEHORS — d'où cette liste tenue à l'extérieur. Le point de passage
  // (`createNotifications`) programme d'ordinaire la poussée lui-même, mais
  // `runAfterResponse` DÉMARRE le travail tout de suite : il le fait survivre à
  // la réponse, il ne l'attarde pas jusqu'au COMMIT. Poussée depuis l'intérieur,
  // l'annonce d'un appel manqué s'afficherait sur un écran verrouillé avant que
  // la réconciliation soit acquise — et un `rollback` n'a aucun moyen de
  // rappeler une notification déjà lue. On écrit donc les lignes avec `tx`
  // (elles vivent et meurent avec la synchro, et `counts.missedNotified` ne
  // ment jamais sur ce qui a été retenu), on coupe la poussée, et on la rallume
  // une fois la transaction close — le même ordre que l'`afterCommit` du SMS
  // entrant. Le type vient du côté ENVOI, le plus strict des deux : il passe
  // tel quel à l'écriture.
  const missedRows: PushableRow[] = [];
  const ranToCompletion = await db.transaction(async (tx) => {
    const lockRows = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(${SYNC_LOCK_KEY}) as locked`,
    )) as unknown as Array<{ locked: boolean }>;
    if (!lockRows[0]?.locked) return false;

    // ── 2. Comptes SIP → utilisateurs ──
    const allUsers = await tx
      .select({
        id: users.id,
        sipUsername: users.sipUsername,
        didNumber: users.didNumber,
        locale: users.locale,
        // Pour joindre le DÉTENTEUR d'une fiche en plus du propriétaire de la
        // ligne : un compte désactivé n'est pas un destinataire, mais son
        // téléphone reste abonné et vibrerait encore.
        isActive: users.isActive,
      })
      .from(users)
      // L'ordre fixe le premier détenteur d'une ligne partagée (voir plus bas).
      .orderBy(users.createdAt);
    const lines = indexLines(allUsers);
    const userByAccount = lines.byAccount;
    const userById = new Map(allUsers.map((u) => [u.id, u]));

    const windowFrom = new Date(dayStartUtc(dateFrom).getTime() - 6 * 3600_000);
    const windowTo = new Date(dayStartUtc(dateTo).getTime() + 30 * 3600_000);

    // ── 2 bis. Doublons d'une ligne partagée ou d'une patte répétée ──
    // AVANT l'index en mémoire : les appels réparés y entrent sous leur vrai
    // détenteur, avec l'uniqueid et l'enregistrement que le doublon portait.
    const repaired = await repairCallDuplicates(tx, allUsers, windowFrom, windowTo);
    counts.duplicatesMerged = repaired.merged;
    counts.callsReassigned = repaired.reassigned;

    // ── 3. Appels existants dans la fenêtre (index en mémoire) ──
    const existing: CallRowLite[] = await tx
      .select({
        id: calls.id,
        userId: calls.userId,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
        fromNumber: calls.fromNumber,
        toNumber: calls.toNumber,
        providerCallId: calls.providerCallId,
        durationSec: calls.durationSec,
        answeredAt: calls.answeredAt,
        recordingUrl: calls.recordingUrl,
      })
      .from(calls)
      .where(and(gte(calls.startedAt, windowFrom), lt(calls.startedAt, windowTo)));

    const byProviderId = new Map<string, CallRowLite>();
    const byUser = new Map<string, CallRowLite[]>();
    for (const c of existing) {
      if (c.providerCallId) byProviderId.set(c.providerCallId, c);
      const list = byUser.get(c.userId);
      if (list) list.push(c);
      else byUser.set(c.userId, [c]);
    }

    // ── 4. Réconciliation CDR → calls ──
    const notifyCutoff = Date.now() - MISSED_NOTIFY_WINDOW_MS;
    const missedToNotify: Array<{
      user: (typeof allUsers)[number];
      fromNumber: string | null;
      client: { id: string; fullName: string; assignedToId: string | null } | null;
    }> = [];
    const knownAccounts = new Set(userByAccount.keys());
    const cdrRowsCollapsed = collapseCrossAccountLegs(collapseCdrLegs(cdrRows), knownAccounts);
    const legsOf = cdrLegIndex(cdrRows, knownAccounts);
    for (const row of cdrRowsCollapsed) {
      try {
        if (!row.uniqueid) continue;
        const destKey = phoneMatchKey(row.destination);

        const owner = cdrLineOwner(row, lines);
        if (!owner) {
          counts.unknownAccount += 1;
          continue;
        }
        const { holders, forcedInbound } = owner;
        const startedAt = parseCdrDate(row.date);
        if (!startedAt) {
          pushError(`cdr ${row.uniqueid}: date invalide "${row.date}"`);
          continue;
        }
        const seconds = Number.parseInt(row.seconds, 10) || 0;
        const answered = row.disposition?.toUpperCase() === "ANSWERED";

        // Les uniqueid de TOUTES les pattes de cet appel : une synchro
        // précédente a pu en garder une autre (voir collapseCdrLegs), et un
        // enregistrement peut citer n'importe laquelle.
        const legUids = legsOf(row).map((r) => r.uniqueid);
        const remember = (call: CallRowLite) => {
          for (const uid of legUids) if (!byProviderId.has(uid)) byProviderId.set(uid, call);
        };

        // a) Correspondance directe par providerCallId — celui de n'importe
        //    quelle patte de l'appel.
        const direct = legUids.map((uid) => byProviderId.get(uid)).find((c) => c !== undefined);
        if (direct) {
          remember(direct);
          counts.matchedByProviderId += 1;
          const needsAnswer = answered && !direct.answeredAt;
          if (direct.durationSec !== seconds || needsAnswer) {
            await tx
              .update(calls)
              .set({
                durationSec: seconds,
                ...(needsAnswer ? { answeredAt: startedAt } : {}),
              })
              .where(eq(calls.id, direct.id));
            direct.durationSec = seconds;
            if (needsAnswer) direct.answeredAt = startedAt;
          }
          continue;
        }

        // b) Heuristique : un détenteur de la ligne, ±3 min, mêmes 10 derniers
        //    chiffres. Sur une ligne partagée, c'est ici que se dit qui a
        //    appelé : l'appel que son webphone a journalisé.
        const sighting = cdrSighting(row);
        const candidates = holders
          .flatMap((h) => byUser.get(h.id) ?? [])
          .filter((c) => !c.providerCallId && fitsCall(sighting, c));
        if (candidates.length > 0) {
          candidates.sort(
            (a, b) =>
              Math.abs(a.startedAt.getTime() - startedAt.getTime()) -
              Math.abs(b.startedAt.getTime() - startedAt.getTime()),
          );
          const match = candidates[0];
          const needsAnswer = answered && !match.answeredAt;
          await tx
            .update(calls)
            .set({
              providerCallId: row.uniqueid,
              durationSec: seconds,
              ...(needsAnswer ? { answeredAt: startedAt } : {}),
            })
            .where(eq(calls.id, match.id));
          match.providerCallId = row.uniqueid;
          match.durationSec = seconds;
          if (needsAnswer) match.answeredAt = startedAt;
          remember(match);
          counts.matchedHeuristic += 1;
          continue;
        }

        // b bis) Aucun appel libre, mais un appel DÉJÀ retrouvé de la ligne,
        //    même numéro, dont la durée chevauche celle-ci : une autre patte du
        //    même appel, que le regroupement n'a pas reconnue — un entrant sur
        //    une ligne partagée sonne sur une patte et décroche sur une autre,
        //    ~25 s plus tard. La règle de la réparation (`overlapsCall`) : sans
        //    elle, la réparation fondait cette patte et la synchro la
        //    réinsérait, à chaque passage.
        //    Tous les comptes de la ligne, pas seulement celui dont le DID a
        //    été composé : un entrant sonne chez tous — et c'est peut-être
        //    l'autre qui a décroché (6 sept. : l'appel au DID d'Alex, pris par
        //    « mikey »). La réparation regarde toute la ligne ; ici aussi.
        const rowStart = startedAt.getTime();
        const lineMates = userByAccount.get(row.account) ?? holders;
        const sameCall = lineMates
          .flatMap((h) => byUser.get(h.id) ?? [])
          .find(
            (c) =>
              c.providerCallId !== null &&
              fitsCall(sighting, c) &&
              overlapsCall(c, rowStart, rowStart + seconds * 1000),
          );
        if (sameCall) {
          remember(sameCall);
          counts.matchedHeuristic += 1;
          continue;
        }

        // c) Aucun appel local : insertion depuis le CDR. Ligne partagée et
        //    aucun webphone pour trancher : le premier détenteur (le compte le
        //    plus ancien), faute de mieux — voir cdrLineOwner.
        const user = holders[0];
        const didKey = phoneMatchKey(user.didNumber);
        const direction: "inbound" | "outbound" =
          forcedInbound || (didKey && destKey && didKey === destKey) ? "inbound" : "outbound";
        const otherRaw = direction === "inbound" ? row.callerid : row.destination;
        const otherKey = phoneMatchKey(otherRaw);

        // `assignedToId` voyage avec la fiche jusqu'aux notifications : c'est
        // lui qui désigne le second destinataire d'un appel manqué.
        let client: { id: string; fullName: string; assignedToId: string | null } | null = null;
        if (otherKey) {
          const [match] = await tx
            .select({
              id: clients.id,
              fullName: clients.fullName,
              assignedToId: clients.assignedToId,
            })
            .from(clients)
            .where(
              or(like(clients.phone, `%${otherKey}`), like(clients.phoneAlt, `%${otherKey}`)),
            )
            .limit(1);
          client = match ?? null;
        }
        const clientId = client?.id ?? null;

        const [insertedRow] = await tx
          .insert(calls)
          .values({
            userId: user.id,
            clientId,
            direction,
            fromNumber: normalizePhone(cdrNumber(row.callerid)),
            toNumber: normalizePhone(row.destination),
            startedAt,
            answeredAt: answered ? startedAt : null,
            endedAt: new Date(startedAt.getTime() + seconds * 1000),
            durationSec: seconds,
            provider: "voipms",
            providerCallId: row.uniqueid,
          })
          .returning({ id: calls.id });
        counts.inserted += 1;

        // Appel manqué découvert par la synchro (fureteur fermé au moment de
        // l'appel) : notifier le propriétaire de la ligne pour qu'il rappelle.
        // Les appels rattachés plus haut ont déjà été journalisés — et
        // notifiés — par le webphone ; pas de doublon possible ici.
        if (direction === "inbound" && !answered && startedAt.getTime() >= notifyCutoff) {
          missedToNotify.push({ user, fromNumber: normalizePhone(cdrNumber(row.callerid)), client });
        }

        const lite: CallRowLite = {
          id: insertedRow.id,
          userId: user.id,
          startedAt,
          endedAt: new Date(startedAt.getTime() + seconds * 1000),
          fromNumber: normalizePhone(cdrNumber(row.callerid)),
          toNumber: normalizePhone(row.destination),
          providerCallId: row.uniqueid,
          durationSec: seconds,
          answeredAt: answered ? startedAt : null,
          recordingUrl: null,
        };
        remember(lite);
        const list = byUser.get(user.id);
        if (list) list.push(lite);
        else byUser.set(user.id, [lite]);
      } catch (err) {
        pushError(
          `cdr ${row.uniqueid ?? "?"}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ── 5. Rattachement des enregistrements ──
    for (const rec of recordings) {
      try {
        const facts = recordingFacts(rec);
        const url = facts.locator;
        if (!url) {
          // Ni URL ni identifiant : compté ET tracé (noms de champs seulement)
          // plutôt qu'un « 0 attaché » silencieux.
          counts.recordingsWithoutUrl += 1;
          for (const k of Object.keys(rec)) recordingFields.add(k);
          continue;
        }

        let call = facts.callUid ? byProviderId.get(facts.callUid) : undefined;

        // Repli principal : même ligne SIP, puis même horaire et même numéro.
        const when = facts.when;
        if (!call && facts.account && when) {
          const holders = userByAccount.get(facts.account) ?? [];
          if (holders.length > 0) {
            const candidates = holders
              .flatMap((h) => byUser.get(h.id) ?? [])
              .filter((c) => fitsCall(facts, c));
            candidates.sort(
              (a, b) =>
                Math.abs(a.startedAt.getTime() - when.getTime()) -
                Math.abs(b.startedAt.getTime() - when.getTime()),
            );
            call = candidates[0];
          }
        }

        if (!call) {
          // Dernier repli : un uniqueid connu apparaît-il dans les champs texte ?
          for (const [uid, candidate] of byProviderId) {
            if (facts.haystack.includes(uid)) {
              call = candidate;
              break;
            }
          }
        }
        if (call && call.recordingUrl !== url) {
          await tx.update(calls).set({ recordingUrl: url }).where(eq(calls.id, call.id));
          call.recordingUrl = url;
          counts.recordingsAttached += 1;
        }
      } catch (err) {
        pushError(`recording: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── 6. Notifications d'appels manqués récents ──
    if (missedToNotify.length > 0) {
      missedRows.push(
        ...missedToNotify.flatMap((m) => {
          // L'annuaire est déjà en mémoire : résoudre le détenteur ne coûte
          // pas une requête de plus, même sur une synchro qui rattrape
          // plusieurs dizaines d'appels d'un coup.
          const holder = m.client?.assignedToId
            ? userById.get(m.client.assignedToId)
            : undefined;
          return missedCallRows({
            lineOwner: { id: m.user.id, locale: m.user.locale },
            assignee:
              holder && holder.isActive ? { id: holder.id, locale: holder.locale } : null,
            client: m.client,
            // Chemin MACHINE : pas de regard à filtrer. Le propriétaire de la
            // ligne a reçu l'appel, la fiche est nommée pour lui comme avant.
            visibleToLineOwner: true,
            fromNumber: m.fromNumber,
          });
        }),
      );
      await createNotifications(missedRows, { tx, push: false });
      counts.missedNotified = missedToNotify.length;
    }

    return true;
  });

  if (!ranToCompletion) {
    pushError("sync_already_running");
  }

  // ── 6 bis. Réveiller les téléphones, la transaction une fois validée ──
  // Rien ne part si elle n'est pas allée au bout : une seconde passe
  // concurrente (verrou refusé) n'a rien écrit, et une erreur en chemin a tout
  // annulé en remontant. Après la réponse, comme partout ailleurs : chaque
  // envoi vers APNs ou FCM est un aller-retour réseau, et l'admin qui vient de
  // cliquer « Synchroniser » n'a pas à regarder tourner le sablier pendant
  // qu'on réveille les cellulaires.
  if (ranToCompletion && missedRows.length > 0) {
    runAfterResponse(async () => {
      await fanoutPush(missedRows);
    });
  }

  // ── 7. Notes d'appel IA — APRÈS la transaction ──
  // Le balayage met en file un job `call_transcript` par enregistrement sans
  // note (réglage `transcripts` éteint = 0). Hors du verrou : les rangées
  // recordingUrl sont déjà validées, et une erreur ici ne doit pas faire
  // annuler la synchronisation elle-même.
  try {
    counts.transcriptsQueued = await queueTranscriptJobs();
    // Coup d'envoi du couloir dédié : les jobs viennent d'être mis en file,
    // autant en traiter quelques-uns tout de suite (le cron vide le reste).
    if (counts.transcriptsQueued > 0) kickTranscripts();
  } catch (err) {
    pushError(`transcripts: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { counts, recordingFields: [...recordingFields], errors };
}

/** Pourquoi rien n'a été rattaché — trois situations qui ne se disent pas pareil. */
export type PullNotFoundReason =
  /** Aucun enregistrement sur la ligne ce jour-là : le plus souvent, pas ENCORE. */
  | "pending"
  /** voip.ms en a sur la ligne ce jour-là, mais aucun n'est celui de cet appel. */
  | "unmatched"
  /** Pas un appel voip.ms : rien à lui demander. */
  | "not_voipms";

/**
 * Ce que la demande a vu chez voip.ms — pour le journal d'audit, jamais pour
 * le navigateur. C'est ce qui manquait le 2026-09-13 : « pas encore » ne
 * disait pas si voip.ms n'avait rien, ou avait quelque chose qu'on ne savait
 * pas rapprocher.
 */
export type PullDiagnostics = {
  /** Enregistrements de la ligne sur la journée, porteurs d'un identifiant. */
  recordingsOnLine: number;
  /** Noms des champs vus sur ces enregistrements — jamais les valeurs. */
  recordingFields: string[];
  /** L'appel a son uniqueid : déjà connu, ou retrouvé au registre (CDR). */
  cdrFound: boolean;
  /** Le registre n'a pas répondu ; on a rapproché sans lui. */
  cdrError?: string;
  /**
   * Écart, en secondes, entre l'appel et l'enregistrement de la ligne le plus
   * proche. Une heure pile trahirait un fuseau.
   */
  nearestGapSec: number | null;
  /** Par où l'enregistrement a été reconnu. */
  matchedBy?: "uid" | "time" | "cited";
};

export type PullRecordingOutcome =
  /** Trouvé chez voip.ms et rattaché à l'appel. */
  | { status: "attached"; recordingUrl: string; diag: PullDiagnostics }
  /** L'appel avait déjà le sien (posé avant, ou par une synchro entre-temps). */
  | { status: "already"; recordingUrl: string }
  /** Rien de rattaché — voir `reason`. */
  | { status: "not_found"; reason: PullNotFoundReason; diag?: PullDiagnostics }
  /** Le téléphoniste n'a pas de sous-compte voip.ms : personne à qui demander. */
  | { status: "no_line" }
  | { status: "upstream_error"; message: string };

type CallToLocate = {
  id: string;
  userId: string;
  startedAt: Date;
  fromNumber: string | null;
  toNumber: string | null;
};

/**
 * Retrouve UN appel du journal dans le registre (CDR) de voip.ms, avec les
 * règles de la synchro : pattes regroupées, attribution à la ligne, horaire et
 * numéro. Rend :
 *  - `primary` : l'uniqueid que la synchro lui donnerait ;
 *  - `legs` : ceux de toutes ses pattes — un enregistrement peut porter celui
 *    d'une patte écartée au regroupement ;
 *  - `foreign` : ceux des AUTRES appels du registre. Un enregistrement qui en
 *    porte un n'est pas le nôtre, même tombé à la bonne minute : rappeler le
 *    même numéro dans la foulée est la règle, en centre d'appels.
 * Un uniqueid déjà porté par un autre appel du journal lui reste — la synchro
 * le lui rendrait par correspondance directe. Appel introuvable : rien de
 * tout ça, et le rapprochement retombe sur l'horaire et le numéro.
 */
async function locateInCdr(
  call: CallToLocate,
  rows: VoipMsCdr[],
): Promise<{ primary: string | null; legs: Set<string>; foreign: Set<string> }> {
  const lines = indexLines(
    await db
      .select({ id: users.id, sipUsername: users.sipUsername, didNumber: users.didNumber })
      .from(users)
      .orderBy(users.createdAt),
  );
  const known = new Set(lines.byAccount.keys());
  const legsOf = cdrLegIndex(rows, known);
  const t0 = call.startedAt.getTime();
  const gapOf = (s: Sighting) => Math.abs((s.when?.getTime() ?? Number.POSITIVE_INFINITY) - t0);
  const ranked = collapseCrossAccountLegs(collapseCdrLegs(rows), known)
    .filter(
      (row) =>
        row.uniqueid && cdrLineOwner(row, lines)?.holders.some((h) => h.id === call.userId),
    )
    .map((row) => ({
      uid: row.uniqueid,
      sighting: cdrSighting(row),
      legs: legsOf(row).map((r) => r.uniqueid),
    }))
    .filter((c) => fitsCall(c.sighting, call))
    .sort((a, b) => gapOf(a.sighting) - gapOf(b.sighting));

  // Un appel du registre dont une patte est déjà portée par un autre appel du
  // journal est à celui-là : la synchro le lui rendrait par correspondance directe.
  const claimed = new Set<string>();
  const uids = ranked.flatMap((c) => c.legs);
  if (uids.length > 0) {
    const taken = await db
      .select({ uid: calls.providerCallId })
      .from(calls)
      .where(and(ne(calls.id, call.id), inArray(calls.providerCallId, uids)));
    for (const t of taken) if (t.uid) claimed.add(t.uid);
  }
  const primary = ranked.find((c) => !c.legs.some((uid) => claimed.has(uid)));
  if (!primary) return { primary: null, legs: new Set(), foreign: new Set() };

  const legs = new Set(primary.legs);
  const foreign = new Set(
    rows.flatMap((r) => (r.uniqueid && !legs.has(r.uniqueid) ? [r.uniqueid] : [])),
  );
  return { primary: primary.uid, legs, foreign };
}

/**
 * L'enregistrement d'UN appel, demandé à voip.ms tout de suite — sans
 * attendre le cron du lendemain ni rapatrier toute la journée de tous les
 * postes comme « Synchroniser voip.ms ».
 *
 * Deux questions à voip.ms, posées EN MÊME TEMPS (son API peut mettre plus
 * d'une minute) : les enregistrements du sous-compte de CE téléphoniste sur la
 * journée de l'appel (deux s'il frôle minuit), et le registre de la même
 * journée — pour trouver à l'appel son uniqueid s'il n'en a pas encore, et
 * reconnaître ceux des AUTRES appels.
 *
 * Pourquoi le registre : un appel du webphone n'a JAMAIS d'uniqueid avant une
 * synchro. Sans lui, il ne restait que l'horaire et les numéros de
 * l'enregistrement — un horaire dont voip.ms ne dit pas le fuseau (la liste
 * n'accepte pas de `timezone`, et le registre a déjà menti d'une heure), et
 * des numéros dont il manque la moitié (sa liste documentée n'a pas de
 * `caller`). Le 2026-09-13, « Récupérer » répondait « pas encore » pour des
 * appels que voip.ms avait bel et bien enregistrés. L'uniqueid est le lien
 * vérifié en production, celui par lequel la synchro rattache.
 *
 * L'ordre de préférence reste celui de la synchro — uniqueid, puis horaire et
 * numéro, puis uniqueid cité — et passe par les mêmes fonctions : un
 * enregistrement ne doit pas finir sous deux appels différents selon le bouton
 * pressé.
 *
 * Trois gardes qu'un appel isolé doit tenir à la main :
 *  - un enregistrement déjà posé sur un AUTRE appel ne se vole pas ;
 *  - un enregistrement dont l'uniqueid désigne un autre appel connu non plus ;
 *  - ni, l'appel une fois retrouvé au registre, celui qui porte l'uniqueid
 *    d'un AUTRE appel du registre, même tombé à la bonne minute.
 * Les écritures sont conditionnelles (`IS NULL`) : une synchro passée
 * entre-temps garde le dernier mot, sans verrou à partager avec elle.
 *
 * Chemin MACHINE, sans regard : c'est la route qui vérifie que l'appelant
 * atteint CET appel avant de demander quoi que ce soit. `null` = appel absent.
 */
export async function pullCallRecording(callId: string): Promise<PullRecordingOutcome | null> {
  const [call] = await db
    .select({
      id: calls.id,
      userId: calls.userId,
      startedAt: calls.startedAt,
      fromNumber: calls.fromNumber,
      toNumber: calls.toNumber,
      provider: calls.provider,
      providerCallId: calls.providerCallId,
      recordingUrl: calls.recordingUrl,
      account: users.sipUsername,
    })
    .from(calls)
    .innerJoin(users, eq(users.id, calls.userId))
    .where(eq(calls.id, callId))
    .limit(1);
  if (!call) return null;
  if (call.recordingUrl) return { status: "already", recordingUrl: call.recordingUrl };
  // Un appel Twilio n'a pas d'enregistrement chez voip.ms, et le chercher sous
  // le sous-compte de la ligne pourrait en ramener un qui n'est pas le sien.
  if (call.provider !== "voipms") return { status: "not_found", reason: "not_voipms" };
  if (!call.account) return { status: "no_line" };
  const account = call.account;

  const t0 = call.startedAt.getTime();
  const day = (at: number) => formatInTimeZone(new Date(at), APP_TZ, "yyyy-MM-dd");
  const dateFrom = day(t0 - MATCH_WINDOW_MS);
  const dateTo = day(t0 + MATCH_WINDOW_MS);

  // Le registre est demandé même quand l'appel a déjà son uniqueid : c'est lui
  // qui dit quels enregistrements sont ceux des autres appels.
  const [listed, registry] = await Promise.allSettled([
    getCallRecordings(account, dateFrom, dateTo),
    getCdr(dateFrom, dateTo),
  ]);
  if (listed.status === "rejected") {
    const err: unknown = listed.reason;
    return { status: "upstream_error", message: err instanceof Error ? err.message : String(err) };
  }

  const recordingFields = new Set<string>();
  for (const rec of listed.value) for (const k of Object.keys(rec)) recordingFields.add(k);
  const found = listed.value
    .map(recordingFacts)
    .filter(
      (f): f is RecordingFacts & { locator: string } =>
        f.locator !== undefined && (f.account === undefined || f.account === account),
    );

  // ── L'appel au registre : ses uniqueid, et ceux des autres ──
  const ours = new Set<string>(call.providerCallId ? [call.providerCallId] : []);
  let foreign = new Set<string>();
  let foundUid: string | null = null;
  let cdrError: string | undefined;
  if (registry.status === "rejected") {
    // Le registre en panne n'empêche pas de chercher : on rapproche alors
    // comme avant, par l'horaire et le numéro.
    const err: unknown = registry.reason;
    cdrError = err instanceof Error ? err.message : String(err);
  } else {
    const located = await locateInCdr(call, registry.value);
    if (!call.providerCallId) foundUid = located.primary;
    for (const uid of located.legs) ours.add(uid);
    foreign = located.foreign;
    // Celui que l'appel porte déjà reste le sien, quoi qu'en dise l'horaire.
    for (const uid of ours) foreign.delete(uid);
  }
  // L'uniqueid retrouvé reste sur l'appel, enregistrement ou pas : la synchro
  // reconnaîtra l'appel par correspondance directe — c'est ce qu'elle aurait
  // écrit elle-même — et la prochaine demande le connaîtra même si le
  // registre ne répond pas.
  if (foundUid) {
    await db
      .update(calls)
      .set({ providerCallId: foundUid })
      .where(and(eq(calls.id, call.id), isNull(calls.providerCallId)));
  }

  const gap = (f: RecordingFacts) => Math.abs((f.when?.getTime() ?? Infinity) - t0);
  const gaps = found.filter((f) => f.when).map(gap);
  const diag: PullDiagnostics = {
    recordingsOnLine: found.length,
    recordingFields: [...recordingFields].sort(),
    cdrFound: ours.size > 0,
    ...(cdrError ? { cdrError } : {}),
    nearestGapSec: gaps.length > 0 ? Math.round(Math.min(...gaps) / 1000) : null,
  };
  if (found.length === 0) return { status: "not_found", reason: "pending", diag };

  const locators = found.map((f) => f.locator);
  const uids = found.flatMap((f) => (f.callUid ? [f.callUid] : []));
  const others = await db
    .select({ recordingUrl: calls.recordingUrl, providerCallId: calls.providerCallId })
    .from(calls)
    .where(
      and(
        ne(calls.id, call.id),
        uids.length > 0
          ? or(inArray(calls.recordingUrl, locators), inArray(calls.providerCallId, uids))
          : inArray(calls.recordingUrl, locators),
      ),
    );
  const takenLocators = new Set(others.map((o) => o.recordingUrl));
  const otherUids = new Set(others.map((o) => o.providerCallId));
  const free = found.filter(
    (f) =>
      !takenLocators.has(f.locator) &&
      !(f.callUid && (otherUids.has(f.callUid) || foreign.has(f.callUid))),
  );

  const byUid = free.find((f) => f.callUid !== undefined && ours.has(f.callUid));
  const byTime = free.filter((f) => fitsCall(f, call)).sort((a, b) => gap(a) - gap(b))[0];
  const cited = free.find((f) => [...ours].some((uid) => f.haystack.includes(uid)));
  const pick = byUid ?? byTime ?? cited;
  if (!pick) return { status: "not_found", reason: "unmatched", diag };
  diag.matchedBy = pick === byUid ? "uid" : pick === byTime ? "time" : "cited";

  const written = await db
    .update(calls)
    .set({ recordingUrl: pick.locator })
    .where(and(eq(calls.id, call.id), isNull(calls.recordingUrl)))
    .returning({ id: calls.id });
  if (written.length === 0) {
    const [now] = await db
      .select({ recordingUrl: calls.recordingUrl })
      .from(calls)
      .where(eq(calls.id, call.id));
    return now?.recordingUrl
      ? { status: "already", recordingUrl: now.recordingUrl }
      : { status: "not_found", reason: "unmatched", diag };
  }

  // La note d'appel IA suit l'enregistrement, comme après une synchro
  // (réglage `transcripts` éteint = rien en file). Un raté ici ne défait pas
  // le rattachement : le balayage de la prochaine synchro le rattrapera.
  try {
    if ((await queueTranscriptJobs()) > 0) kickTranscripts();
  } catch {
    // voir ci-dessus
  }
  return { status: "attached", recordingUrl: pick.locator, diag };
}
