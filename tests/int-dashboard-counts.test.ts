import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { clients, followups } from "@/db/schema";
import { torontoDayRange } from "@/components/clients/timezone";
import { followupCountFields } from "@/app/(app)/dashboard/followup-counts";
import { closeDb, makeClient, makeUser, resetDb, testDb } from "./helpers/db";

afterAll(closeDb);
beforeEach(resetDb);

describe("dashboard follow-up aggregates", () => {
  it("executes Date parameters through Postgres and respects both bucket boundaries", async () => {
    // The fall-back day has 25 hours: today's end must still be Toronto midnight.
    const now = new Date("2026-11-01T05:30:00.000Z");
    const { end } = torontoDayRange(now);
    const user = await makeUser();
    const visible = await makeClient({ assignedToId: user.id });
    const outsideScope = await makeClient();

    await testDb.insert(followups).values([
      { clientId: visible.id, assignedToId: user.id, dueAt: new Date(now.getTime() - 1) },
      { clientId: visible.id, assignedToId: user.id, dueAt: now },
      { clientId: visible.id, assignedToId: user.id, dueAt: new Date(end.getTime() - 1) },
      { clientId: visible.id, assignedToId: user.id, dueAt: end },
      { clientId: visible.id, assignedToId: user.id, dueAt: now, doneAt: now },
      { clientId: outsideScope.id, assignedToId: user.id, dueAt: now },
    ]);

    // Execute the same aggregate fields as the page. Raw Date interpolation
    // passes TypeScript but fails here inside the postgres-js serializer.
    const [counts] = await testDb
      .select(followupCountFields(now, end))
      .from(followups)
      .innerJoin(clients, eq(clients.id, followups.clientId))
      .where(and(eq(clients.assignedToId, user.id), isNull(followups.doneAt)));

    expect(counts).toEqual({ n: 4, overdue: 1, today: 2 });
  });

  it("returns numeric zeroes for an empty visible queue", async () => {
    const now = new Date("2026-09-18T14:00:00.000Z");
    const [counts] = await testDb
      .select(followupCountFields(now, torontoDayRange(now).end))
      .from(followups);
    expect(counts).toEqual({ n: 0, overdue: 0, today: 0 });
  });
});
