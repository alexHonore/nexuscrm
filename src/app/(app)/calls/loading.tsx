import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Silhouette de « Mes appels » : en-tête, statistiques du jour, filtres en
 * pastilles puis journal groupé par jour — mêmes dimensions que la page
 * réelle pour éviter tout saut de mise en page.
 */
export default function MyCallsLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 pb-safe md:px-8">
      {/* ── En-tête ── */}
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>

      {/* ── Statistiques du jour ── */}
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} size="sm" className="h-24 shadow-xs">
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-8 rounded-md" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-8 w-12" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Filtres (pastilles) ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-11 w-24 rounded-full md:h-8" />
          <Skeleton className="h-11 w-20 rounded-full md:h-8" />
          <Skeleton className="h-11 w-20 rounded-full md:h-8" />
          <Skeleton className="h-11 w-28 rounded-full md:h-8" />
          <Skeleton className="h-11 w-24 rounded-full md:h-8" />
          <Skeleton className="h-11 w-24 rounded-full md:h-8" />
        </div>
        <div className="flex items-center gap-2 overflow-hidden pb-1">
          <Skeleton className="h-11 w-28 shrink-0 rounded-full md:h-8" />
          <Skeleton className="h-11 w-24 shrink-0 rounded-full md:h-8" />
          <Skeleton className="h-11 w-28 shrink-0 rounded-full md:h-8" />
          <Skeleton className="h-11 w-32 shrink-0 rounded-full md:h-8" />
          <Skeleton className="h-11 w-28 shrink-0 rounded-full md:h-8" />
        </div>
      </div>

      {/* ── Compte de résultats ── */}
      <Skeleton className="h-4 w-28" />

      {/* ── Journal groupé par jour ── */}
      <div className="space-y-6">
        {[0, 1].map((g) => (
          <section key={g} className="space-y-2">
            <Skeleton className="ml-1 h-4 w-24" />
            <div className="divide-y divide-foreground/5 rounded-xl bg-card ring-1 ring-foreground/10">
              {Array.from({ length: g === 0 ? 5 : 3 }, (_, i) => (
                <div key={i} className="flex items-center gap-3 p-3 md:px-4 md:py-2">
                  <Skeleton className="hidden h-4 w-12 md:block" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-40 max-w-full" />
                    <Skeleton className="h-3 w-28 md:hidden" />
                  </div>
                  <Skeleton className="h-6 w-24 rounded-full" />
                  <Skeleton className="size-9 rounded-lg" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
