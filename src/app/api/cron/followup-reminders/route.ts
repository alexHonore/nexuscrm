import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { followups, notifications } from "@/db/schema";
import { notificationContent } from "@/components/clients/notification-content";
import { isCronAuthorized } from "@/lib/cron-auth";

/** Un suivi entre dans sa fenêtre de rappel 60 min avant l'échéance. */
const REMINDER_LEAD_MS = 60 * 60 * 1000;

/**
 * GET /api/cron/followup-reminders
 * Auth: Authorization: Bearer <CRON_SECRET> — 401 otherwise.
 *
 * For every OPEN follow-up due within the next 60 minutes or overdue for less
 * than 24 h, create a { type: "followup_due" } notification for the assignee —
 * unless one with the same (userId, type, link) was already created since the
 * follow-up entered its reminder window (dueAt − 1 h), read or not.
 *
 * Pourquoi « lue ou non » : la route tourne toutes les 30 min (n8n). Quand le
 * dédoublonnage ne regardait que les NON-LUES, un suivi ouvert redonnait une
 * notification à chaque passage dès que la précédente était lue — jusqu'à une
 * cinquantaine sur les 25 h de la fenêtre. Un rappel par fenêtre suffit ; un
 * suivi reprogrammé plus tard rouvre une fenêtre et se rappelle de nouveau.
 */
export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const windowStart = new Date(now - 24 * 60 * 60 * 1000); // overdue since < 24 h
  const windowEnd = new Date(now + REMINDER_LEAD_MS); // due within 60 min

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
        gte(notifications.createdAt, new Date(followup.dueAt.getTime() - REMINDER_LEAD_MS)),
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
