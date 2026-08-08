import { Skeleton } from "@/components/ui/skeleton";

/** Squelette de la page Rendez-vous : en-tête + groupes de jours + cartes. */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6 pb-safe md:px-8">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
      <div className="space-y-6">
        <section className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </section>
        <section className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </section>
      </div>
    </div>
  );
}
