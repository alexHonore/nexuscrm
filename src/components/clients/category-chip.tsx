import { cn } from "@/lib/utils";

/**
 * Colored pipeline-category chip. Server- and client-safe (no hooks).
 * Color comes from categories.color (hex).
 */
export function CategoryChip({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 w-fit max-w-full items-center gap-1 truncate rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        className,
      )}
      style={{
        color,
        backgroundColor: `${color}1a`,
        borderColor: `${color}40`,
      }}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{name}</span>
    </span>
  );
}
