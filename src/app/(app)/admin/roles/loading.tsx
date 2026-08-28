import { Skeleton } from "@/components/ui/skeleton";

/** Silhouette de /admin/roles : en-tête, la liste des rôles, l'éditeur. */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      {/* ── En-tête ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Skeleton className="size-10 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-11 w-36 rounded-md md:h-9" />
      </div>

      {/* ── Les rôles ── */}
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-32 max-w-full" />
                <Skeleton className="h-3.5 w-24" />
              </div>
            </div>
            <Skeleton className="mt-4 h-3.5 w-full max-w-64" />
          </div>
        ))}
      </div>

      {/* ── L'éditeur : trois onglets, puis des interrupteurs ── */}
      <div className="overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10">
        <div className="flex gap-2 border-b p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-32 rounded-md md:h-9" />
          ))}
        </div>
        <div className="space-y-3 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48 max-w-full" />
                <Skeleton className="h-3.5 w-full max-w-lg" />
              </div>
              <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
