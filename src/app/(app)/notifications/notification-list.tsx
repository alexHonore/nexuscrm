"use client";

import { enUS, fr } from "date-fns/locale";
import { BellIcon, CheckCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { NOTIFICATION_LOOK, TONE, lookTint } from "@/components/look";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { emitDataChange } from "@/lib/live";
import { pushRule } from "@/lib/push/policy";
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



/**
 * « Tout marquer comme lu ».
 *
 * Le bouton accepte une classe parce que l'écran le pose à DEUX endroits selon
 * la largeur — dans l'en-tête sur grand écran, sous le titre sur téléphone —
 * et qu'un seul des deux est rendu à la fois. Le geste, lui, reste écrit une
 * seule fois : c'est tout l'intérêt de le laisser choisir sa place.
 */
export function MarkAllReadButton({
  disabled,
  className,
}: {
  disabled: boolean;
  className?: string;
}) {
  const t = useTranslations("notifications");
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      className={cn("min-h-11 md:min-h-8", className)}
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
  // Les six types SMS ont leur libellé dans `common.push.types`, où l'écran de
  // profil va déjà les chercher : deux namespaces, un seul libellé par concept.
  const tCommon = useTranslations("common");
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

  // Le vocabulaire partagé plutôt qu'une table locale : c'est lui qui garantit
  // qu'un type ajouté au produit reçoit son pictogramme (tests/unit-look.test.ts).
  const look = NOTIFICATION_LOOK[notification.type] ?? { color: TONE.raw, Icon: BellIcon };
  const tint = lookTint(look);
  const Icon = look.Icon;

  // Les libellés vivent dans DEUX namespaces : les sept types historiques dans
  // `notifications.types`, les six types SMS dans `common.push.types` — où
  // l'écran de profil va déjà les chercher. Le repli sur le type BRUT reste en
  // dernier recours : il vaut mieux lire « sms_inbound » qu'une page blanche,
  // mais il ne doit jamais être atteint (règle 2).
  const typeLabel = t.has(`types.${notification.type}`)
    ? t(`types.${notification.type}`)
    : tCommon.has(`push.types.${notification.type}`)
      ? tCommon(`push.types.${notification.type}`)
      : notification.type;

  // La bordure épaisse ne se donne QU'À ce qui traverse les heures de silence :
  // un appel manqué, un nouveau prospect, un fil qui rend la main. C'est la
  // même liste que celle qui fait vibrer un téléphone la nuit — la cloche et la
  // poche disent donc la même chose, ce qui évite d'avoir à les accorder à la
  // main le jour où l'une des deux change.
  const urgent = pushRule(notification.type).urgent;

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
          // Le trait de gauche : la marque qui survit à une capture en noir et
          // blanc, et qu'on voit en défilant sans lire.
          urgent && "border-l-4 pl-[calc(0.75rem-4px)]",
        )}
        style={urgent ? { borderLeftColor: tint.borderColor } : undefined}
      >
        <span
          aria-hidden
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
          style={read ? undefined : { backgroundColor: tint.backgroundColor, color: tint.color }}
        >
          <Icon
            className={cn("size-4", read && "text-muted-foreground")}
            style={read ? undefined : { color: tint.color }}
          />
        </span>
        <span className="min-w-0 flex-1">
          {/* Le libellé du type, ÉCRIT. L'icône le double, elle ne le remplace
              pas, et la couleur ne porte jamais le sens toute seule (règle 11). */}
          <span className="block text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {typeLabel}
          </span>
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
