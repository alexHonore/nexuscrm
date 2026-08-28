import "server-only";
import { and, gte, lt, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { agentTurnTraces, callTranscripts, messages } from "@/db/schema-sms";
import { dayStartUtc, listDays, shiftDateStr } from "@/components/analytics/period";
import { getOpenRouterAccountUsage } from "@/lib/llm-server/openrouter-usage";
import { getSetting } from "@/lib/settings";
import {
  getTwilioBalance,
  getTwilioDailySmsUsage,
  getTwilioSmsCost,
} from "@/lib/sms-server/twilio-usage";

/**
 * Consommation IA et SMS sur une période — depuis la BASE (rapide), à côté de
 * la dépense téléphonique voip.ms (`telephony-usage.ts`, lente, via l'API).
 *
 * Deux natures de chiffre, et la distinction est honnête :
 *
 *  · **IA : coût RÉEL.** Chaque tour d'assistant enregistre le coût facturé
 *    par OpenRouter (`usage.cost` demandé à chaque appel) et ses jetons — le
 *    TOUR entier depuis le 2026-08-26 : générations, classifieur, juges,
 *    régénérations, repli. On somme, on ne recalcule pas. En regard, la
 *    dépense à VIE du compte OpenRouter (API /credits) sert d'ancre : les
 *    tours antérieurs au correctif sous-comptaient (~1/8 du réel constaté).
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

export type TranscriptModelUsage = {
  model: string;
  calls: number;
  audioSeconds: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

/**
 * Un jour de dépense, borné à MINUIT HEURE DE TORONTO — le même découpage que
 * l'analytique et que le journal d'appels. Les journées Twilio, elles, sont
 * bornées en GMT : c'est pourquoi elles voyagent dans leur propre type
 * (`SmsDailyCost`) et que l'écran l'annonce sous le graphique.
 */
export type DailyPoint = { date: string; costUsd: number };

/** Volume SMS d'un jour Toronto — un COMPTE, jamais converti en argent ici. */
export type SmsDailyVolume = {
  date: string;
  outboundMessages: number;
  outboundSegments: number;
  inboundMessages: number;
  inboundSegments: number;
};

/** Dépense SMS d'une journée **GMT** telle que Twilio la facture. */
export type SmsDailyCost = { date: string; costUsd: number; messages: number };

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
    /** Coût par jour Toronto, trous remplis à 0 — la courbe de la période. */
    daily: DailyPoint[];
    /** L'ancre : dépense à vie et crédits du COMPTE OpenRouter, ou null si indisponible. */
    account: { totalUsageUsd: number; totalCreditsUsd: number } | null;
  };
  sms: {
    outboundMessages: number;
    outboundSegments: number;
    inboundMessages: number;
    inboundSegments: number;
    /** Taux d'ESTIMATION appliqué (dollars US par segment) — le repli. */
    segmentCostUsd: number;
    /** ESTIMATION : (segments sortants + entrants) × taux. */
    estimatedCostUsd: number;
    /** Coût RÉEL facturé par Twilio (Usage Records), ou null si indisponible. */
    realCostUsd: number | null;
    /** D'où vient `costUsd` : « twilio » (réel) ou « estimate » (segments × taux). */
    costSource: "twilio" | "estimate";
    /** Le coût à AFFICHER : le réel de Twilio quand on l'a, sinon l'estimation. */
    costUsd: number;
    /**
     * Frais de transporteur facturés par Twilio sur la période
     * (`sms-messages-carrierfees`). La catégorie `sms` NE LES CONTIENT PAS :
     * les fondre dans `costUsd` changerait en silence un chiffre déjà lu, donc
     * ils restent une ligne à part — visible, additionnée dans le total de la
     * page. `null` = Twilio n'a pas répondu (jamais 0 par défaut).
     */
    carrierFeesUsd: number | null;
    /** Volume par jour TORONTO (segments et messages) — un compte, pas un montant. */
    dailyVolume: SmsDailyVolume[];
    /**
     * Dépense par jour **GMT** (Twilio), trous remplis à 0 ; `null` si Twilio
     * n'a pas répondu — l'écran affiche alors « indisponible », pas une bande
     * plate à zéro.
     */
    dailyCost: SmsDailyCost[] | null;
    /**
     * Solde du COMPTE Twilio — l'ancre du fournisseur. Le signe est conservé
     * (un solde négatif est justement ce qu'il faut voir). `null` = indisponible.
     */
    balance: { balanceUsd: number; currency: string } | null;
  };
  /** Notes d'appel IA — coût RÉEL (usage.cost d'OpenRouter), comme l'IA SMS. */
  transcripts: {
    /** Appels résumés (rangées `done`). */
    calls: number;
    audioSeconds: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    failed: number;
    skipped: number;
    byModel: TranscriptModelUsage[];
    /** Coût par jour Toronto, trous remplis à 0. */
    daily: DailyPoint[];
  };
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * L'expression de jour TORONTO, en littéral SQL inline.
 *
 * Le fuseau ne peut pas être un paramètre lié : l'expression du `GROUP BY`
 * deviendrait différente de celle du `SELECT` ($1 vs $n) et Postgres la
 * rejette. Même mécanique que l'analytique.
 */
