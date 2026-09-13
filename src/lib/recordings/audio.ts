import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { callStars, recordingAudio, recordingCollectionItems } from "@/db/schema-library";
import { getSetting } from "@/lib/settings";
import {
  extractRecordingAudio,
  getCallRecordingFile,
  parseRecordingRef,
  sniffAudioType,
} from "@/lib/voipms";

/**
 * L'audio CONSERVÉ de la bibliothèque d'écoute (table `recording_audio`).
 *
 * Chemin MACHINE : aucune garde de regard ici. Les routes vérifient que
 * l'appelant atteint CET appel avant d'appeler quoi que ce soit ; le ramassage
 * (cron, synchro) n'a pas de regard, comme le reste de la synchro voip.ms.
 *
 * Trois règles tiennent tout le module :
 *  1. On ne garde que l'audio des appels de la BIBLIOTHÈQUE — marqués par
 *     quelqu'un ou rangés quelque part. Dès qu'un appel n'y est plus, sa copie
 *     rend la place (`pruneOrphanAudio`).
 *  2. On ne dépasse jamais le plafond (`recordings.audioCapMb`) : au-delà, on
 *     cesse de conserver. La base est partagée avec tout le CRM, et une base
 *     pleine passe en lecture seule.
 *  3. Un audio RETIRÉ par quelqu'un ne revient pas en douce : seul le geste
 *     explicite « Conserver » le reprend.
 */

export const MB = 1024 * 1024;
/** Garde-fou : un « enregistrement » plus lourd que ça n'est pas un appel. */
const MAX_AUDIO_BYTES = 50 * MB;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type KeptAudioState = { state: "kept"; bytes: number } | { state: "removed" };

export type KeepOutcome =
  | { status: "kept"; bytes: number }
  | { status: "already"; bytes: number }
  /** Quelqu'un a retiré cet audio : seul un geste explicite le reprend. */
  | { status: "removed" }
  | { status: "cap_reached" }
  | { status: "not_in_library" }
  | { status: "no_recording" }
  | { status: "upstream_error"; message: string };

type AudioFile = { buf: Buffer; contentType: string };

/** L'appel est-il dans la bibliothèque — marqué par quelqu'un, ou rangé quelque part ? */
function inLibrary(callId: typeof calls.id | typeof recordingAudio.callId) {
  return sql<boolean>`(exists (select 1 from ${callStars} where ${callStars.callId} = ${callId}) or exists (select 1 from ${recordingCollectionItems} where ${recordingCollectionItems.callId} = ${callId}))`;
}

const keptBytesSum = sql<number>`coalesce(sum(${recordingAudio.bytes}), 0)`.mapWith(Number);

async function capBytes(): Promise<number> {
  const { audioCapMb } = await getSetting("recordings");
  return audioCapMb * MB;
}

/** Octets conservés pour les AUTRES appels — la copie de celui-ci serait remplacée. */
async function keptBytesExcept(callId: string): Promise<number> {
  const [row] = await db
    .select({ n: keptBytesSum })
    .from(recordingAudio)
    .where(ne(recordingAudio.callId, callId));
  return row?.n ?? 0;
}

/** La jauge : ce que l'audio conservé occupe, pour combien d'appels, sous quel plafond. */
export async function audioUsage(): Promise<{ bytes: number; calls: number; capBytes: number }> {
  const [[row], cap] = await Promise.all([
    db
      .select({
        bytes: keptBytesSum,
        calls: sql<number>`count(*) filter (where ${recordingAudio.bytes} > 0)`.mapWith(Number),
      })
      .from(recordingAudio),
    capBytes(),
  ]);
  return { bytes: row?.bytes ?? 0, calls: row?.calls ?? 0, capBytes: cap };
}

/** Où en est la copie de chaque appel d'une page. Absent = jamais conservé. */
export async function audioStateFor(callIds: string[]): Promise<Map<string, KeptAudioState>> {
  const out = new Map<string, KeptAudioState>();
  if (callIds.length === 0) return out;
  const rows = await db
    .select({ callId: recordingAudio.callId, bytes: recordingAudio.bytes })
    .from(recordingAudio)
    .where(inArray(recordingAudio.callId, callIds));
  for (const r of rows) {
    out.set(r.callId, r.bytes > 0 ? { state: "kept", bytes: r.bytes } : { state: "removed" });
  }
  return out;
}

/** La copie de CET enregistrement, si elle existe et n'est pas périmée. */
export async function readKeptAudio(callId: string, ref: string): Promise<AudioFile | null> {
  const [row] = await db
    .select({ audio: recordingAudio.audio, contentType: recordingAudio.contentType })
    .from(recordingAudio)
    .where(
      and(
        eq(recordingAudio.callId, callId),
        eq(recordingAudio.sourceRef, ref),
        isNotNull(recordingAudio.audio),
      ),
    )
    .limit(1);
  return row?.audio ? { buf: row.audio, contentType: row.contentType } : null;
}

