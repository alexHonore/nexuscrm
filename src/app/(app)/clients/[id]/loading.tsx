import { Skeleton } from "@/components/ui/skeleton";

/**
 * Squelette de la fiche client — au niveau [id] seulement, pour que le panneau
 * de liste persistant (layout de /clients) reste vivant pendant la navigation.
 * Purement présentationnel : mêmes conteneurs et grilles que page.tsx.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-3 md:px-6 md:py-4">
      {/* Rangée du commutateur précédent / suivant */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-11 w-36 md:h-9" />
        <Skeleton className="ml-auto h-11 w-32" />
      </div>

      {/* Entête : avatar + nom + coordonnées */}
      <div className="flex items-start gap-3">
        <Skeleton className="size-12 rounded-full" />
        <div className="space-y-2 py-1">
          <Skeleton className="h-7 w-56 max-w-full" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </div>

      {/* Grille des trois cartes (suivis + commentaires / informations) */}
      <div className="@container">
        <div className="grid items-start gap-4 @3xl:grid-cols-3 md:gap-5">
          <div className="order-1 space-y-4 @3xl:order-2 @3xl:col-span-1 md:space-y-5">
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
          <div className="order-2 @3xl:order-1 @3xl:col-span-2">
            <Skeleton className="h-[32rem] rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
