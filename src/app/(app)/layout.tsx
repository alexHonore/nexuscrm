import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireUser } from "@/lib/auth/guards";
import { AppShell } from "@/components/shell/app-shell";
import { TelephonyProvider } from "@/components/telephony/telephony-context";
import { WebphoneDock } from "@/components/telephony/webphone-dock";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  const unread = await db.$count(
    notifications,
    and(eq(notifications.userId, user.id), isNull(notifications.readAt)),
  );

  return (
    <TelephonyProvider>
      <AppShell
        user={{ id: user.id, name: user.name, role: user.role, locale: user.locale }}
        unreadCount={unread}
      >
        {children}
      </AppShell>
      <WebphoneDock />
    </TelephonyProvider>
  );
}
