import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { messages, smsNumbers } from "@/db/schema-sms";
import { recordDeliveryOutcome } from "@/lib/sms-server/delivery";
import { processInboundSms } from "@/lib/sms-server/inbound";
import { getTwilioRestAuth, twilioBasicAuth } from "@/lib/sms-server/twilio-rest";

/**
 * Réconciliation REST avec Twilio — le filet qui ne dépend PAS des webhooks.
 *
 * Deux pannes réelles ont motivé ce module (2026-08-25) :
 *  · les rappels de statut n'atteignaient jamais l'app → 44 messages LIVRÉS
 *    affichés « En file » pour toujours ;
 *  · chaque réponse de client était rejetée en 403 (signature) → Twilio les
 *    marquait code 11200 et PERSONNE ne les voyait — ni l'assistant, ni
 *    l'équipe.
 *
 * À chaque cycle du répartiteur :
 *  1. SORTANT — les rangées `messages` restées à un statut non terminal
 *     (queued/sending/accepted, ou sent depuis < 24 h) sont relues une à une
 *     chez Twilio et avancées via recordDeliveryOutcome (même chemin
 *     d'écriture que le webhook : non-régression, suppression sur échec
 *     définitif).
 *  2. ENTRANT — la liste des messages reçus par nos numéros (48 h) est
 *     comparée aux sids en base ; les absents sont rejoués par
 *     processInboundSms. Un message frais (< 30 min) garde son tour d'agent ;
 *     un vieux message notifie un humain — répondre automatiquement trois
 *     jours plus tard ferait plus de mal que de bien.
 *
 * Sans configuration REST complète (compte + clé API), tout est désarmé —
 * aucun réseau dans les tests ni en dev. Les erreurs réseau d'un item
 * n'arrêtent pas le lot : Twilio sera encore là au prochain cycle.
 */

/** Rangées sortantes relues par cycle — borne le temps passé chez Twilio. */
const OUTBOUND_BATCH = 20;
/** Messages entrants rejoués par cycle. */
const INBOUND_BATCH = 20;
/** On laisse d'abord sa chance au webhook de statut. */
const OUTBOUND_MIN_AGE_MS = 2 * 60_000;
/** Un « sent » sans reçu de livraison n'est relu que 24 h. */
const SENT_WINDOW_MS = 24 * 60 * 60_000;
/** Au-delà, une rangée non terminale est un fossile — on arrête de sonder. */
const OUTBOUND_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Fenêtre de rattrapage des entrants perdus. */
const INBOUND_LOOKBACK_MS = 48 * 60 * 60_000;
/** Un entrant plus vieux que ça ne déclenche plus de réponse automatique. */
const INBOUND_FRESH_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/**
 * Budget de temps du BALAYAGE ENTIER — la réconciliation tourne AVANT la
 * réclamation des jobs : sans plafond propre, un Twilio dégradé (20 relectures
 * × 10 s) mangeait le budget du cycle et affamait la file qu'elle est censée
 * protéger.
 */
const SWEEP_BUDGET_MS = 30_000;
/** Pages Twilio suivies par numéro — 50 × 4 = 200 entrants par fenêtre. */
const MAX_LIST_PAGES = 4;

const messageResourceSchema = z.object({
  sid: z.string(),
  status: z.string(),
  error_code: z.number().int().nullable().optional(),
  to: z.string().nullable().optional(),
});

const messageListSchema = z.object({
  next_page_uri: z.string().nullable().optional(),
  messages: z.array(
    z.object({
      sid: z.string(),
      direction: z.string(),
      from: z.string().nullable().optional(),
      to: z.string().nullable().optional(),
      body: z.string().nullable().optional(),
      date_sent: z.string().nullable().optional(),
      date_created: z.string().nullable().optional(),
    }),
  ),
});

export interface ReconcileCounts {
  /** Rangées sortantes relues chez Twilio. */
  checked: number;
  /** Statuts réellement avancés. */
  advanced: number;
  /** Messages entrants rejoués (absents de la base). */
  backfilled: number;
}

const ZERO: ReconcileCounts = { checked: 0, advanced: 0, backfilled: 0 };