const dayExpr = (col: AnyPgColumn) =>
  sql<string>`to_char(${col} at time zone 'America/Toronto', 'YYYY-MM-DD')`;

/**
 * Remplit les jours manquants à 0 sur toute la période.
 *
 * Sans ça, l'axe du temps saute les journées creuses et un graphique de
 * dépense se lit comme s'il n'y avait pas eu de jour du tout. Une absence de
 * ligne veut dire « aucune dépense » — pas « on ne sait pas » : les sources
 * injoignables sont signalées ailleurs par un `null`, jamais par un trou.
 */
function fillDays<T extends { date: string }>(
  from: string,
  to: string,
  rows: T[],
  empty: (date: string) => T,
): T[] {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  return listDays(from, to).map((date) => byDate.get(date) ?? empty(date));
}

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

  const aiDayExpr = dayExpr(agentTurnTraces.createdAt);
  const aiDailyRows = await db
    .select({
      date: aiDayExpr,
      costUsd: sql<string>`coalesce(sum(${agentTurnTraces.costUsd}), 0)`,
    })
    .from(agentTurnTraces)
    .where(and(gte(agentTurnTraces.createdAt, start), lt(agentTurnTraces.createdAt, end)))
    .groupBy(aiDayExpr)
    .orderBy(aiDayExpr);

  const aiTotals = {
    turns: byModel.reduce((s, m) => s + m.turns, 0),
    tokensIn: byModel.reduce((s, m) => s + m.tokensIn, 0),
    tokensOut: byModel.reduce((s, m) => s + m.tokensOut, 0),
    costUsd: byModel.reduce((s, m) => s + m.costUsd, 0),
    byModel,
    daily: fillDays(
      from,
      to,
      aiDailyRows.map((r) => ({ date: r.date, costUsd: num(r.costUsd) })),
      (date) => ({ date, costUsd: 0 }),
    ),
  };

  // ── Notes d'appel IA : par modèle, coût et jetons réels ────────────────────
  // Les rangées `failed`/`skipped` comptent séparément (aucun coût la plupart
  // du temps, mais leurs jetons/coûts éventuels sont sommés quand même : un
  // échec APRÈS l'appel au modèle a bel et bien été facturé).
  const trRows = await db
    .select({
      model: sql<string>`coalesce(${callTranscripts.modelServed}, ${callTranscripts.modelRequested})`,
      calls: sql<number>`count(*) filter (where ${callTranscripts.status} = 'done')::int`,
      failed: sql<number>`count(*) filter (where ${callTranscripts.status} = 'failed')::int`,
      skipped: sql<number>`count(*) filter (where ${callTranscripts.status} = 'skipped')::int`,
      audioSeconds: sql<string>`coalesce(sum(${callTranscripts.audioSeconds}) filter (where ${callTranscripts.status} = 'done'), 0)`,
      tokensIn: sql<string>`coalesce(sum(${callTranscripts.tokensIn}), 0)`,
      tokensOut: sql<string>`coalesce(sum(${callTranscripts.tokensOut}), 0)`,
      costUsd: sql<string>`coalesce(sum(${callTranscripts.costUsd}), 0)`,
    })
    .from(callTranscripts)
    .where(and(gte(callTranscripts.createdAt, start), lt(callTranscripts.createdAt, end)))
    .groupBy(sql`1`);

  const trByModel: TranscriptModelUsage[] = trRows
    .filter((r) => num(r.calls) > 0 || num(r.costUsd) > 0)
    .map((r) => ({
      model: r.model || "—",
      calls: num(r.calls),
      audioSeconds: num(r.audioSeconds),
      tokensIn: num(r.tokensIn),
      tokensOut: num(r.tokensOut),
      costUsd: num(r.costUsd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  const trDayExpr = dayExpr(callTranscripts.createdAt);
  const trDailyRows = await db
    .select({
      date: trDayExpr,
      costUsd: sql<string>`coalesce(sum(${callTranscripts.costUsd}), 0)`,
    })
    .from(callTranscripts)
    .where(and(gte(callTranscripts.createdAt, start), lt(callTranscripts.createdAt, end)))
    .groupBy(trDayExpr)
    .orderBy(trDayExpr);

  const transcripts = {
    calls: trByModel.reduce((s, m) => s + m.calls, 0),
    audioSeconds: trByModel.reduce((s, m) => s + m.audioSeconds, 0),
    tokensIn: trRows.reduce((s, r) => s + num(r.tokensIn), 0),
    tokensOut: trRows.reduce((s, r) => s + num(r.tokensOut), 0),
    costUsd: trRows.reduce((s, r) => s + num(r.costUsd), 0),
    failed: trRows.reduce((s, r) => s + num(r.failed), 0),
    skipped: trRows.reduce((s, r) => s + num(r.skipped), 0),
    byModel: trByModel,
    daily: fillDays(
      from,
      to,
      trDailyRows.map((r) => ({ date: r.date, costUsd: num(r.costUsd) })),
      (date) => ({ date, costUsd: 0 }),
    ),
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
  const estimatedCostUsd = (outboundSegments + inboundSegments) * smsSegmentCostUsd;

  // Volume par jour TORONTO — un COMPTE (segments, messages), jamais un montant :
  // segments × taux serait une estimation déguisée en facture.
  const smsDayExpr = dayExpr(messages.createdAt);
  const smsDailyRows = await db
    .select({
      date: smsDayExpr,
      outMsgs: sql<number>`count(*) filter (where ${messages.direction} = 'out' and ${messages.twilioSid} is not null)::int`,
      outSeg: sql<string>`coalesce(sum(${messages.segments}) filter (where ${messages.direction} = 'out' and ${messages.twilioSid} is not null), 0)`,
      inMsgs: sql<number>`count(*) filter (where ${messages.direction} = 'in')::int`,
      inSeg: sql<string>`coalesce(sum(${messages.segments}) filter (where ${messages.direction} = 'in'), 0)`,
    })
    .from(messages)
    .where(and(gte(messages.createdAt, start), lt(messages.createdAt, end)))
    .groupBy(smsDayExpr)
    .orderBy(smsDayExpr);

  // TOUTES les lectures réseau partent ENSEMBLE : chacune peut échouer seule,
  // aucune ne doit retarder les autres, et cette route reste rapide (l'écran
  // distingue déjà « indisponible » de « zéro », source par source).
  //
  // On préfère TOUJOURS le coût réel ; l'estimation n'est qu'un repli quand
  // Twilio n'est pas configuré ou injoignable. L'ancre du compte OpenRouter,
  // elle, est la seule dépense IA qui ne dépende pas de notre propre comptage.
  const [real, dailySms, dailyFees, balance, account] = await Promise.all([
    getTwilioSmsCost(from, to),
    getTwilioDailySmsUsage(from, to, "sms"),
    getTwilioDailySmsUsage(from, to, "sms-messages-carrierfees"),
    getTwilioBalance(),
    getOpenRouterAccountUsage(),
  ]);

  // Les frais de transporteur sont une catégorie DISTINCTE : `sms` ne les
  // contient pas. On les somme depuis leurs journées plutôt que de payer un
  // aller-retour de plus.
  const carrierFeesUsd = dailyFees ? dailyFees.reduce((acc, d) => acc + d.costUsd, 0) : null;

  // Jour GMT : `sms` et les frais, additionnés par journée Twilio.
  //
  // Il faut les DEUX catégories. Une série bâtie sur les seuls messages serait
  // courte des frais sans le dire — et comme l'écran s'en sert aussi pour le
  // montant de la période, elle ferait rentrer par la fenêtre le « chiffre
  // inconnu compté comme zéro » qu'on refuse partout ailleurs.
  const dailyCost =
    dailySms && dailyFees
      ? (() => {
          const byDate = new Map<string, { costUsd: number; messages: number }>();
          // Le COÛT additionne messages + frais ; le NOMBRE de messages ne vient
          // que de la catégorie `sms` — la catégorie des frais n'en compte pas,
          // et l'additionner gonflerait le compte si Twilio y mettait autre chose.
          for (const row of dailySms) {
            const cur = byDate.get(row.date) ?? { costUsd: 0, messages: 0 };
            byDate.set(row.date, {
              costUsd: cur.costUsd + row.costUsd,
              messages: cur.messages + row.messages,
            });
          }
          for (const row of dailyFees) {
            const cur = byDate.get(row.date) ?? { costUsd: 0, messages: 0 };
            byDate.set(row.date, {
              costUsd: cur.costUsd + row.costUsd,
              messages: cur.messages,
            });
          }
          return fillDays(
            from,
            to,
            [...byDate].map(([date, v]) => ({ date, ...v })),
            (date) => ({ date, costUsd: 0, messages: 0 }),
          );
        })()
      : null;

  const sms = {
    outboundMessages: num(smsRow?.outMsgs),
    outboundSegments,
    inboundMessages: num(smsRow?.inMsgs),
    inboundSegments,
    segmentCostUsd: smsSegmentCostUsd,
    estimatedCostUsd,
    realCostUsd: real ? real.costUsd : null,
    costSource: real ? ("twilio" as const) : ("estimate" as const),
    costUsd: real ? real.costUsd : estimatedCostUsd,
    carrierFeesUsd,
    dailyVolume: fillDays(
      from,
      to,
      smsDailyRows.map((r) => ({
        date: r.date,
        outboundMessages: num(r.outMsgs),
        outboundSegments: num(r.outSeg),
        inboundMessages: num(r.inMsgs),
        inboundSegments: num(r.inSeg),
      })),
      (date) => ({
        date,
        outboundMessages: 0,
        outboundSegments: 0,
        inboundMessages: 0,
        inboundSegments: 0,
      }),
    ),
    dailyCost,
    balance: balance ? { balanceUsd: balance.balanceUsd, currency: balance.currency } : null,
  };

  return { from, to, ai: { ...aiTotals, account }, sms, transcripts };
}
