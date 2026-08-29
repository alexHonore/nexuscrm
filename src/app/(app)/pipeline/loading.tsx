import { Skeleton } from "@/components/ui/skeleton";

/**
 * Silhouette du pipeline : en-tête puis colonnes Kanban en défilement
 * horizontal — mêmes dimensions que la page réelle (hauteur du tableau,
 * largeur des colonnes) pour éviter tout saut de mise en page.
 */
export default function PipelineLoading() {
  return (
    <div className="space-y-4 py-6">
      {/* ── En-tête ── */}
      <div className="flex items-center gap-3 px-4 md:px-8">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>

      {/* ── Colonnes ── */}
      {/* Même hauteur que le tableau réel (20rem sous `md`) : la silhouette
          ne doit pas être d'un demi-rem plus haute que ce qui la remplace. */}
      <div className="flex h-[calc(100dvh-20rem)] min-h-80 gap-3 overflow-hidden px-4 pb-2 md:h-[calc(100dvh-10rem)] md:gap-4 md:px-8">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex h-full w-[calc(100vw-4.5rem)] max-w-80 shrink-0 flex-col overflow-hidden rounded-xl border-t-4 border-t-muted bg-muted/40 ring-1 ring-foreground/5 md:w-[300px]"
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="ml-auto h-5 w-8 rounded-full" />
            </div>
            <div className="space-y-2 px-2 pb-2">
              {Array.from({ length: 4 }, (_, j) => (
                <Skeleton key={j} className="h-24 w-full rounded-lg" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
