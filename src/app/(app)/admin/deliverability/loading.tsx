import { Skeleton } from "@/components/ui/skeleton";

/**
 * Silhouette de chargement de la Délivrabilité.
 *
 * `collectFacts()` balaie une fenêtre entière de messages : à 90 jours, la
 * requête se compte en secondes. Sans cette silhouette, l'admin voit la page
 * précédente figée et clique une deuxième fois sur la période.
 *
 * Les blocs reprennent EXACTEMENT les grilles de la page réelle (bandeau de
 * verdict, rangée de période, sommaire, 6 tuiles, constats, un tableau) : une
 * silhouette qui ne colle pas fait sauter la mise en page à l'arrivée des
 * chiffres, et le regard repart de zéro.
 */
export default function DeliverabilityLoading() {
  return (
    <div className="space-y-5 p-4 md:p-6">
      {/* ── En-tête ── */}
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-1.5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>

      {/* ── Bandeau de verdict ── */}
      <Skeleton className="h-20 rounded-xl" />

      {/* ── Période ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-4 w-16" />
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-24 rounded-lg md:h-8" />
        ))}
      </div>

      {/* ── Sommaire des sections ── */}
      <div className="flex flex-wrap items-center gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-28 rounded-lg md:h-8" />
        ))}
      </div>

      {/* ── Tuiles d'indicateurs ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-xl bg-card p-3 ring-1 ring-foreground/10 shadow-xs">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="mt-2 h-7 w-14" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>

      {/* ── Constats ── */}
      <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs">
        <Skeleton className="h-5 w-32" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>

      {/* ── Par numéro expéditeur ── */}
      <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 shadow-xs">
        <Skeleton className="h-5 w-48" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}
