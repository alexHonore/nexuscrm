import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Squelette du tableau de bord — reflète la silhouette réelle de la page. */
export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 md:px-8">
      {/* Salutation */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>

      {/* Recherche rapide */}
      <Skeleton className="h-11 w-full max-w-xl rounded-xl" />

      {/* Statistiques du jour */}
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

      {/* Suivis + rendez-vous */}
      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="shadow-xs">
            <CardHeader className="border-b">
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
