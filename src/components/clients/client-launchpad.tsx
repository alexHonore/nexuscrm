"use client";

import { ArrowRightIcon, CheckIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useClientListNav } from "@/components/clients/client-list-nav";
import type { ClientFocus } from "@/components/clients/focus";
import { LookIcon, WORKSPACE_LOOK } from "@/components/look";
import { Button } from "@/components/ui/button";

type QueueKey = Exclude<ClientFocus, "all">;

/** Counts arrive from the server with exactly the same visibility as the list. */
export function ClientLaunchpad({
  counts,
}: {
  counts: Record<QueueKey, number> & { all: number };
}) {
  const t = useTranslations("clients");
  const nav = useClientListNav();
  const queues: QueueKey[] = ["overdue", "today", "never", "none"];
  const firstId = nav && !nav.loading && !nav.failed ? nav.ids[0] : undefined;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-5xl flex-col justify-center px-6 py-10 lg:px-10 xl:px-14">
      <div className="mb-9 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <LookIcon look={WORKSPACE_LOOK.clients} size="sm" />
        {t("workspace.eyebrow")}
      </div>

      <div className="max-w-xl">
        <h1 className="font-heading text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
          {t("workspace.title")}
        </h1>
        <p className="mt-4 max-w-lg text-sm leading-7 text-muted-foreground">
          {t("workspace.description")}
        </p>
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-4">
        <Button
          render={firstId ? <Link href={`/clients/${firstId}`} /> : undefined}
          nativeButton={!firstId}
          disabled={!firstId}
          className="min-h-11 gap-3 px-5"
        >
          {t("workspace.openFirst")}
          <ArrowRightIcon aria-hidden className="size-4" />
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {nav?.loading
            ? t("panel.loading")
            : nav?.failed
              ? t("panel.loadError")
              : t("workspace.inView", { count: nav?.total ?? counts.all })}
        </span>
      </div>

      <div className="mt-12 mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("workspace.queues")}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t("list.count", { count: counts.all })}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 min-[1180px]:grid-cols-2">
        {queues.map((queue) => (
          <button
            type="button"
            key={queue}
            onClick={() => nav?.focus(queue)}
            className="group flex min-h-32 items-start gap-4 rounded-2xl border bg-card p-5 text-left transition duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/70">
              <LookIcon look={WORKSPACE_LOOK[queue]} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{t(`workspace.focus.${queue}`)}</span>
                <span className="text-xl font-semibold tabular-nums tracking-tight">{counts[queue]}</span>
              </span>
              <span className="mt-2 block max-w-xs text-xs leading-relaxed text-muted-foreground">
                {t(`workspace.hints.${queue}`)}
              </span>
            </span>
          </button>
        ))}
      </div>

      <p className="mt-7 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {t("workspace.queueHint")}
      </p>
    </div>
  );
}
