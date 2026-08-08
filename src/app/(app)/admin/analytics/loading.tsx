import { Skeleton } from "@/components/ui/skeleton";

/**
 * Silhouette de chargement de la page Analytique : en-tête, rangée de filtres,
 * 6 tuiles KPI, rectangles de graphiques puis tableau — mêmes grilles et
 * dimensions que la page réelle pour éviter tout saut de mise en page.
 */
export default function AnalyticsLoading() {
  return (
    <div className="space-y-5 p-4 md:p-6">
      {/* ── En-tête ── */}
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-4 w-52" />
        </div>
      </div>

      {/* ── Filtres ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-11 w-60 rounded-lg md:h-9" />
        <Skeleton className="h-11 w-44 rounded-lg md:h-8" />
      </div>

      {/* ── Tuiles KPI ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="rounded-xl bg-card p-3 ring-1 ring-foreground/10 shadow-xs"
          >
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="mt-2 h-7 w-14" />
          </div>
        ))}
      </div>

      {/* ── Graphiques ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs lg:col-span-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="mt-4 h-72 w-full" />
        </div>
        <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="mt-4 h-64 w-full" />
        </div>
        <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="mt-4 h-64 w-full" />
        </div>
      </div>

      {/* ── Tableau par téléphoniste ── */}
      <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs">
        <Skeleton className="h-5 w-48" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
