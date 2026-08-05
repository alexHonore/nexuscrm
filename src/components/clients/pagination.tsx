import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Server-side pagination links; preserves the current query string. */
export function Pagination({
  page,
  pages,
  basePath,
  params,
  labels,
}: {
  page: number;
  pages: number;
  basePath: string;
  params: Record<string, string>;
  labels: { previous: string; next: string; page: string };
}) {
  if (pages <= 1) return null;

  const href = (p: number) => {
    const sp = new URLSearchParams(params);
    if (p > 1) sp.set("page", String(p));
    else sp.delete("page");
    const qs = sp.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <nav className="flex items-center justify-between gap-2 pt-2">
      <Button
        variant="outline"
        className="min-h-11 md:min-h-8"
        disabled={page <= 1}
        render={page > 1 ? <Link href={href(page - 1)} /> : undefined}
      >
        <ChevronLeftIcon />
        {labels.previous}
      </Button>
      <span className="text-sm text-muted-foreground tabular-nums">{labels.page}</span>
      <Button
        variant="outline"
        className="min-h-11 md:min-h-8"
        disabled={page >= pages}
        render={page < pages ? <Link href={href(page + 1)} /> : undefined}
      >
        {labels.next}
        <ChevronRightIcon />
      </Button>
    </nav>
  );
}
