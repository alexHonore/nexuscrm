import { Skeleton } from "@/components/ui/skeleton";

/**
 * Silhouette de chargement du journal des appels : en-tête avec action,
 * filtres, compte de résultats puis tableau (cartes sur mobile) — mêmes
 * dimensions que la page réelle pour éviter tout saut de mise en page.
 */
export default function CallsLoading() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* ── En-tête + action ── */}
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        <Skeleton className="h-11 w-44 rounded-lg" />
      </div>

      {/* ── Filtres ── */}
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Skeleton className="h-11 w-full rounded-lg md:h-8 md:max-w-xs" />
          <Skeleton className="h-11 w-24 rounded-lg md:h-8" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-11 w-40 rounded-lg md:h-8" />
          <Skeleton className="h-11 w-32 rounded-lg md:h-8" />
          <Skeleton className="h-11 w-40 rounded-lg md:h-8" />
        </div>
      </div>

      {/* ── Compte de résultats ── */}
      <Skeleton className="h-4 w-24" />

      {/* ── Tableau (md+) ── */}
      <div className="hidden overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 shadow-xs md:block">
        <div className="h-10 bg-muted/40" />
        <div className="space-y-2 p-3">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </div>

      {/* ── Cartes (mobile) ── */}
      <div className="space-y-3 md:hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs"
          >
            <div className="flex items-start justify-between gap-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
            <Skeleton className="mt-3 h-4 w-48 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
