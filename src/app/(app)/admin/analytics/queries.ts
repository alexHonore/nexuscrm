import "server-only";
import { and, asc, eq, gte, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appointments, calls, clients, users } from "@/db/schema";
import type { ActivityGrain, ActivityKind } from "@/components/analytics/activity";

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

// ── Activité : ce qu'on a fait, et quand ─────────────────────────────────────

/**
 * Le seul horodatage qu'un `sql` écrit à la main peut passer à Postgres.
 *
 * Les comparaisons bâties avec `gte`/`lt` traversent le mappeur de la colonne
 * et convertissent toutes seules ; en SQL brut il n'y a pas de colonne à
 * mapper, et un objet `Date` interpolé part en « [object Object] ».
 */
function ts(instant: Date): string {
  return instant.toISOString();
}

/**
 * Les SEPT sources d'un geste, rangées dans les cinq familles affichées.
 *
 * Deux familles agrègent deux tables — « notes » (un commentaire et un suivi
 * sont le même geste : écrire quelque chose sur une fiche) et « fiches » (créer
 * et modifier). L'addition se fait en SQL, dans le `sum(n)` du dehors.
 *
 * `user` est la colonne qui répond à « QUI a posé ce geste » — pas « à qui la
 * fiche appartient ». Une fiche créée par le webhook n'a personne : elle sort
 * donc du total dès qu'on filtre sur un téléphoniste, et c'est voulu.
 *
 * Ces noms de tables sont écrits à la main : c'est le prix d'une seule requête
 * plutôt que six. Un renommage dans `schema.ts` ne se verrait pas à la
 * compilation — `tests/int-analytics-activity.test.ts` est là pour ça.
 */
const ACTIVITY_SOURCES: {
  kind: ActivityKind;
  from: string;
  ts: string;
  user: string;
  extra?: string;
}[] = [
  { kind: "calls", from: "calls c", ts: "c.started_at", user: "c.user_id" },
  { kind: "bookings", from: "appointments a", ts: "a.created_at", user: "a.user_id" },
  {
    kind: "sms",
    from: "messages m join conversations cv on cv.id = m.conversation_id",
    ts: "m.created_at",
    user: "coalesce(m.sent_by_id, cv.assigned_to_id)",
    // Un sortant retenu (kill switch, suppression, plafond) n'est pas un texto
    // envoyé : il ne compte pas comme un geste. Les entrants comptent toujours.
    extra: "(m.direction = 'in' or m.skip_reason is null)",
  },
  { kind: "notes", from: "comments cm", ts: "cm.created_at", user: "cm.user_id" },
  { kind: "notes", from: "followups fu", ts: "fu.created_at", user: "fu.created_by_id" },
  { kind: "records", from: "clients cl", ts: "cl.created_at", user: "cl.created_by_id" },
  {
    kind: "records",
    from: "audit_logs al",
    ts: "al.created_at",
    user: "al.user_id",
    extra: "al.action in ('client.update', 'client.category', 'client.assign')",
  },
];

/** L'expression de regroupement — fuseau inline, jamais un paramètre lié. */
function bucketSql(col: string, grain: ActivityGrain, profile: boolean): string {
  const local = `(${col} at time zone 'America/Toronto')`;
  if (grain === "week") return `to_char(date_trunc('week', ${local}), 'YYYY-MM-DD')`;
  if (grain === "day") return `to_char(${local}, 'YYYY-MM-DD')`;
  return profile ? `to_char(${local}, 'HH24')` : `to_char(${local}, 'YYYY-MM-DD HH24')`;
}

export type ActivityBucket = { kind: ActivityKind; bucket: string; count: number };

/**
 * Le volume de gestes, par maille de temps et par famille.
 *
 * Une seule requête : sept sous-sélections déjà agrégées, réunies par
 * `union all`, ré-additionnées par famille. Sept allers-retours sur une page
 * qui en fait déjà six épuiseraient le pool bien avant d'être plus rapides.
 */
export async function getActivityBuckets(
  f: AnalyticsFilter,
  grain: ActivityGrain,
  profile: boolean,
): Promise<ActivityBucket[]> {
  const parts = ACTIVITY_SOURCES.map(
    (src) => sql`
      select ${sql.raw(`'${src.kind}'::text`)} as kind,
             ${sql.raw(bucketSql(src.ts, grain, profile))} as bucket,
             count(*)::int as n
        from ${sql.raw(src.from)}
       where ${sql.raw(src.ts)} >= ${ts(f.fromUtc)}::timestamptz
         and ${sql.raw(src.ts)} < ${ts(f.toUtcExclusive)}::timestamptz
         ${src.extra ? sql.raw(`and ${src.extra}`) : sql``}
         ${f.userId ? sql`and ${sql.raw(src.user)} = ${f.userId}::uuid` : sql``}
       group by 1, 2`,
  );

  const rows = await db.execute<{ kind: string; bucket: string; n: number | string }>(sql`
    select kind, bucket, sum(n)::int as n
      from (${sql.join(parts, sql` union all `)}) t
     group by kind, bucket`);

  // `db.execute` ne passe par aucun mappeur de colonne : un `::int` peut
  // revenir en texte selon le pilote. On normalise plutôt que de parier.
  return Array.from(rows).map((r) => ({
    kind: r.kind as ActivityKind,
    bucket: r.bucket,
    count: Number(r.n),
  }));
}