export async function reconcileTwilioMessages(
  now: () => Date = () => new Date(),
  opts: { fetchFn?: typeof fetch } = {},
): Promise<ReconcileCounts> {
  const auth = getTwilioRestAuth();
  if (!auth) return ZERO;
  const fetchFn = opts.fetchFn ?? fetch;
  const headers = { Authorization: twilioBasicAuth(auth) };
  const base = `https://api.twilio.com/2010-04-01/Accounts/${auth.accountSid}`;
  const counts: ReconcileCounts = { checked: 0, advanced: 0, backfilled: 0 };
  const startedAt = now().getTime();
  const sweepStarted = Date.now();
  const outOfTime = () => Date.now() - sweepStarted > SWEEP_BUDGET_MS;

  // ── 1. Sortant : avancer les statuts bloqués ─────────────────────────────
  const stuck = await db
    .select({ sid: messages.twilioSid, status: messages.status })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "out"),
        isNotNull(messages.twilioSid),
        lt(messages.createdAt, new Date(startedAt - OUTBOUND_MIN_AGE_MS)),
        gt(messages.createdAt, new Date(startedAt - OUTBOUND_MAX_AGE_MS)),
        or(
          inArray(messages.status, ["queued", "sending", "accepted"]),
          and(eq(messages.status, "sent"), gt(messages.createdAt, new Date(startedAt - SENT_WINDOW_MS))),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(OUTBOUND_BATCH);

  for (const row of stuck) {
    if (!row.sid || outOfTime()) continue;
    try {
      const res = await fetchFn(`${base}/Messages/${encodeURIComponent(row.sid)}.json`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404) {
        // Sid inconnu chez Twilio (environnement croisé, message purgé) : il
        // ne se résoudra JAMAIS. Le laisser éligible bloquait la tête du lot
        // asc(createdAt) pendant 7 jours — on le règle « unknown » et on passe.
        await db
          .update(messages)
          .set({ status: "unknown", skipReason: "twilio_message_not_found" })
          .where(eq(messages.twilioSid, row.sid));
        counts.checked += 1;
        continue;
      }
      if (!res.ok) continue;
      const parsed = messageResourceSchema.safeParse(await res.json());
      if (!parsed.success) continue;
      counts.checked += 1;
      const outcome = await recordDeliveryOutcome({
        sid: parsed.data.sid,
        status: parsed.data.status,
        errorCode: parsed.data.error_code ?? undefined,
        to: parsed.data.to ?? null,
      });
      if (outcome.advanced) counts.advanced += 1;
    } catch {
      // Réseau ou délai : l'item suivant a sa chance, le cycle suivant aussi.
    }
  }

  // ── 2. Entrant : rejouer ce que le webhook n'a pas pu recevoir ───────────
  const numbers = await db.select({ e164: smsNumbers.e164 }).from(smsNumbers);
  const sinceDay = new Date(startedAt - INBOUND_LOOKBACK_MS).toISOString().slice(0, 10);

  for (const number of numbers) {
    if (counts.backfilled >= INBOUND_BATCH || outOfTime()) break;
    // Twilio liste du plus récent au plus ancien : une seule page aurait rendu
    // invisibles pour toujours les réponses au-delà des 50 dernières — on suit
    // next_page_uri jusqu'à couvrir la fenêtre (borné), et on JOURNALISE si on
    // tronque : un plafond silencieux se lit comme « tout est rattrapé ».
    const items: z.infer<typeof messageListSchema>["messages"] = [];
    try {
      const query = new URLSearchParams({ To: number.e164, PageSize: "50" });
      query.set("DateSent>", sinceDay);
      let pageUrl: string | null = `${base}/Messages.json?${query.toString()}`;
      for (let page = 0; pageUrl !== null && page < MAX_LIST_PAGES && !outOfTime(); page += 1) {
        const res = await fetchFn(pageUrl, {
          headers,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) break;
        const parsed = messageListSchema.safeParse(await res.json());
        if (!parsed.success) break;
        items.push(...parsed.data.messages.filter((m) => m.direction === "inbound"));
        const nextUri = parsed.data.next_page_uri ?? null;
        pageUrl = nextUri ? `https://api.twilio.com${nextUri}` : null;
        if (pageUrl !== null && page === MAX_LIST_PAGES - 1) {
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "warn",
              msg: "sms.inbound_backfill_truncated",
              number: `…${number.e164.slice(-4)}`,
              pagesFollowed: MAX_LIST_PAGES,
            }),
          );
        }
      }
    } catch {
      continue;
    }
    if (items.length === 0) continue;

    const sids = items.map((m) => m.sid);
    const known = new Set(
      (
        await db
          .select({ sid: messages.twilioSid })
          .from(messages)
          .where(inArray(messages.twilioSid, sids))
      ).map((r) => r.sid),
    );
    // Un entrant déjà tranché « sans fiche » ou « numéro inexploitable » ne
    // sera pas plus exploitable au prochain cycle : sans cette garde, le même
    // sid serait rejoué chaque minute pendant 48 h — une rangée d'audit par
    // tentative. Même politique que Twilio : quelques essais, puis on cesse.
    const settled = new Set(
      (
        await db
          .select({ sid: sql<string>`${auditLogs.detail}->>'messageSid'` })
          .from(auditLogs)
          .where(
            and(
              inArray(auditLogs.action, ["sms.inbound_unmatched", "sms.inbound_invalid"]),
              inArray(sql`${auditLogs.detail}->>'messageSid'`, sids),
            ),
          )
      ).map((r) => r.sid),
    );

    for (const item of items) {
      if (counts.backfilled >= INBOUND_BATCH) break;
      if (known.has(item.sid) || settled.has(item.sid) || !item.from) continue;
      const receivedAt = parseTwilioDate(item.date_sent ?? item.date_created);
      try {
        const result = await processInboundSms({
          messageSid: item.sid,
          from: item.from,
          to: number.e164,
          body: item.body ?? "",
          receivedAt: receivedAt ?? undefined,
          allowAgentTurn:
            receivedAt !== null && startedAt - receivedAt.getTime() < INBOUND_FRESH_MS,
        });
        if (result.outcome === "processed" && result.inserted) {
          counts.backfilled += 1;
          console.log(
            JSON.stringify({
              ts: new Date().toISOString(),
              level: "warn",
              msg: "sms.inbound_backfilled",
              messageSid: item.sid,
              receivedAt: receivedAt?.toISOString() ?? null,
            }),
          );
        }
      } catch (err) {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            msg: "sms.inbound_backfill_failed",
            messageSid: item.sid,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  return counts;
}

/** Dates Twilio : RFC 2822 (« Mon, 24 Aug 2026 21:48:49 +0000 »). */
function parseTwilioDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
