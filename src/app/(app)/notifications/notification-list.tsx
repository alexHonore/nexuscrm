"use client";

import { enUS, fr } from "date-fns/locale";
import {
  AtSignIcon,
  BellIcon,
  CalendarDaysIcon,
  CheckCheckIcon,
  ClockIcon,
  PhoneMissedIcon,
  UserPlusIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { emitDataChange } from "@/lib/live";
import { cn } from "@/lib/utils";
import { markAllNotificationsReadAction, markNotificationReadAction } from "./actions";

export type NotificationData = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string; // ISO
};

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  mention: AtSignIcon,
  followup_due: ClockIcon,
  incoming_lead: UserPlusIcon,
  appointment: CalendarDaysIcon,
  missed_call: PhoneMissedIcon,
  system: BellIcon,
};

export function MarkAllReadButton({ disabled }: { disabled: boolean }) {
  const t = useTranslations("notifications");
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      className="min-h-11 md:min-h-8"
      disabled={disabled || pending}
      onClick={() =>
        startTransition(async () => {
          const res = await markAllNotificationsReadAction();
          if (res.ok) {
            toast.success(t("allRead"));
            // Un seul rafraîchissement : la coquille écoute « notifications »
            // et redemande l'arbre serveur (pastille + liste de cette page).
            emitDataChange("notifications");
          } else {
            toast.error(t("error"));
          }
        })
      }
    >
      <CheckCheckIcon />
      {t("markAllRead")}
    </Button>
  );
}

export function NotificationItem({ notification }: { notification: NotificationData }) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Lecture optimiste : la puce disparaît au clic, sans attendre le serveur.
  // Resynchronisation sur la donnée serveur pendant le rendu (motif React
  // « ajuster l'état quand une prop change »), sans effet ni rendu en cascade.
  const [read, setRead] = useState(notification.read);
  const [serverRead, setServerRead] = useState(notification.read);
  if (serverRead !== notification.read) {
    setServerRead(notification.read);
    setRead(notification.read);
  }

  const Icon = TYPE_ICONS[notification.type] ?? BellIcon;
  const typeLabel =
    notification.type in TYPE_ICONS
      ? t(`types.${notification.type as "mention" | "followup_due" | "incoming_lead" | "appointment" | "system"}`)
      : notification.type;

  const open = () => {
    const wasUnread = !read;
    if (wasUnread) setRead(true);
    startTransition(async () => {
      if (wasUnread) {
        const res = await markNotificationReadAction(notification.id);
        // Échec : on rétablit la puce, mais on ouvre quand même la fiche.
        if (res.ok) emitDataChange("notifications");
        else {
          setRead(false);
          toast.error(t("error"));
        }
      }
      if (notification.link) router.push(notification.link);
      else router.refresh();
    });
  };

  return (
    <li>
      <button
        type="button"
        onClick={open}
        className={cn(
          "flex min-h-14 w-full items-start gap-3 rounded-xl p-3 text-left ring-1 ring-foreground/10 transition-colors hover:bg-muted/60 active:bg-muted",
          read ? "bg-card" : "bg-primary/5",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            read ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
          )}
          aria-label={typeLabel}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                "truncate text-sm",
                read ? "font-normal" : "font-semibold",
              )}
            >
              {notification.title}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              <RelativeTime date={notification.createdAt} locale={dfnsLocale} />
            </span>
          </span>
          {notification.body ? (
            <span className="block truncate text-xs text-muted-foreground">{notification.body}</span>
          ) : null}
        </span>
        {!read ? (
          <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-primary" />
        ) : null}
      </button>
    </li>
  );
}
