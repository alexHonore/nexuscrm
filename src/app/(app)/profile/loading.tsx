import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Silhouette de « Mon profil » : en-tête, les deux cartes de formulaire
 * (identité / mot de passe), puis les cinq cartes de notifications — mêmes
 * dimensions que la page réelle.
 *
 * La section des notifications est esquissée elle aussi parce qu'elle lit la
 * base (appareils inscrits, joignabilité) et les réglages : c'est la moitié
 * lente de l'écran, celle qu'on regarde arriver.
 */
export default function ProfileLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-4 md:px-6 md:py-6">
      {/* ── En-tête ── */}
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-4 w-36" />
        </div>
      </div>

      {/* ── Cartes identité + mot de passe ── */}
      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        {[2, 3].map((fields, i) => (
          <Card key={i} className="shadow-xs">
            <CardHeader className="border-b">
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: fields }, (_, j) => (
                <div key={j} className="space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-11 w-full rounded-lg md:h-9" />
                </div>
              ))}
              <Skeleton className="h-11 w-32 rounded-lg md:h-9" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Section « Notifications » : titre puis les cinq cartes ── */}
      <div className="space-y-1">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        {[2, 3, 4, 3, 3].map((lines, i) => (
          <Card key={i} className="shadow-xs">
            <CardHeader className="border-b">
              <Skeleton className="h-5 w-36" />
            </CardHeader>
            <CardContent className="space-y-3">
              {Array.from({ length: lines }, (_, j) => (
                <Skeleton key={j} className="h-11 w-full rounded-lg md:h-9" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
