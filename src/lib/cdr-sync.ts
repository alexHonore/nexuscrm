import "server-only";
import { and, eq, gte, like, lt, or, sql } from "drizzle-orm";
import { dayStartUtc } from "@/components/analytics/period";
import { db } from "@/db";
import { calls, clients, users } from "@/db/schema";
import { normalizePhone, phoneMatchKey } from "@/lib/phone";
import {
  extractRecordingUrl,
  getCallRecordings,
  getCdr,
  recordingRef,
  torontoUtcOffsetHours,
  utcOffsetSuffix,
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
  fromNumber: string | null;
  toNumber: string | null;
  providerCallId: string | null;
  durationSec: number;
  answeredAt: Date | null;
  recordingUrl: string | null;
};

const MATCH_WINDOW_MS = 3 * 60 * 1000;

/**
 * Un même appel produit PLUSIEURS lignes CDR chez voip.ms — une par patte
 * (sous-compte → passerelle, passerelle → destination). Observé en production :
 * uniqueid consécutifs (…374 / …375), même seconde, même destination, seules
 * les durées diffèrent. Sans regroupement, la 1re patte s'attachait à l'appel
 * local et la 2e était insérée comme un appel fantôme.
 *
 * On garde une ligne par (sous-compte, destination, seconde exacte) : celle qui
 * a la plus longue durée, c'est-à-dire la patte qui couvre tout l'appel. Deux
 * appels distincts vers le même numéro, depuis le même poste, à la même
 * seconde : impossible en pratique.
 */