function checkedAudio(buf: Buffer, declared: string | null): AudioFile {
  if (buf.length === 0) throw new Error("empty_audio");
  if (buf.length > MAX_AUDIO_BYTES) throw new Error("audio_too_large");
  const sniffed = sniffAudioType(buf);
  const contentType = declared?.startsWith("audio/")
    ? declared
    : sniffed === "application/octet-stream"
      ? "audio/mpeg"
      : sniffed;
  return { buf, contentType };
}

/**
 * L'audio COMPLET d'une référence d'enregistrement — les deux formes que sert
 * déjà /api/admin/recordings : `voipms:<compte>:<id>` (retéléchargé par l'API,
 * qui rend du base64 ou une URL) et l'URL voip.ms directe (forme historique,
 * limitée aux hôtes voip.ms comme au proxy).
 */
export async function downloadRecording(ref: string): Promise<AudioFile> {
  let url: string;
  const parsed = parseRecordingRef(ref);
  if (parsed) {
    const audio = extractRecordingAudio(
      await getCallRecordingFile(parsed.account, parsed.callrecording),
    );
    if ("base64" in audio) return checkedAudio(Buffer.from(audio.base64, "base64"), null);
    if ("fields" in audio) throw new Error(`unsupported_payload: ${audio.fields.join(",")}`);
    url = audio.url;
  } else {
    const target = new URL(ref);
    const voipHost = target.hostname === "voip.ms" || target.hostname.endsWith(".voip.ms");
    if (target.protocol !== "https:" || !voipHost) throw new Error("forbidden_host");
    url = target.toString();
  }
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstream_${res.status}`);
  return checkedAudio(Buffer.from(await res.arrayBuffer()), res.headers.get("content-type"));
}

type Precheck =
  | { ok: true; ref: string; others: number; cap: number }
  | { ok: false; outcome: KeepOutcome };

/** Tout ce qui peut refuser AVANT de déranger voip.ms. */
async function precheck(callId: string, explicit: boolean): Promise<Precheck> {
  const [row] = await db
    .select({
      ref: calls.recordingUrl,
      inLib: inLibrary(calls.id),
      keptBytes: recordingAudio.bytes,
      keptRef: recordingAudio.sourceRef,
      removedAt: recordingAudio.removedAt,
    })
    .from(calls)
    .leftJoin(recordingAudio, eq(recordingAudio.callId, calls.id))
    .where(eq(calls.id, callId))
    .limit(1);
  if (!row?.ref) return { ok: false, outcome: { status: "no_recording" } };
  if (!row.inLib) return { ok: false, outcome: { status: "not_in_library" } };
  if (row.keptBytes && row.keptBytes > 0 && row.keptRef === row.ref) {
    return { ok: false, outcome: { status: "already", bytes: row.keptBytes } };
  }
  if (row.removedAt && !explicit) return { ok: false, outcome: { status: "removed" } };
  const [others, cap] = await Promise.all([keptBytesExcept(callId), capBytes()]);
  // Plafond déjà atteint (ou à 0) : inutile de télécharger pour refuser ensuite.
  if (others >= cap) return { ok: false, outcome: { status: "cap_reached" } };
  return { ok: true, ref: row.ref, others, cap };
}

async function writeAudio(callId: string, ref: string, file: AudioFile): Promise<void> {
  const values = {
    audio: file.buf,
    bytes: file.buf.length,
    contentType: file.contentType,
    sourceRef: ref,
    keptAt: new Date(),
    removedAt: null,
    removedById: null,
  };
  await db
    .insert(recordingAudio)
    .values({ callId, ...values })
    .onConflictDoUpdate({ target: recordingAudio.callId, set: values });
}

/**
 * Garder l'audio de CET appel, en le téléchargeant chez voip.ms.
 *
 * `explicit` : le bouton « Conserver ». C'est le seul chemin qui reprend un
 * audio que quelqu'un a retiré — le ramassage automatique, lui, respecte ce
 * choix.
 */
export async function keepAudio(
  callId: string,
  opts: { explicit?: boolean } = {},
): Promise<KeepOutcome> {
  const pre = await precheck(callId, opts.explicit ?? false);
  if (!pre.ok) return pre.outcome;
  let file: AudioFile;
  try {
    file = await downloadRecording(pre.ref);
  } catch (err) {
    return { status: "upstream_error", message: err instanceof Error ? err.message : String(err) };
  }
  if (pre.others + file.buf.length > pre.cap) return { status: "cap_reached" };
  await writeAudio(callId, pre.ref, file);
  return { status: "kept", bytes: file.buf.length };
}

/**
 * Garder AU PASSAGE l'audio qu'une écoute vient de télécharger — sans une
 * seule requête de plus à voip.ms. Mêmes refus que `keepAudio` (hors
 * bibliothèque, retiré, plafond), et seulement si `ref` est bien
 * l'enregistrement actuel de l'appel.
 */
export async function storeFetchedAudio(
  callId: string,
  ref: string,
  buf: Buffer,
  contentType: string,
): Promise<KeepOutcome> {
  const pre = await precheck(callId, false);
  if (!pre.ok) return pre.outcome;
  if (pre.ref !== ref) return { status: "no_recording" };
  let file: AudioFile;
  try {
    file = checkedAudio(buf, contentType);
  } catch (err) {
    return { status: "upstream_error", message: err instanceof Error ? err.message : String(err) };
  }
  if (pre.others + file.buf.length > pre.cap) return { status: "cap_reached" };
  await writeAudio(callId, ref, file);
  return { status: "kept", bytes: file.buf.length };
}

/**
 * Rendre la place de CET appel. La ligne reste, audio vidé : elle se souvient
 * du choix, et l'écoute repassera par voip.ms — tant qu'il garde le fichier.
 * `null` = rien n'était conservé.
 */
export async function removeAudio(
  callId: string,
  userId: string,
): Promise<{ bytes: number } | null> {
  const [before] = await db
    .select({ bytes: recordingAudio.bytes })
    .from(recordingAudio)
    .where(and(eq(recordingAudio.callId, callId), gt(recordingAudio.bytes, 0)));
  if (!before) return null;
  await db
    .update(recordingAudio)
    .set({ audio: null, bytes: 0, removedAt: new Date(), removedById: userId })
    .where(eq(recordingAudio.callId, callId));
  return { bytes: before.bytes };
}

/** « Tout retirer » : chaque copie rend sa place, et chacune se souvient du choix. */
export async function removeAllAudio(userId: string): Promise<{ calls: number; bytes: number }> {
  const [freed] = await db
    .select({
      bytes: keptBytesSum,
      calls: sql<number>`count(*)`.mapWith(Number),
    })
    .from(recordingAudio)
    .where(gt(recordingAudio.bytes, 0));
  await db
    .update(recordingAudio)
    .set({ audio: null, bytes: 0, removedAt: new Date(), removedById: userId })
    .where(gt(recordingAudio.bytes, 0));
  return { calls: freed?.calls ?? 0, bytes: freed?.bytes ?? 0 };
}

/**
 * Le ménage : un appel qui n'est plus marqué par personne ni rangé nulle part
 * rend sa place — copie ET souvenir d'un retrait, la question ne se pose plus.
 * `callIds` limite le ménage à ces appels (après un geste précis) ; sans lui,
 * toute la table est passée (après la suppression d'un dossier, au cron).
 */
export async function pruneOrphanAudio(callIds?: string[]): Promise<number> {
  if (callIds && callIds.length === 0) return 0;
  const orphans = await db
    .select({ callId: recordingAudio.callId })
    .from(recordingAudio)
    .where(
      and(
        callIds ? inArray(recordingAudio.callId, callIds) : undefined,
        sql`not ${inLibrary(recordingAudio.callId)}`,
      ),
    );
  if (orphans.length === 0) return 0;
  await db.delete(recordingAudio).where(
    inArray(
      recordingAudio.callId,
      orphans.map((o) => o.callId),
    ),
  );
  return orphans.length;
}

/**
 * Le ramassage : les appels de la bibliothèque qui ont un enregistrement mais
 * pas encore de copie (marqués avant que voip.ms ne dépose l'audio, plafond
 * relevé depuis…). Les plus récents d'abord — ce sont ceux que voip.ms a
 * encore à coup sûr. S'arrête au plafond, à `limit` appels, ou quand le
 * budget de temps est épuisé (voip.ms peut mettre une minute par fichier).
 */
export async function keepPendingAudio(
  opts: { limit?: number; budgetMs?: number } = {},
): Promise<{ kept: number; failed: number; capReached: boolean }> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 90_000;
  const pending = await db
    .select({ id: calls.id })
    .from(calls)
    .leftJoin(recordingAudio, eq(recordingAudio.callId, calls.id))
    .where(and(isNotNull(calls.recordingUrl), isNull(recordingAudio.callId), inLibrary(calls.id)))
    .orderBy(desc(calls.startedAt))
    .limit(opts.limit ?? 10);

  let kept = 0;
  let failed = 0;
  for (const { id } of pending) {
    if (Date.now() - started > budget) break;
    const outcome = await keepAudio(id);
    if (outcome.status === "kept") kept += 1;
    else if (outcome.status === "cap_reached") return { kept, failed, capReached: true };
    else if (outcome.status === "upstream_error") failed += 1;
  }
  return { kept, failed, capReached: false };
}
