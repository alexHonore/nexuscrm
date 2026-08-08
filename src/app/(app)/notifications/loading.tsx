import { Skeleton } from "@/components/ui/skeleton";

/** Squelette de la page Notifications : en-tête + rangées de notifications. */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6 md:px-8">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <Skeleton className="h-6 w-40 flex-1 md:max-w-48" />
        <Skeleton className="h-11 w-40 rounded-md md:h-8" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
    </div>
  );
}
