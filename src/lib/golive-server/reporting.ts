import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentTurnTraces,
  assistants,
  campaignEnrollments,
  campaigns,

  messages,
  suppressions,
} from "@/db/schema-sms";

/**
 * Bilan du moteur SMS.
 *
 * Trois principes, tous appris ailleurs dans ce dépôt :
 *
 *  · **Les désabonnements sont affichés À CÔTÉ des réponses, jamais séparément.**
 *    Un bon taux de réponse avec beaucoup de désabonnements n'est pas un
 *    succès, et présenter les deux sur deux écrans laisse conclure l'inverse.
 *  · **Ce qui n'est pas parti compte autant que ce qui est parti.** Un envoi en
 *    échec ressemble à un succès tant qu'on ne l'affiche pas.
 *  · **Le coût vient des traces, jamais d'une estimation maison.** Un montant
 *    calculé ressemblerait à une facture sans en être une.
 */

export interface EngineSummary {
  sinceDays: number;
  outbound: number;
  delivered: number;
  failed: number;
  inbound: number;
  /** Conversations distinctes ayant reçu au moins une réponse du client. */
  conversationsWithReply: number;
  conversationsTouched: number;
  optOuts: number;
  handoffs: number;
  blockedDrafts: number;
  agentTurns: number;
  costUsd: number;
  suppressedTotal: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function engineSummary(sinceDays = 30, now = new Date()): Promise<EngineSummary> {
  const since = new Date(now.getTime() - sinceDays * DAY_MS);

  const [msg] = await db
    .select({
      outbound: sql<number>`(count(*) filter (where ${messages.direction} = 'out'))::int`,
      // « delivered » vient du rappel de statut Twilio ; « sent » seul veut dire
      // accepté par l'opérateur, pas remis.
      delivered: sql<number>`(count(*) filter (where ${messages.status} = 'delivered'))::int`,
      failed: sql<number>`(count(*) filter (where ${messages.status} in ('failed','undelivered')))::int`,
      inbound: sql<number>`(count(*) filter (where ${messages.direction} = 'in'))::int`,
      touched: sql<number>`count(distinct ${messages.conversationId})::int`,
      replied: sql<number>`count(distinct ${messages.conversationId}) filter (where ${messages.direction} = 'in')::int`,
    })
    .from(messages)
    .where(gte(messages.createdAt, since));

  const [trace] = await db
    .select({
      turns: sql<number>`count(*)::int`,
      handoffs: sql<number>`(count(*) filter (where ${agentTurnTraces.outcome} = 'handoff'))::int`,
      blocked: sql<number>`(count(*) filter (where ${agentTurnTraces.outcome} = 'blocked'))::int`,
      cost: sql<number>`coalesce(sum(${agentTurnTraces.costUsd}), 0)::float8`,
    })
    .from(agentTurnTraces)
    .where(gte(agentTurnTraces.createdAt, since));

  const [optOut] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(and(gte(suppressions.createdAt, since), eq(suppressions.reason, "sms_stop")));

  const [suppressed] = await db.select({ n: sql<number>`count(*)::int` }).from(suppressions);

  return {
    sinceDays,
    outbound: msg?.outbound ?? 0,
    delivered: msg?.delivered ?? 0,
    failed: msg?.failed ?? 0,
    inbound: msg?.inbound ?? 0,
    conversationsWithReply: msg?.replied ?? 0,
    conversationsTouched: msg?.touched ?? 0,
    optOuts: optOut?.n ?? 0,
    handoffs: trace?.handoffs ?? 0,
    blockedDrafts: trace?.blocked ?? 0,
    agentTurns: trace?.turns ?? 0,
    costUsd: trace?.cost ?? 0,
    suppressedTotal: suppressed?.n ?? 0,
  };
}

export interface AssistantRow {
  id: string;
  name: string;
  status: string;
  turns: number;
  sent: number;
  blocked: number;
  handoffs: number;
  costUsd: number;
}

export async function perAssistant(sinceDays = 30, now = new Date()): Promise<AssistantRow[]> {
  const since = new Date(now.getTime() - sinceDays * DAY_MS);
  const rows = await db
    .select({
      id: assistants.id,
      name: assistants.name,
      status: assistants.status,
      turns: sql<number>`(count(${agentTurnTraces.id}))::int`,
      sent: sql<number>`(count(*) filter (where ${agentTurnTraces.outcome} = 'sent'))::int`,
      blocked: sql<number>`(count(*) filter (where ${agentTurnTraces.outcome} = 'blocked'))::int`,
      handoffs: sql<number>`(count(*) filter (where ${agentTurnTraces.outcome} = 'handoff'))::int`,
      cost: sql<number>`coalesce(sum(${agentTurnTraces.costUsd}), 0)::float8`,
    })
    .from(assistants)
    .leftJoin(
      agentTurnTraces,
      and(eq(agentTurnTraces.assistantId, assistants.id), gte(agentTurnTraces.createdAt, since)),
    )
    .groupBy(assistants.id, assistants.name, assistants.status)
    .orderBy(sql`count(${agentTurnTraces.id}) desc`);

  return rows.map((r) => ({ ...r, costUsd: r.cost }));
}

export interface CampaignRow {
  id: string;
  name: string;
  status: string;
  enrolled: number;
  replied: number;
  booked: number;
  stopped: number;
  /** Réponses ÷ inscrits, en pourcentage. */
  replyRate: number;
  /** Arrêts ÷ inscrits — la contrepartie qu'on ne montre jamais séparément. */
  stopRate: number;
}

export async function perCampaign(): Promise<CampaignRow[]> {
  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      enrolled: sql<number>`(count(${campaignEnrollments.id}))::int`,
      replied: sql<number>`(count(*) filter (where ${campaignEnrollments.status} = 'replied'))::int`,
      booked: sql<number>`(count(*) filter (where ${campaignEnrollments.status} = 'booked'))::int`,
      stopped: sql<number>`(count(*) filter (where ${campaignEnrollments.status} = 'stopped'))::int`,
    })
    .from(campaigns)
    .leftJoin(campaignEnrollments, eq(campaignEnrollments.campaignId, campaigns.id))
    .groupBy(campaigns.id, campaigns.name, campaigns.status)
    .orderBy(sql`count(${campaignEnrollments.id}) desc`);

  return rows.map((r) => ({
    ...r,
    // Un taux sur zéro inscrit n'a pas de sens : on rend 0, pas NaN.
    replyRate: r.enrolled === 0 ? 0 : Math.round((r.replied / r.enrolled) * 100),
    stopRate: r.enrolled === 0 ? 0 : Math.round((r.stopped / r.enrolled) * 100),
  }));
}

