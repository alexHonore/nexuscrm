import { Skeleton } from "@/components/ui/skeleton";

/** Silhouette de /admin/webhooks : en-tête + carte d'explication + carte des clés. */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      {/* ── En-tête ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Skeleton className="size-10 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>

      {/* ── Carte d'explication ── */}
      <div className="space-y-4 rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10">
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-64 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-6 w-72 max-w-full rounded-md" />
        </div>
        <div className="overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10">
          <div className="h-8 border-b bg-muted/40" />
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2">
                <Skeleton className="h-3.5 w-56 max-w-[60%]" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        </div>
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>

      {/* ── Carte des clés ── */}
      <div className="space-y-4 rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10">
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-xl border p-3">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
            <Skeleton className="h-6 w-48 rounded-md" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Skeleton className="h-8 w-full rounded-md" />
              <Skeleton className="h-8 w-full rounded-md" />
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
          </div>
        ))}
        <Skeleton className="h-11 w-36 rounded-md md:h-8" />
      </div>
    </div>
  );
}
