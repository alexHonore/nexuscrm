"use client";

import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { useClientListNav } from "@/components/clients/client-list-nav";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Quick switching between clients in the panel's current filtered order:
 * Précédent / Suivant + position, plus ArrowUp/ArrowDown shortcuts.
 * Falls back to a lone "back to list" button when the id is not in the
 * loaded list (deep link) — never crashes.
 */
export function ClientSwitcher({ clientId }: { clientId: string }) {
  const t = useTranslations("clients");
  const router = useRouter();
  const nav = useClientListNav();

  const index = nav ? nav.indexOf(clientId) : -1;
  const known = nav !== null && index >= 0;

  const goPrev = () => {
    if (!nav || index <= 0) return;
    router.push(`/clients/${nav.ids[index - 1]}`);
  };
  const goNext = async () => {
    if (!nav || index < 0) return;
    if (index < nav.ids.length - 1) {
      router.push(`/clients/${nav.ids[index + 1]}`);
      return;
    }
    // End of the loaded pages: fetch the next one, then jump to its first row.
    if (!nav.hasMore || nav.loadingMore) return;
    const appended = await nav.loadMore();
    if (appended.length > 0) router.push(`/clients/${appended[0]}`);
  };

  // Latest-ref so the global listener always sees the current neighbors.
  const handlersRef = useRef({ goPrev, goNext });
  handlersRef.current = { goPrev, goNext };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable)
          return;
        // Leave arrow keys to open dialogs, menus and listboxes.
        if (target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      }
      e.preventDefault();
      if (e.key === "ArrowUp") handlersRef.current.goPrev();
      else void handlersRef.current.goNext();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const prevDisabled = !known || index <= 0;
  const nextDisabled =
    !known || nav.loadingMore || (index >= nav.ids.length - 1 && !nav.hasMore);

  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
      {/* Mobile: back to the panel. Also the desktop fallback for deep links. */}
      <Button
        variant="ghost"
        className={cn("min-h-11 px-2.5 md:min-h-9", known && "md:hidden")}
        onClick={() => router.push("/clients")}
      >
        <ChevronLeftIcon />
        {t("switcher.backToList")}
      </Button>

      {known ? (
        <div className="ml-auto flex items-center rounded-lg border bg-card px-1">
          <span className="px-2 text-sm text-muted-foreground tabular-nums">
            {t("switcher.position", { position: index + 1, total: nav.total })}
          </span>
          <Button
            variant="ghost"
            className="size-11 md:size-9"
            aria-label={t("switcher.previous")}
            disabled={prevDisabled}
            onClick={goPrev}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="ghost"
            className="size-11 md:size-9"
            aria-label={t("switcher.next")}
            disabled={nextDisabled}
            onClick={() => void goNext()}
          >
            {nav.loadingMore ? <Loader2Icon className="animate-spin" /> : <ChevronRightIcon />}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
