import { and, eq, gte, like, lt, or } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { dayStartUtc, shiftDateStr, todayStr } from "@/components/analytics/period";
import { db } from "@/db";
import { calls, clients, users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { normalizePhone, phoneMatchKey } from "@/lib/phone";
import { getCallRecordings, getCdr } from "@/lib/voipms";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/sync-cdr — Bearer CRON_SECRET.
 * Réconcilie les CDR voip.ms (hier + aujourd'hui, dates Toronto) avec la table
 * `calls` : rattache providerCallId / durée / réponse, insère les appels
 * inconnus, puis attache les URLs d'enregistrement. N'échoue jamais en bloc :
 * les erreurs partielles sont collectées et retournées.
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
const MAX_ERRORS = 25;

/** Les CDR sont demandés avec timezone -5 (offset fixe côté voip.ms). */
function parseCdrDate(raw: string): Date | null {
  const d = new Date(`${raw.replace(" ", "T")}-05:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = todayStr();
  const yesterday = shiftDateStr(today, -1);

  const counts = {
    cdrRows: 0,
    matchedByProviderId: 0,
    matchedHeuristic: 0,
    inserted: 0,
    unknownAccount: 0,
    recordingsAttached: 0,
  };
  const errors: string[] = [];
  const pushError = (msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };

  // ── 1. CDR voip.ms ──
  let cdrRows: Awaited<ReturnType<typeof getCdr>> = [];
  try {
    cdrRows = await getCdr(yesterday, today);
  } catch (err) {
    pushError(`getCdr: ${err instanceof Error ? err.message : String(err)}`);
  }
  counts.cdrRows = cdrRows.length;

  // ── 2. Comptes SIP → utilisateurs ──
  const allUsers = await db
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
  const windowFrom = new Date(dayStartUtc(yesterday).getTime() - 6 * 3600_000);
  const windowTo = new Date(Date.now() + 6 * 3600_000);
  const existing: CallRowLite[] = await db
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
  for (const row of cdrRows) {
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
          await db
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
        await db
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
        const [client] = await db
          .select({ id: clients.id })
          .from(clients)
          .where(
            or(like(clients.phone, `%${otherKey}`), like(clients.phoneAlt, `%${otherKey}`)),
          )
          .limit(1);
        clientId = client?.id ?? null;
      }

      const [insertedRow] = await db
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

  // ── 5. Enregistrements (fonctionnalité possiblement désactivée) ──
  try {
    const recordings = await getCallRecordings(yesterday, today);
    for (const rec of recordings) {
      try {
        const url =
          typeof rec.url === "string" && rec.url.length > 0 ? rec.url : undefined;
        if (!url) continue;

        const recUid =
          typeof (rec as Record<string, unknown>).uniqueid === "string"
            ? ((rec as Record<string, unknown>).uniqueid as string)
            : undefined;
        let call = recUid ? byProviderId.get(recUid) : undefined;
        if (!call) {
          // Repli : chercher un uniqueid connu dans les champs texte de l'enregistrement.
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
          await db.update(calls).set({ recordingUrl: url }).where(eq(calls.id, call.id));
          call.recordingUrl = url;
          counts.recordingsAttached += 1;
        }
      } catch (err) {
        pushError(`recording: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    pushError(`getCallRecordings: ${err instanceof Error ? err.message : String(err)}`);
  }

  await logAudit({
    userId: null,
    action: "cron.sync_cdr",
    entity: "calls",
    detail: { range: { from: yesterday, to: today }, counts, errors },
  });

  return NextResponse.json({
    ok: errors.length === 0,
    range: { from: yesterday, to: today },
    ...counts,
    errors,
  });
}
