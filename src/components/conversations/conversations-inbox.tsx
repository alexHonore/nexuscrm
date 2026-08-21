"use client";

import { enUS, fr } from "date-fns/locale";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  HandIcon,
  MessageCircleIcon,
  MoonIcon,
  PowerOffIcon,
  SunIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  assignConversationAction,
  markConversationHandledAction,
} from "@/app/(app)/conversations/actions";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { emitDataChange, useDataChange, useVisiblePolling } from "@/lib/live";
import { cn } from "@/lib/utils";

export type InboxRow = {
  id: string;
  clientId: string | null;
  clientName: string;
  clientPhone: string;
  needsAttention: boolean;
  attentionReason: string | null;
  aiEnabled: boolean;
  assignedToId: string | null;
  assignedToName: string | null;
  lastBody: string | null;
  lastAt: string | null;
};

export type EngineHealth = {
  killSwitch: boolean;
  mode: "live" | "sandbox" | "dry_run";
  sendWindowOpen: boolean;
  queued: number;
  failed: number;
  suppressed: number;
};

type Filter = "attention" | "mine" | "paused" | "all";
const POLL_MS = 25_000;

/**
 * Boîte de réception.
 *
 * La bande d'état est en HAUT et non repliée quelque part : découvrir après
 * avoir tapé trois réponses que les envois sont suspendus, ou qu'on est en
 * simulation, est la pire manière de l'apprendre. Un mode qui n'est pas
 * « réel » et un interrupteur coupé sont affichés comme des alertes, pas comme
 * des informations.
 */
export function ConversationsInbox({
  rows,
  currentUserId,
  health,
}: {
  rows: InboxRow[];
  currentUserId: string;
  health: EngineHealth;
}) {
  const t = useTranslations("conversations");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("attention");

  useDataChange(["sms"], () => router.refresh());
  useVisiblePolling(POLL_MS, () => router.refresh());

  const counts = useMemo(
    () => ({
      attention: rows.filter((r) => r.needsAttention).length,
      mine: rows.filter((r) => r.assignedToId === currentUserId).length,
      paused: rows.filter((r) => !r.aiEnabled).length,
      all: rows.length,
    }),
    [rows, currentUserId],
  );

  const visible = useMemo(() => {
    switch (filter) {
      case "attention":
        return rows.filter((r) => r.needsAttention);
      case "mine":
        return rows.filter((r) => r.assignedToId === currentUserId);
      case "paused":
        return rows.filter((r) => !r.aiEnabled);
      case "all":
        return rows;
    }
  }, [rows, filter, currentUserId]);

  const handle = (row: InboxRow) => {
    startTransition(async () => {
      const result = await markConversationHandledAction(row.id);
      if (!result.ok) {
        toast.error(t("error"));
        return;
      }
      toast.success(t("inbox.handled"));
      emitDataChange("sms");
      router.refresh();
    });
  };

  const claim = (row: InboxRow) => {
    startTransition(async () => {
      const result = await assignConversationAction({
        conversationId: row.id,
        userId: currentUserId,
      });
      if (!result.ok) {
        toast.error(t("error"));
        return;
      }
      emitDataChange("sms");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <HealthStrip health={health} attention={counts.attention} />

      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <div className="flex w-max gap-2">
          {(["attention", "mine", "paused", "all"] as const).map((key) => (
            <Button
              key={key}
              variant={filter === key ? "default" : "outline"}
              size="sm"
              className="min-h-11 md:min-h-9"
              onClick={() => setFilter(key)}
            >
              {t(`inbox.filters.${key}`)}
              <Badge variant="secondary" className="ml-1.5">
                {counts[key]}
              </Badge>
            </Button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<MessageCircleIcon />}
          title={t("inbox.empty.title")}
          hint={t("inbox.empty.desc")}
        />
      ) : (
        <div className="space-y-3">
          {visible.map((row) => (
            <Card key={row.id} className={cn(row.needsAttention && "border-primary/40")}>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {row.clientId ? (
                    <Link href={`/clients/${row.clientId}`} className="font-medium hover:underline">
                      {row.clientName}
                    </Link>
                  ) : (
                    <span className="font-medium">{row.clientName}</span>
                  )}

                  {row.needsAttention && row.attentionReason ? (
                    <Badge variant="default">
                      {t(`inbox.reason.${row.attentionReason}` as never)}
                    </Badge>
                  ) : null}

                  {/* Un fil en pause est un fil dont personne d'autre ne
                      s'occupera : l'assistant se tait tant qu'il est ainsi. */}
                  {!row.aiEnabled ? (
                    <Badge
                      variant="outline"
                      className="gap-1 border-amber-500/40 font-normal text-amber-600 dark:text-amber-400"
                    >
                      <HandIcon className="size-3" /> {t("ai.off")}
                    </Badge>
                  ) : null}

                  <span className="flex-1" />
                  {row.lastAt ? (
                    <span className="text-xs text-muted-foreground">
                      <RelativeTime date={row.lastAt} locale={dfnsLocale} />
                    </span>
                  ) : null}
                </div>

                {row.lastBody ? (
                  <p className="line-clamp-2 text-sm text-muted-foreground">{row.lastBody}</p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {row.assignedToName ?? t("inbox.unassigned")}
                  </span>
                  <span className="flex-1" />
                  {row.assignedToId !== currentUserId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      disabled={pending}
                      onClick={() => claim(row)}
                    >
                      {t("inbox.assignToMe")}
                    </Button>
                  ) : null}
                  {row.needsAttention ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      disabled={pending}
                      onClick={() => handle(row)}
                    >
                      <CheckIcon /> {t("inbox.markHandled")}
                    </Button>
                  ) : null}
                  {row.clientId ? (
                    <Button
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      render={<Link href={`/clients/${row.clientId}`} />}
                    >
                      {t("inbox.open")}
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthStrip({ health, attention }: { health: EngineHealth; attention: number }) {
  const t = useTranslations("conversations");
  // Deux états méritent une ALERTE, pas une pastille : rien ne part, ou rien
  // ne part pour de vrai. Les confondre avec « 12 en file » serait les noyer.
  const suspended = health.killSwitch;
  const notLive = health.mode !== "live";

  return (
    <div className="space-y-2">
      {suspended ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm font-medium text-destructive"
        >
          <PowerOffIcon className="size-4 shrink-0" />
          {t("health.killSwitch.on")}
        </div>
      ) : null}

      {notLive ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <AlertTriangleIcon className="size-4 shrink-0" />
          {t(`health.mode.${health.mode}`)}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {health.sendWindowOpen ? (
            <SunIcon className="size-3.5" />
          ) : (
            <MoonIcon className="size-3.5" />
          )}
          {t(health.sendWindowOpen ? "health.quiet.open" : "health.quiet.closed")}
        </span>
        <span className="flex items-center gap-1.5">
          <BotIcon className="size-3.5" />
          {t("health.queue", { count: health.queued })}
        </span>
        {health.failed > 0 ? (
          <span className="font-medium text-destructive">
            {t("health.failed", { count: health.failed })}
          </span>
        ) : null}
        <span>{t("health.suppressed", { count: health.suppressed })}</span>
        {attention > 0 ? (
          <span className="font-medium text-foreground">
            {t("health.attention", { count: attention })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
