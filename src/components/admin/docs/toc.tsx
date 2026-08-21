"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface TocEntry {
  id: string;
  label: string;
}

/**
 * Sommaire collant avec suivi de la section visible. Sur mobile, replié dans
 * un <details> : une page de documentation se lit en défilant, pas en
 * naviguant dans un menu qui mange la moitié de l'écran.
 */
export function DocsToc({ entries, title }: { entries: TocEntry[]; title: string }) {
  const [active, setActive] = useState<string>(entries[0]?.id ?? "");

  useEffect(() => {
    const targets = entries
      .map((e) => document.getElementById(e.id))
      .filter((el): el is HTMLElement => el !== null);
    if (targets.length === 0) return;
    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter((r) => r.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );
    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  }, [entries]);

  const list = (
    <ol className="space-y-1 text-sm">
      {entries.map((e, i) => (
        <li key={e.id}>
          <a
            href={`#${e.id}`}
            className={cn(
              "flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted",
              active === e.id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground",
            )}
          >
            <span className="w-5 shrink-0 text-xs tabular-nums opacity-70">{i + 1}.</span>
            <span className="truncate">{e.label}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <>
      <details className="rounded-lg border p-3 lg:hidden">
        <summary className="min-h-11 cursor-pointer text-sm font-medium leading-[2.75rem]">{title}</summary>
        {list}
      </details>
      <nav aria-label={title} className="sticky top-4 hidden max-h-[calc(100dvh-2rem)] overflow-y-auto lg:block">
        <p className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        {list}
      </nav>
    </>
  );
}
