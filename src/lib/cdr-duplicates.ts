import "server-only";
import { and, eq, gte, lt } from "drizzle-orm";
import type { db } from "@/db";
import { calls } from "@/db/schema";
import { callStars, recordingAudio, recordingCollectionItems } from "@/db/schema-library";
import { callTranscripts } from "@/db/schema-sms";
import { phoneMatchKey } from "@/lib/phone";

/**
 * Réparation des appels en double que la synchro voip.ms a pu laisser derrière
 * elle — pour TOUTE l'équipe, quels que soient les comptes ajoutés, modifiés ou
 * retirés : rien ici ne nomme personne, tout se déduit des lignes SIP telles
 * qu'elles sont au moment où la synchro passe.
 *
 * Deux origines, corrigées à la source le 2026-09-13 mais dont la base garde la
 * trace :
 *  - une ligne PARTAGÉE : deux comptes sur le même sous-compte, la synchro
 *    donnait tout au dernier lu. L'appel du webphone de l'un restait sans
 *    uniqueid, et naissait une seconde fois sous l'autre — avec
 *    l'enregistrement ;
 *  - deux PATTES d'un même appel inscrites chacune comme un appel.
 *
 * Un « doublon » est une ligne que la synchro a CRÉÉE depuis le registre et que
 * personne n'a touchée depuis (voir `fromRegistry`). Rien de ce qu'une personne
 * a annoté n'est jamais fusionné.
 *
 * Trois gestes, dans cet ordre :
 *  1. le doublon rejoint l'appel du webphone qu'il double — même ligne, même
 *     numéro, durées qui se chevauchent. Resté sans uniqueid, cet appel reçoit
 *     celui du doublon, la durée du registre et l'enregistrement : ce que la
 *     synchro lui aurait donné si elle l'avait trouvé. Déjà retrouvé, il garde
 *     les siens — le doublon n'était qu'une autre patte ;
 *  2. sinon, un SORTANT vers le DID d'un compte de la même ligne était en fait
 *     un ENTRANT pour lui : il lui revient ;
 *  3. deux doublons du même compte, même sens, même numéro, dont les durées se
 *     chevauchent, sont deux pattes : ils n'en font qu'un. Un rappel du même
 *     numéro commence après la fin du premier appel : il reste à part.
 * Étoiles, dossiers, audio conservé et note IA suivent l'appel gardé.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** La fenêtre de rapprochement de la synchro. */
const MATCH_WINDOW_MS = 3 * 60 * 1000;
/** Deux pattes : des durées qui se chevauchent, à 2 s près (voir `collapseCdrLegs`). */
const LEG_SLACK_MS = 2_000;
/**
 * Un doublon et l'appel du webphone qu'il double : leurs durées se chevauchent,
 * à 5 s près — l'horloge du navigateur et celle de voip.ms ne sont pas
 * réglées à la seconde. Recomposer un numéro prend plus que ça : le rappel
 * d'un appel sans réponse ne se fond pas dans le premier essai.
 */
const TWIN_SLACK_MS = 5_000;

/**
 * La durée d'un appel du journal et celle d'une trace du registre se
 * chevauchent-elles ? UNE règle pour la réparation et pour la synchro : si
 * l'une fondait ce que l'autre ne reconnaît pas, la seconde le réinsérerait à
 * chaque passage (vu en production le 2026-09-14).
 */
export function overlapsCall(
  call: { startedAt: Date; endedAt: Date | null; durationSec: number },
  start: number,
  end: number,
): boolean {
  const callStart = call.startedAt.getTime();
  const callEnd = Math.max(call.endedAt?.getTime() ?? callStart, callStart + call.durationSec * 1000);
  return start <= callEnd + TWIN_SLACK_MS && callStart <= end + TWIN_SLACK_MS;
}

export type TeamLine = { id: string; sipUsername: string | null; didNumber: string | null };
export type DuplicateRepair = { merged: number; reassigned: number };

type CallRow = {
  id: string;
  userId: string;
  clientId: string | null;
  direction: "inbound" | "outbound";
  fromNumber: string | null;
  toNumber: string | null;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSec: number;
  disposition: string | null;
  note: string | null;
  providerCallId: string | null;
  recordingUrl: string | null;
};

/**
 * Créé par la synchro depuis le registre, et jamais touché depuis. Le signe
 * sûr : l'heure tombe à la seconde pile — le registre n'a pas de millisecondes,
 * le navigateur si — et l'appel est décroché à l'instant même où il commence,
 * ou pas du tout (la synchro ne connaît que ces deux cas).
 */
