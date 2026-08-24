"use client";

import { CheckIcon, PhoneIcon, PhoneOffIcon, UserRoundIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";
import { completeFollowupAction } from "@/app/(app)/clients/actions";
import { Button } from "@/components/ui/button";
import { useTelephony } from "@/components/telephony/telephony-context";
import { cn } from "@/lib/utils";

export type FollowupItemData = {
  id: string;
  clientId: string;
  clientName: string;
  phone: string;
  phoneDisplay: string;
  note: string | null;
  dueLabel: string;
  overdue: boolean;
  /** `clients.doNotCall` — gate ABSOLU : le bouton d'appel reste désactivé. */
  doNotCall: boolean;
};

export function FollowupItem({ item }: { item: FollowupItemData }) {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const { dial, ready } = useTelephony();
  const [pending, startTransition] = useTransition();

  const markDone = () => {
    startTransition(async () => {
      const res = await completeFollowupAction(item.id);
      if (res.ok) {
        toast.success(t("followups.done"));
        router.refresh();
      } else {
        toast.error(t("error"));
      }
    });
  };

  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-lg border py-2 pr-2 pl-3 transition-colors hover:bg-muted/50",
        item.overdue && "border-l-4 border-l-destructive bg-destructive/5 hover:bg-destructive/10",
      )}
    >
      <div className="min-w-0 flex-1">
        <Link
          href={`/clients/${item.clientId}`}
          className="flex items-center gap-1.5 text-sm font-medium hover:underline"
        >
          {item.doNotCall ? (
            <PhoneOffIcon
              aria-label={t("followups.doNotCall")}
              className="size-3.5 shrink-0 text-destructive"
            />
          ) : null}
          <span className="truncate">{item.clientName}</span>
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          <span className={cn("font-medium tabular-nums", item.overdue && "text-destructive")}>
            {item.dueLabel}
          </span>
          {" · "}
          {item.phoneDisplay}
          {item.note ? ` · ${item.note}` : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          className="size-11 rounded-full bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 hover:text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-400 dark:hover:bg-emerald-500/25 dark:hover:text-emerald-300"
          aria-label={item.doNotCall ? t("followups.doNotCall") : t("followups.call")}
          // Même règle que l'en-tête de la fiche et la carte du pipeline :
          // une fiche « Ne pas appeler » ne se compose pas d'un geste.
          disabled={!ready || item.doNotCall}
          onClick={() => dial({ number: item.phone, clientId: item.clientId, clientName: item.clientName })}
        >
          <PhoneIcon className="size-5" />
        </Button>
        <Button
          variant="ghost"
          className="size-11"
          aria-label={t("followups.open")}
          render={<Link href={`/clients/${item.clientId}`} />}
        >
          <UserRoundIcon className="size-5" />
        </Button>
        <Button
          variant="ghost"
          className="size-11"
          aria-label={t("followups.markDone")}
          disabled={pending}
          onClick={markDone}
        >
          <CheckIcon className="size-5" />
        </Button>
      </div>
    </li>
  );
}
