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
      {/*
        Sur téléphone, les actions prennent TOUTE une ligne, donc elles passent
        sous le titre au lieu de le comprimer.

        Le conteneur enveloppe déjà (`flex-wrap`), mais le bloc du titre est en
        `flex-1` : sa base vaut zéro, alors il rétrécit jusqu'à se chevaucher
        avec les actions plutôt que de les renvoyer à la ligne. Une base de
        100 % sur les ACTIONS force ce retour — l'icône et le titre gardent
        leur ligne, les boutons prennent la suivante. `md:w-auto` rend au
        bureau la mise en page d'avant, où tout tient sur une seule ligne.
      */}
      {actions ? (
        <div className="flex w-full shrink-0 items-center gap-2 md:w-auto">{actions}</div>
      ) : null}
    </div>
  );
}
