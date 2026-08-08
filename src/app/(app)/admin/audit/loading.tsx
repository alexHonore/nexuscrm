import { Skeleton } from "@/components/ui/skeleton";

/** Silhouette de /admin/audit : en-tête + filtres + tableau (desktop) / cartes (mobile). */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 p-4 md:p-6">
      {/* ── En-tête ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Skeleton className="size-10 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      </div>

      {/* ── Filtres ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        ))}
      </div>

      {/* ── Tableau (desktop) ── */}
      <div className="hidden overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10 md:block">
        <div className="flex h-10 items-center gap-6 border-b bg-muted/40 px-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-20" />
          ))}
        </div>
        <div className="divide-y">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-6 px-3 py-3">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-36 rounded-md" />
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="ml-auto h-8 w-20 rounded-md" />
            </div>
          ))}
        </div>
      </div>

      {/* ── Cartes (mobile) ── */}
      <div className="space-y-3 md:hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-5 w-36 rounded-md" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
