import { Skeleton } from "@/components/ui/skeleton";

/** Silhouette de /admin/settings : en-tête + trois cartes de réglages empilées. */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
      {/* ── En-tête ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Skeleton className="size-10 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
      </div>

      {/* ── Cartes de réglages ── */}
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10"
        >
          <div className="flex items-center gap-3 border-b p-4">
            <Skeleton className="size-9 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-36 max-w-full" />
              <Skeleton className="h-3.5 w-72 max-w-full" />
            </div>
          </div>
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 5 }).map((_, j) => (
                <Skeleton key={j} className="h-11 w-16 rounded-full md:h-8" />
              ))}
            </div>
            <div className="grid max-w-md grid-cols-2 gap-3">
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
            <Skeleton className="h-9 w-full max-w-md rounded-md" />
          </div>
          <div className="border-t bg-muted/50 p-4">
            <Skeleton className="h-11 w-32 rounded-md md:h-8" />
          </div>
        </div>
      ))}
    </div>
  );
}
