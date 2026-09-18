"use client";

import { ArrowRight, CornerDownLeft, LoaderCircle, Search, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Command, CommandGroup, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Command as CommandPrimitive } from "cmdk";
import { formatPhone } from "@/lib/phone";

export type SearchDestination = {
  href: string;
  label: string;
  group: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
};

type SearchRecord = {
  id: string;
  fullName: string;
  phone: string | null;
  city: string | null;
};

/** No record cache: every search uses the existing server visibility and contact guards. */
export function WorkspaceSearch({ destinations }: { destinations: SearchDestination[] }) {
  const t = useTranslations("common.workspace");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; items: SearchRecord[]; total: number; failed?: boolean } | null>(null);
  const term = query.trim().slice(0, 200);
  const searching = open && term.length >= 2;
  const current = result?.query === term ? result : null;
  const loading = searching && !current;

  function changeOpen(value: boolean) {
    setOpen(value);
    if (!value) {
      setQuery("");
      setResult(null);
    }
  }

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
        setQuery("");
        setResult(null);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/clients/list?q=${encodeURIComponent(term)}&pageSize=6`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("search");
        const data = await response.json() as { items: SearchRecord[]; total: number };
        if (!controller.signal.aborted) setResult({ query: term, items: data.items, total: data.total });
      } catch {
        if (!controller.signal.aborted) setResult({ query: term, items: [], total: 0, failed: true });
      }
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searching, term]);

  const matching = destinations.filter((item) =>
    `${item.label} ${item.group}`.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
      .includes(term.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()),
  );
  const groups = [...new Set(matching.map((item) => item.group))];
  function navigate(href: string) {
    changeOpen(false);
    router.push(href);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        aria-label={t("search")}
        aria-keyshortcuts="Meta+K Control+K"
        className="flex h-11 items-center gap-2.5 rounded-xl border border-border/80 bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-72 lg:w-80"
      >
        <Search aria-hidden className="size-4 shrink-0" />
        <span className="hidden flex-1 text-left md:block">{t("search")}</span>
        <span className="sr-only md:hidden">{t("search")}</span>
        <kbd aria-hidden className="hidden rounded-md border bg-background px-1.5 py-0.5 font-sans text-[10px] md:block">⌘ / Ctrl K</kbd>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="top-[12dvh] flex max-h-[78dvh] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">{t("search")}</DialogTitle>
        <DialogDescription className="sr-only">{t("searchHelp")}</DialogDescription>
        <Command shouldFilter={false} className="h-auto min-h-0 p-0">
          <div className="flex shrink-0 items-center gap-3 border-b px-5">
            <Search aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              aria-label={t("search")}
              placeholder={t("searchPlaceholder")}
              value={query}
              onValueChange={setQuery}
              maxLength={200}
              className="h-16 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
            <button type="button" onClick={() => changeOpen(false)} className="min-h-11 min-w-11 text-xs text-muted-foreground hover:text-foreground">{t("closeSearch")}</button>
          </div>
          <CommandList className="min-h-0 max-h-[calc(78dvh-8.5rem)] p-2">
            {searching ? (
              <CommandGroup heading={t("records")}>
                <div role="status" aria-live="polite" className="px-2 text-sm text-muted-foreground">
                  {loading ? <p className="flex items-center gap-2 py-4"><LoaderCircle aria-hidden className="size-4 animate-spin" />{t("searching")}</p> : null}
                  {current?.failed ? <p className="py-4">{t("searchError")}</p> : null}
                  {current && !current.failed && current.total === 0 ? <p className="py-4">{t("noRecords")}</p> : null}
                </div>
                {current?.items.map((client) => (
                  <CommandItem key={client.id} value={`client-${client.id}`} onSelect={() => navigate(`/clients/${client.id}`)} className="min-h-14 cursor-pointer gap-3 rounded-lg px-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary"><UserRound aria-hidden className="size-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{client.fullName}</span><span className="block truncate text-xs text-muted-foreground">{[client.city, client.phone ? formatPhone(client.phone) : null].filter(Boolean).join(" · ")}</span></span>
                    <CommandShortcut><ArrowRight aria-hidden className="size-4" /></CommandShortcut>
                  </CommandItem>
                ))}
                <CommandItem value="all-records" onSelect={() => navigate(`/clients?q=${encodeURIComponent(term)}`)} className="min-h-11 cursor-pointer px-3 text-primary">
                  <Search aria-hidden className="size-4" />{current && !current.failed ? t("allResults", { count: current.total }) : t("openDirectory")}
                  <CommandShortcut><ArrowRight aria-hidden className="size-4" /></CommandShortcut>
                </CommandItem>
              </CommandGroup>
            ) : <p className="px-3 py-3 text-xs text-muted-foreground">{t("searchHint")}</p>}
            {groups.map((group) => (
              <CommandGroup key={group} heading={group}>
                {matching.filter((item) => item.group === group).map(({ href, label, icon: Icon }) => (
                  <CommandItem key={href} value={href} onSelect={() => navigate(href)} className="min-h-11 cursor-pointer gap-3 rounded-lg px-3">
                    <Icon aria-hidden className="size-4 text-muted-foreground" />{label}
                    <CommandShortcut><ArrowRight aria-hidden className="size-3.5" /></CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3 text-[11px] text-muted-foreground">
            <span>{t("keyboardHint")}</span><span className="flex items-center gap-1.5"><CornerDownLeft aria-hidden className="size-3" />{t("openResult")}</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
