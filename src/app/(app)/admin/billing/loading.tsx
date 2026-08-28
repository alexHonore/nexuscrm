import { Skeleton } from "@/components/ui/skeleton";

/**
 * Le squelette suit la MISE EN PAGE réelle — barre de période, carte du total,
 * trois réservoirs, le graphique des journées — pour que la première peinture
 * ne fasse pas sauter la page.
 */
export default function Loading() {
  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-24 md:h-8" />
        ))}
      </div>

      {/* Total de la période + barre de répartition */}
      <Skeleton className="h-32 rounded-xl" />

      {/* Les trois réservoirs */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>

      {/* Dépense par jour */}
      <Skeleton className="h-72 rounded-xl" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
