import "server-only";
import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentTurnTraces, messages } from "@/db/schema-sms";
import { dayStartUtc, shiftDateStr } from "@/components/analytics/period";
import { getSetting } from "@/lib/settings";

/**
 * Consommation IA et SMS sur une période — depuis la BASE (rapide), à côté de
 * la dépense téléphonique voip.ms (`telephony-usage.ts`, lente, via l'API).
 *
 * Deux natures de chiffre, et la distinction est honnête :
 *
 *  · **IA : coût RÉEL.** Chaque tour d'assistant enregistre son coût
 *    (`agent_turn_traces.cost_usd`, calculé d'après la tarification du modèle)
 *    et ses jetons. On somme, on ne recalcule pas.
 *  · **SMS : coût ESTIMÉ.** Twilio ne nous donne pas le prix par message ; on
 *    compte les SEGMENTS (l'unité facturée, elle, réelle) et on multiplie par
 *    un taux réglé par l'admin (`consumption.smsSegmentCostUsd`). L'UI doit le
 *    présenter comme une estimation, jamais comme une facture.
 */

export type AiModelUsage = {
  model: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type ConsumptionReport = {
  from: string;
  to: string;
  ai: {
    turns: number;
    tokensIn: number;
    tokensOut: number;
    /** Coût RÉEL, sommé des traces de tour. */
    costUsd: number;
    byModel: AiModelUsage[];
  };
  sms: {
    outboundMessages: number;
    outboundSegments: number;
    inboundMessages: number;
    inboundSegments: number;
    /** Taux appliqué (dollars US par segment). */
    segmentCostUsd: number;
    /** ESTIMATION : (segments sortants + entrants) × taux. */
    estimatedCostUsd: number;
  };
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Agrège la consommation IA et SMS entre deux dates YYYY-MM-DD (heure de
 * Toronto). Période [from 00:00, lendemain de to 00:00) — bornes de jour
 * Toronto, comme l'analytique et le CDR.
 */
export async function getConsumption(from: string, to: string): Promise<ConsumptionReport> {
  const start = dayStartUtc(from);
  const end = dayStartUtc(shiftDateStr(to, 1)); // exclusif : lendemain du dernier jour
  const { smsSegmentCostUsd } = await getSetting("consumption");

  // ── IA : par modèle, coût et jetons réels ──────────────────────────────────
  const aiRows = await db
    .select({
      model: sql<string>`coalesce(${agentTurnTraces.modelServed}, ${agentTurnTraces.modelRequested})`,
      turns: sql<number>`count(*)::int`,
      tokensIn: sql<string>`coalesce(sum(${agentTurnTraces.tokensIn}), 0)`,
      tokensOut: sql<string>`coalesce(sum(${agentTurnTraces.tokensOut}), 0)`,
      costUsd: sql<string>`coalesce(sum(${agentTurnTraces.costUsd}), 0)`,
    })
    .from(agentTurnTraces)
    .where(and(gte(agentTurnTraces.createdAt, start), lt(agentTurnTraces.createdAt, end)))
    .groupBy(sql`1`);

  const byModel: AiModelUsage[] = aiRows
    .map((r) => ({
      model: r.model || "—",
      turns: num(r.turns),
      tokensIn: num(r.tokensIn),
      tokensOut: num(r.tokensOut),
      costUsd: num(r.costUsd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns);

  const ai = {
    turns: byModel.reduce((s, m) => s + m.turns, 0),
    tokensIn: byModel.reduce((s, m) => s + m.tokensIn, 0),
    tokensOut: byModel.reduce((s, m) => s + m.tokensOut, 0),
    costUsd: byModel.reduce((s, m) => s + m.costUsd, 0),
    byModel,
  };

  // ── SMS : segments comptés (unité facturée), en une passe ───────────────────
  // Sortants : seulement ceux réellement partis chez Twilio (twilio_sid posé) —
  // un message « sauté » ou « échoué » avant l'envoi n'est pas facturé.
  const [smsRow] = await db
    .select({
      outMsgs: sql<number>`count(*) filter (where ${messages.direction} = 'out' and ${messages.twilioSid} is not null)::int`,
      outSeg: sql<string>`coalesce(sum(${messages.segments}) filter (where ${messages.direction} = 'out' and ${messages.twilioSid} is not null), 0)`,
      inMsgs: sql<number>`count(*) filter (where ${messages.direction} = 'in')::int`,
      inSeg: sql<string>`coalesce(sum(${messages.segments}) filter (where ${messages.direction} = 'in'), 0)`,
    })
    .from(messages)
    .where(and(gte(messages.createdAt, start), lt(messages.createdAt, end)));

  const outboundSegments = num(smsRow?.outSeg);
  const inboundSegments = num(smsRow?.inSeg);
  const sms = {
    outboundMessages: num(smsRow?.outMsgs),
    outboundSegments,
    inboundMessages: num(smsRow?.inMsgs),
    inboundSegments,
    segmentCostUsd: smsSegmentCostUsd,
    estimatedCostUsd: (outboundSegments + inboundSegments) * smsSegmentCostUsd,
  };

  return { from, to, ai, sms };
}
