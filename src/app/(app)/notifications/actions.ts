"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/guards";

export type NotificationActionResult = { ok: true } | { ok: false };

/** Mark one of MY notifications as read. */
export async function markNotificationReadAction(id: string): Promise<NotificationActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false };
  if (!z.string().uuid().safeParse(id).success) return { ok: false };

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.id, id), eq(notifications.userId, user.id), isNull(notifications.readAt)),
    );

  revalidatePath("/notifications");
  return { ok: true };
}

/** Mark ALL my notifications as read. */
export async function markAllNotificationsReadAction(): Promise<NotificationActionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false };

  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));

  revalidatePath("/notifications");
  return { ok: true };
}
