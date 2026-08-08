import { cn } from "@/lib/utils";

/**
 * Carte d'authentification partagée — logo « N », titre, sous-titre et contenu.
 * Purement présentationnelle (composant serveur) ; les chaînes viennent de la
 * page appelante.
 */
export function AuthCard({
  title,
  subtitle,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative z-10 w-full max-w-sm rounded-2xl bg-card p-8 shadow-2xl shadow-black/40 ring-1 ring-white/10",
        className,
      )}
    >
      <div className="mb-8 text-center">
        <div
          aria-hidden
          className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-sidebar-primary to-primary text-xl font-bold text-primary-foreground shadow-lg shadow-primary/40"
        >
          N
        </div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}
