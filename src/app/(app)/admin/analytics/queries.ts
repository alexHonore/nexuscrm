import "server-only";
import { and, asc, eq, gte, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appointments, calls, clients, users } from "@/db/schema";

/** Filtre commun : période [fromUtc, toUtcExclusive) + téléphoniste optionnel. */
export type AnalyticsFilter = {
  fromUtc: Date;
  toUtcExclusive: Date;
  userId?: string;
};

function callsWhere(f: AnalyticsFilter): SQL | undefined {
  const conds: SQL[] = [
    gte(calls.startedAt, f.fromUtc),
    lt(calls.startedAt, f.toUtcExclusive),
  ];
  if (f.userId) conds.push(eq(calls.userId, f.userId));
  return and(...conds);
}

function appointmentsWhere(f: AnalyticsFilter): SQL | undefined {
  const conds: SQL[] = [
    gte(appointments.createdAt, f.fromUtc),
    lt(appointments.createdAt, f.toUtcExclusive),
  ];
  if (f.userId) conds.push(eq(appointments.userId, f.userId));
  return and(...conds);
}

export type Kpis = {
  totalCalls: number;
  connectedCalls: number;
  totalSec: number;
  answeredSec: number;
  appointments: number;
  leads: number;
};

/** Tuiles KPI — agrégations SQL, aucune ligne chargée. */
export async function getKpis(f: AnalyticsFilter): Promise<Kpis> {
  const leadConds: SQL[] = [
    gte(clients.createdAt, f.fromUtc),
    lt(clients.createdAt, f.toUtcExclusive),
  ];
  if (f.userId) leadConds.push(eq(clients.assignedToId, f.userId));

  const [[row], rdv, leads] = await Promise.all([
    db
      .select({
        totalCalls: sql<number>`count(*)::int`,
        connectedCalls: sql<number>`(count(*) filter (where ${calls.answeredAt} is not null))::int`,
        totalSec: sql<number>`coalesce(sum(${calls.durationSec}), 0)::int`,
        answeredSec: sql<number>`coalesce(sum(${calls.durationSec}) filter (where ${calls.answeredAt} is not null), 0)::int`,
      })
      .from(calls)
      .where(callsWhere(f)),
    db.$count(appointments, appointmentsWhere(f)),
    db.$count(clients, and(...leadConds)),
  ]);

  return {
    totalCalls: row?.totalCalls ?? 0,
    connectedCalls: row?.connectedCalls ?? 0,
    totalSec: row?.totalSec ?? 0,
    answeredSec: row?.answeredSec ?? 0,
    appointments: rdv,
    leads,
  };
}

export type DayBucket = { day: string; answered: number; missed: number };

/** Appels par jour (Toronto) — connectés / non connectés. */
export async function getCallsPerDay(f: AnalyticsFilter): Promise<DayBucket[]> {
  // Fuseau inline (littéral SQL) : un paramètre lié rendrait l'expression du
  // GROUP BY différente de celle du SELECT ($1 vs $n) et Postgres la rejette.
  const dayExpr = sql<string>`to_char(${calls.startedAt} at time zone 'America/Toronto', 'YYYY-MM-DD')`;
  return db
    .select({
      day: dayExpr,
      answered: sql<number>`(count(*) filter (where ${calls.answeredAt} is not null))::int`,
      missed: sql<number>`(count(*) filter (where ${calls.answeredAt} is null))::int`,
    })
    .from(calls)
    .where(callsWhere(f))
    .groupBy(dayExpr)
    .orderBy(dayExpr);
}

export type WeekBucket = { weekStart: string; count: number };

/** RDV pris par semaine (lundi, Toronto). */
export async function getBookingsPerWeek(f: AnalyticsFilter): Promise<WeekBucket[]> {
  const weekExpr = sql<string>`to_char(date_trunc('week', ${appointments.createdAt} at time zone 'America/Toronto'), 'YYYY-MM-DD')`;
  return db
    .select({
      weekStart: weekExpr,
      count: sql<number>`count(*)::int`,
    })
    .from(appointments)
    .where(appointmentsWhere(f))
    .groupBy(weekExpr)
    .orderBy(weekExpr);
}

export type DispositionBucket = { disposition: string; count: number };

/** Répartition des dispositions (appels avec disposition seulement). */
export async function getDispositionBreakdown(
  f: AnalyticsFilter,
): Promise<DispositionBucket[]> {
  const where = and(callsWhere(f), isNotNull(calls.disposition));
  return db
    .select({
      disposition: sql<string>`${calls.disposition}`,
      count: sql<number>`count(*)::int`,
    })
    .from(calls)
    .where(where)
    .groupBy(calls.disposition)
    .orderBy(sql`count(*) desc`);
}

export type UserStats = {
  userId: string;
  name: string;
  calls: number;
  connected: number;
  totalSec: number;
  answeredSec: number;
  rdv: number;
};

/** Statistiques par téléphoniste (le tableau clé) — 2 requêtes agrégées, fusionnées. */
export async function getUserStats(f: AnalyticsFilter): Promise<UserStats[]> {
  const [callRows, rdvRows] = await Promise.all([
    db
      .select({
        userId: calls.userId,
        name: users.name,
        calls: sql<number>`count(*)::int`,
        connected: sql<number>`(count(*) filter (where ${calls.answeredAt} is not null))::int`,
        totalSec: sql<number>`coalesce(sum(${calls.durationSec}), 0)::int`,
        answeredSec: sql<number>`coalesce(sum(${calls.durationSec}) filter (where ${calls.answeredAt} is not null), 0)::int`,
      })
      .from(calls)
      .innerJoin(users, eq(users.id, calls.userId))
      .where(callsWhere(f))
      .groupBy(calls.userId, users.name)
      .orderBy(asc(users.name)),
    db
      .select({
        userId: appointments.userId,
        name: users.name,
        rdv: sql<number>`count(*)::int`,
      })
      .from(appointments)
      .innerJoin(users, eq(users.id, appointments.userId))
      .where(appointmentsWhere(f))
      .groupBy(appointments.userId, users.name),
  ]);

  const byUser = new Map<string, UserStats>();
  for (const r of callRows) {
    byUser.set(r.userId, { ...r, rdv: 0 });
  }
  for (const r of rdvRows) {
    const existing = byUser.get(r.userId);
    if (existing) existing.rdv = r.rdv;
    else
      byUser.set(r.userId, {
        userId: r.userId,
        name: r.name,
        calls: 0,
        connected: 0,
        totalSec: 0,
        answeredSec: 0,
        rdv: r.rdv,
      });
  }
  return [...byUser.values()];
}

export type UserOption = { id: string; name: string };

/** Liste des utilisateurs pour le filtre. */
export async function getUserOptions(): Promise<UserOption[]> {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .orderBy(asc(users.name));
}
