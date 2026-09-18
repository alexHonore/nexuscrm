import { and, gte, lt, sql } from "drizzle-orm";
import { followups } from "@/db/schema";

/** Typed predicates encode Date parameters through the timestamptz column. */
export function followupCountFields(now: Date, dayEnd: Date) {
  return {
    n: sql<number>`count(*)::int`,
    overdue: sql<number>`count(*) filter (where ${lt(followups.dueAt, now)})::int`,
    today: sql<number>`count(*) filter (where ${and(gte(followups.dueAt, now), lt(followups.dueAt, dayEnd))})::int`,
  };
}
