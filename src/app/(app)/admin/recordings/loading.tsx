import { Skeleton } from "@/components/ui/skeleton";

/**
 * Silhouette de la bibliothèque d'écoute : en-tête, rayonnage à gauche
 * (au-dessus de la liste sous `lg`, comme la vraie grille) puis la liste
 * d'appels — en cartes à toutes les largeurs, comme la bibliothèque.
 */
export default function RecordingLibraryLoading() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* ── En-tête ── */}
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        {/* ── Rayonnage ── */}
        <div className="space-y-5">
          {Array.from({ length: 3 }, (_, block) => (
            <div key={block} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-11 w-full rounded-lg md:h-9" />
              ))}
            </div>
          ))}
        </div>

        <div className="min-w-0 space-y-3">
          <div className="space-y-1.5">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-28" />
          </div>

          {/* ── Cartes, à toutes les largeurs — comme `CallsList variant="library"` ── */}
          <div className="space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs">
                <div className="flex items-start justify-between gap-2">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-6 w-20 rounded-full" />
                </div>
                <Skeleton className="mt-3 h-4 w-48 max-w-full" />
                <Skeleton className="mt-3 h-11 w-full rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
