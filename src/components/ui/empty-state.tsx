import { cn } from "@/lib/utils";

/**
 * État vide standard : pastille d'icône, titre, complément optionnel et action.
 * Purement présentationnel — les chaînes viennent du namespace de l'appelant.
 */
function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn("flex flex-col items-center gap-3 px-6 py-12 text-center", className)}
    >
      <div
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-gradient-to-b from-muted to-muted/40 ring-1 ring-border/60 [&_svg]:size-5 [&_svg]:text-muted-foreground"
      >
        {icon}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export { EmptyState };
