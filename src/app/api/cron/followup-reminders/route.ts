import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { followups, notifications } from "@/db/schema";
import { notificationContent } from "@/components/clients/notification-content";

/**
 * GET /api/cron/followup-reminders
 * Auth: Authorization: Bearer <CRON_SECRET> — 401 otherwise.
 *
 * For every OPEN follow-up due within the next 60 minutes or overdue for less
 * than 24 h, create a { type: "followup_due" } notification for the assignee —
 * unless an UNREAD one with the same (userId, type, link) already exists.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const windowStart = new Date(now - 24 * 60 * 60 * 1000); // overdue since < 24 h
  const windowEnd = new Date(now + 60 * 60 * 1000); // due within 60 min

  const due = await db.query.followups.findMany({
    where: and(
      isNull(followups.doneAt),
      gte(followups.dueAt, windowStart),
      lte(followups.dueAt, windowEnd),
    ),
    with: { client: true, assignedTo: true },
  });

  let created = 0;
  for (const followup of due) {
    if (!followup.assignedTo || !followup.assignedTo.isActive) continue;
    const link = `/clients/${followup.clientId}`;

    const existing = await db.query.notifications.findFirst({
      where: and(
        eq(notifications.userId, followup.assignedToId),
        eq(notifications.type, "followup_due"),
        eq(notifications.link, link),
        isNull(notifications.readAt),
      ),
    });
    if (existing) continue;

    await db.insert(notifications).values({
      userId: followup.assignedToId,
      type: "followup_due",
      title: notificationContent(followup.assignedTo.locale, "followupDueTitle", {
        client: followup.client?.fullName ?? "",
      }),
      body: followup.note,
      link,
    });
    created += 1;
  }

  return NextResponse.json({ scanned: due.length, created });
}
