import { Skeleton } from "@/components/ui/skeleton";

/** Silhouette de /admin/pipeline : en-tête + deux cartes (catégories, sources). */
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
      </div>

      {/* ── Deux colonnes de cartes ── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, card) => (
          <div key={card} className="space-y-4 rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/10">
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64 max-w-full" />
            </div>
            <div className="space-y-1.5">
              {Array.from({ length: card === 0 ? 6 : 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border border-l-4 px-2.5 py-2">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              ))}
            </div>
            <Skeleton className="h-11 w-44 rounded-md md:h-8" />
          </div>
        ))}
      </div>
    </div>
  );
}
