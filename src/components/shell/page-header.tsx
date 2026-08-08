import { cn } from "@/lib/utils";

/**
 * En-tête de page commun : titre en font-heading, sous-titre discret, pastille
 * d'icône teintée primary et emplacement d'actions à droite. Composant serveur
 * par défaut — les chaînes viennent du namespace de la page appelante.
 */
export function PageHeader({
  icon,
  title,
  titleAccessory,
  subtitle,
  actions,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  /** Élément purement décoratif affiché à côté du h1 (ex. badge compteur). */
  titleAccessory?: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {icon ? (
        <div
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-5"
        >
          {icon}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        {titleAccessory ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
            {titleAccessory}
          </div>
        ) : (
          <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
        )}
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