function fromRegistry(c: CallRow): boolean {
  return (
    c.providerCallId !== null &&
    !c.disposition &&
    !c.note &&
    c.startedAt.getTime() % 1000 === 0 &&
    (c.answeredAt === null || c.answeredAt.getTime() === c.startedAt.getTime())
  );
}

/** Le numéro de l'AUTRE bout de l'appel (10 derniers chiffres). */
function theirNumber(c: Pick<CallRow, "direction" | "fromNumber" | "toNumber">): string | null {
  return phoneMatchKey(c.direction === "inbound" ? c.fromNumber : c.toNumber);
}

/** Le meilleur donneur d'abord : celui qui a l'enregistrement, puis le plus long. */
function byDonorRank(a: CallRow, b: CallRow): number {
  return (
    Number(b.recordingUrl !== null) - Number(a.recordingUrl !== null) ||
    b.durationSec - a.durationSec ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Répare les doublons des appels commencés dans [from, to[. À appeler dans la
 * transaction de la synchro, AVANT qu'elle ne lise les appels existants.
 */
export async function repairCallDuplicates(
  tx: Tx,
  team: TeamLine[],
  from: Date,
  to: Date,
): Promise<DuplicateRepair> {
  // Qui est sur la ligne de qui — soi compris.
  const lineKey = (u: TeamLine) => u.sipUsername?.trim().toLowerCase() || null;
  const onLine = new Map<string, string[]>();
  for (const u of team) {
    const key = lineKey(u);
    if (!key) continue;
    const ids = onLine.get(key);
    if (ids) ids.push(u.id);
    else onLine.set(key, [u.id]);
  }
  const mates = (userId: string): Set<string> => {
    const user = team.find((u) => u.id === userId);
    const key = user ? lineKey(user) : null;
    return new Set(key ? (onLine.get(key) ?? [userId]) : [userId]);
  };
  const didHolder = new Map<string, string>();
  for (const u of team) {
    const key = phoneMatchKey(u.didNumber);
    if (key) didHolder.set(key, u.id);
  }

  const rows: CallRow[] = await tx
    .select({
      id: calls.id,
      userId: calls.userId,
      clientId: calls.clientId,
      direction: calls.direction,
      fromNumber: calls.fromNumber,
      toNumber: calls.toNumber,
      startedAt: calls.startedAt,
      answeredAt: calls.answeredAt,
      endedAt: calls.endedAt,
      durationSec: calls.durationSec,
      disposition: calls.disposition,
      note: calls.note,
      providerCallId: calls.providerCallId,
      recordingUrl: calls.recordingUrl,
    })
    .from(calls)
    .where(and(eq(calls.provider, "voipms"), gte(calls.startedAt, from), lt(calls.startedAt, to)));

  // Les appels du webphone — retrouvés au registre ou non. Retrouvé, l'appel
  // porte l'uniqueid d'une patte, et le doublon celui de l'autre (l'ancien
  // regroupement exigeait la seconde exacte) : relevé en production le
  // 2026-09-14, 46 appels avaient ainsi leur double sans disposition, avec le
  // même enregistrement.
  const webphone = rows.filter((c) => !fromRegistry(c));
  const suspects = rows
    .filter(fromRegistry)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));

  const merges = new Map<string, { target: CallRow; donors: CallRow[] }>();
  const absorb = (target: CallRow, donor: CallRow) => {
    const entry = merges.get(target.id);
    if (entry) entry.donors.push(donor);
    else merges.set(target.id, { target, donors: [donor] });
  };
  const absorbed = new Set<string>();
  let reassigned = 0;

  for (const p of suspects) {
    const peers = mates(p.userId);
    // Un sortant vers le DID d'un compte de la même ligne : un entrant pour lui.
    const called =
      p.direction === "outbound" ? didHolder.get(phoneMatchKey(p.toNumber) ?? "") : undefined;
    const calledMate = called && called !== p.userId && peers.has(called) ? called : undefined;
    const direction = calledMate ? "inbound" : p.direction;
    const number = calledMate ? phoneMatchKey(p.fromNumber) : theirNumber(p);
    if (!number) continue;

    const gap = (c: CallRow) => Math.abs(c.startedAt.getTime() - p.startedAt.getTime());
    // Le MÊME appel, pas seulement la même minute : les durées se chevauchent.
    const pStart = p.startedAt.getTime();
    const overlaps = (w: CallRow) => overlapsCall(w, pStart, pStart + p.durationSec * 1000);
    const twin = webphone
      .filter(
        (w) =>
          peers.has(w.userId) &&
          (!calledMate || w.userId === calledMate) &&
          w.direction === direction &&
          theirNumber(w) === number &&
          gap(w) <= MATCH_WINDOW_MS &&
          overlaps(w),
      )
      .sort((a, b) => gap(a) - gap(b))[0];
    if (twin) {
      absorb(twin, p);
      absorbed.add(p.id);
      continue;
    }
    if (calledMate) {
      await tx
        .update(calls)
        .set({ userId: calledMate, direction: "inbound" })
        .where(eq(calls.id, p.id));
      p.userId = calledMate;
      p.direction = "inbound";
      reassigned += 1;
    }
  }

  // Deux pattes d'un même appel : même compte, même sens, même numéro, durées
  // qui se chevauchent.
  const legKey = (c: CallRow) => `${c.userId}|${c.direction}|${theirNumber(c) ?? ""}`;
  const legs = suspects
    .filter((p) => !absorbed.has(p.id) && theirNumber(p) !== null)
    .sort((a, b) => legKey(a).localeCompare(legKey(b)) || a.startedAt.getTime() - b.startedAt.getTime());
  let group: CallRow[] = [];
  let groupKey = "";
  let groupEnd = 0;
  const closeGroup = () => {
    if (group.length < 2) return;
    const [keep, ...rest] = [...group].sort(byDonorRank);
    for (const leg of rest) absorb(keep, leg);
  };
  for (const p of legs) {
    const start = p.startedAt.getTime();
    const end = start + p.durationSec * 1000;
    if (legKey(p) === groupKey && start <= groupEnd + LEG_SLACK_MS) {
      group.push(p);
      groupEnd = Math.max(groupEnd, end);
      continue;
    }
    closeGroup();
    group = [p];
    groupKey = legKey(p);
    groupEnd = end;
  }
  closeGroup();

  let merged = 0;
  for (const { target, donors } of merges.values()) {
    donors.sort(byDonorRank);
    const donor = donors[0];
    // Un appel du webphone sans uniqueid prend celui du doublon, et la durée du
    // registre avec : c'est ce que la synchro lui aurait donné.
    const adopting = target.providerCallId === null;
    const recordingUrl =
      target.recordingUrl ?? donors.find((d) => d.recordingUrl !== null)?.recordingUrl ?? null;
    await tx
      .update(calls)
      .set({
        providerCallId: target.providerCallId ?? donor.providerCallId,
        durationSec: adopting ? donor.durationSec : target.durationSec,
        recordingUrl,
        answeredAt: target.answeredAt ?? donor.answeredAt,
        clientId: target.clientId ?? donor.clientId,
      })
      .where(eq(calls.id, target.id));
    for (const d of donors) {
      // L'audio conservé et la note IA racontent UN enregistrement : ils ne
      // suivent que s'il s'agit de celui que l'appel gardé porte désormais.
      await moveAttachments(tx, d.id, target.id, d.recordingUrl !== null && d.recordingUrl === recordingUrl);
      await tx.delete(calls).where(eq(calls.id, d.id));
      merged += 1;
    }
  }

  return { merged, reassigned };
}

/** Ce qui s'accroche à un appel le suit dans la fusion ; le reste part avec le doublon. */
async function moveAttachments(
  tx: Tx,
  fromId: string,
  toId: string,
  withRecording: boolean,
): Promise<void> {
  const stars = await tx
    .select({ userId: callStars.userId, createdAt: callStars.createdAt })
    .from(callStars)
    .where(eq(callStars.callId, fromId));
  if (stars.length > 0) {
    await tx
      .insert(callStars)
      .values(stars.map((s) => ({ ...s, callId: toId })))
      .onConflictDoNothing();
  }

  const items = await tx
    .select({
      collectionId: recordingCollectionItems.collectionId,
      note: recordingCollectionItems.note,
      addedById: recordingCollectionItems.addedById,
      addedAt: recordingCollectionItems.addedAt,
    })
    .from(recordingCollectionItems)
    .where(eq(recordingCollectionItems.callId, fromId));
  if (items.length > 0) {
    await tx
      .insert(recordingCollectionItems)
      .values(items.map((i) => ({ ...i, callId: toId })))
      .onConflictDoNothing();
  }

  if (!withRecording) return;
  // Une seule copie d'audio, une seule note IA par appel : celles du gardé priment.
  const [keptAudio] = await tx
    .select({ callId: recordingAudio.callId })
    .from(recordingAudio)
    .where(eq(recordingAudio.callId, toId));
  if (!keptAudio) {
    await tx.update(recordingAudio).set({ callId: toId }).where(eq(recordingAudio.callId, fromId));
  }
  const [transcript] = await tx
    .select({ id: callTranscripts.id })
    .from(callTranscripts)
    .where(eq(callTranscripts.callId, toId));
  if (!transcript) {
    await tx.update(callTranscripts).set({ callId: toId }).where(eq(callTranscripts.callId, fromId));
  }
}
