import { Skeleton } from "@/components/ui/skeleton";

/** Silhouette de /admin/import-export : en-tête + carte d'import (dépôt de fichier) + carte d'export. */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      {/* ── En-tête ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Skeleton className="size-10 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>

      {/* ── Carte d'import ── */}
      <div className="overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10">
        <div className="flex items-center gap-3 border-b p-4">
          <Skeleton className="size-9 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-52 max-w-full" />
            <Skeleton className="h-3.5 w-80 max-w-full" />
          </div>
        </div>
        <div className="space-y-2 p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-muted/30 px-4 py-10">
            <Skeleton className="size-9 rounded-lg" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
        </div>
      </div>

      {/* ── Carte d'export ── */}
      <div className="overflow-hidden rounded-xl bg-card shadow-xs ring-1 ring-foreground/10">
        <div className="flex items-center gap-3 border-b p-4">
          <Skeleton className="size-9 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-52 max-w-full" />
            <Skeleton className="h-3.5 w-80 max-w-full" />
          </div>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-8 w-full rounded-md" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/50 p-4">
          <Skeleton className="h-11 w-36 rounded-md md:h-8" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
      </div>
    </div>
  );
}