export function collapseCdrLegs<T extends { account: string; destination: string; date: string; seconds: string }>(
  rows: T[],
): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.account}|${phoneMatchKey(row.destination) ?? row.destination}|${row.date}`;
    const current = best.get(key);
    if (!current || (Number.parseInt(row.seconds, 10) || 0) > (Number.parseInt(current.seconds, 10) || 0)) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}
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
    recordingsFound: number;
    recordingsAttached: number;
    recordingsWithoutUrl: number;
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
    recordingsFound: 0,
    recordingsAttached: 0,
    recordingsWithoutUrl: 0,
  };
  const errors: string[] = [];
  const recordingFields = new Set<string>();
  const pushError = (msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };

  // Les CDR sont demandés ET ré-interprétés dans le fuseau réel de Toronto à
  // cette date (EDT -4 / EST -5) — un décalage figé fausserait l'heuristique.
  const offsetSuffix = utcOffsetSuffix(torontoUtcOffsetHours(dateFrom));
  const parseCdrDate = (raw: string): Date | null => {
    const d = new Date(`${raw.replace(" ", "T")}${offsetSuffix}`);
    return Number.isNaN(d.getTime()) ? null : d;
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
  const sipAccounts = (
    await db.select({ sipUsername: users.sipUsername }).from(users)
  )
    .map((u) => u.sipUsername)
    .filter((a): a is string => Boolean(a));

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
      })
      .from(users);
    const userByAccount = new Map<string, (typeof allUsers)[number]>();
    for (const u of allUsers) {
      if (u.sipUsername) userByAccount.set(u.sipUsername, u);
    }

    // ── 3. Appels existants dans la fenêtre (index en mémoire) ──
    const windowFrom = new Date(dayStartUtc(dateFrom).getTime() - 6 * 3600_000);
    const windowTo = new Date(dayStartUtc(dateTo).getTime() + 30 * 3600_000);
    const existing: CallRowLite[] = await tx
      .select({
        id: calls.id,
        userId: calls.userId,
        startedAt: calls.startedAt,
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
    for (const row of collapseCdrLegs(cdrRows)) {
      try {
        if (!row.uniqueid) continue;
        const user = userByAccount.get(row.account);
        if (!user) {
          counts.unknownAccount += 1;
          continue;
        }
        const startedAt = parseCdrDate(row.date);
        if (!startedAt) {
          pushError(`cdr ${row.uniqueid}: date invalide "${row.date}"`);
          continue;
        }
        const seconds = Number.parseInt(row.seconds, 10) || 0;
        const answered = row.disposition?.toUpperCase() === "ANSWERED";
        const calleridKey = phoneMatchKey(row.callerid);
        const destKey = phoneMatchKey(row.destination);

        // a) Correspondance directe par providerCallId.
        const direct = byProviderId.get(row.uniqueid);
        if (direct) {
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

        // b) Heuristique : même utilisateur, ±3 min, mêmes 10 derniers chiffres.
        const candidates = (byUser.get(user.id) ?? []).filter((c) => {
          if (c.providerCallId) return false;
          if (Math.abs(c.startedAt.getTime() - startedAt.getTime()) > MATCH_WINDOW_MS)
            return false;
          const keys = [phoneMatchKey(c.fromNumber), phoneMatchKey(c.toNumber)].filter(
            Boolean,
          );
          return keys.some((k) => k === calleridKey || k === destKey);
        });
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
          byProviderId.set(row.uniqueid, match);
          counts.matchedHeuristic += 1;
          continue;
        }

        // c) Aucun appel local : insertion depuis le CDR.
        const didKey = phoneMatchKey(user.didNumber);
        const direction: "inbound" | "outbound" =
          didKey && destKey && didKey === destKey ? "inbound" : "outbound";
        const otherRaw = direction === "inbound" ? row.callerid : row.destination;
        const otherKey = phoneMatchKey(otherRaw);

        let clientId: string | null = null;
        if (otherKey) {
          const [client] = await tx
            .select({ id: clients.id })
            .from(clients)
            .where(
              or(like(clients.phone, `%${otherKey}`), like(clients.phoneAlt, `%${otherKey}`)),
            )
            .limit(1);
          clientId = client?.id ?? null;
        }

        const [insertedRow] = await tx
          .insert(calls)
          .values({
            userId: user.id,
            clientId,
            direction,
            fromNumber: normalizePhone(row.callerid),
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

        const lite: CallRowLite = {
          id: insertedRow.id,
          userId: user.id,
          startedAt,
          fromNumber: normalizePhone(row.callerid),
          toNumber: normalizePhone(row.destination),
          providerCallId: row.uniqueid,
          durationSec: seconds,
          answeredAt: answered ? startedAt : null,
          recordingUrl: null,
        };
        byProviderId.set(row.uniqueid, lite);
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
        const asRec = rec as Record<string, unknown>;
        // voip.ms ne fournit pas d'URL : la liste ne porte qu'un identifiant
        // `callrecording`. On mémorise une RÉFÉRENCE et l'audio est
        // retéléchargé au moment de l'écoute (voir /api/admin/recordings).
        const account = typeof asRec.account === "string" ? asRec.account : undefined;
        const recId =
          typeof asRec.callrecording === "string" ? asRec.callrecording : undefined;
        const url =
          extractRecordingUrl(rec) ??
          (account && recId ? recordingRef(account, recId) : undefined);
        if (!url) {
          // Ni URL ni identifiant : compté ET tracé (noms de champs seulement)
          // plutôt qu'un « 0 attaché » silencieux.
          counts.recordingsWithoutUrl += 1;
          for (const k of Object.keys(rec)) recordingFields.add(k);
          continue;
        }

        // `call_id` porte l'uniqueid du CDR ; `uniqueid` reste accepté au cas
        // où voip.ms harmoniserait ses noms de champs.
        const recUid =
          typeof asRec.call_id === "string"
            ? asRec.call_id
            : typeof asRec.uniqueid === "string"
              ? asRec.uniqueid
              : undefined;
        let call = recUid ? byProviderId.get(recUid) : undefined;

        // Repli principal : l'identifiant d'enregistrement n'est PAS toujours
        // l'uniqueid du CDR. On rapproche alors comme pour les CDR — même
        // ligne SIP, même horaire à ±3 min, mêmes 10 derniers chiffres.
        if (!call && account) {
          const owner = userByAccount.get(account);
          const when =
            typeof asRec.datetime === "string" ? parseCdrDate(asRec.datetime) : null;
          if (owner && when) {
            const callerKey = phoneMatchKey(
              typeof asRec.caller === "string" ? asRec.caller : null,
            );
            const destKey = phoneMatchKey(
              typeof asRec.destination === "string" ? asRec.destination : null,
            );
            const candidates = (byUser.get(owner.id) ?? []).filter((c) => {
              if (Math.abs(c.startedAt.getTime() - when.getTime()) > MATCH_WINDOW_MS) return false;
              const keys = [phoneMatchKey(c.fromNumber), phoneMatchKey(c.toNumber)].filter(
                Boolean,
              );
              return keys.some((k) => k === callerKey || k === destKey);
            });
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
          const haystack = Object.values(rec)
            .filter((v): v is string => typeof v === "string")
            .join(" ");
          for (const [uid, candidate] of byProviderId) {
            if (haystack.includes(uid)) {
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

    return true;
  });

  if (!ranToCompletion) {
    pushError("sync_already_running");
  }

  return { counts, recordingFields: [...recordingFields], errors };
}
