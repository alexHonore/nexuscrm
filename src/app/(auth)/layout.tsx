import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * Gabarit commun des pages d'authentification : fond dégradé de marque, halos
 * décoratifs derrière la carte, centrage et pied de page légal — partagés par
 * connexion, mot de passe oublié et réinitialisation.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const tLegal = await getTranslations("legal");

  const legalLinkClass =
    "rounded-sm outline-none transition-colors hover:text-white hover:underline focus-visible:ring-2 focus-visible:ring-sidebar-ring";

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-sidebar via-sidebar to-primary p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 size-72 -translate-x-[115%] -translate-y-[85%] rounded-full bg-sidebar-primary/25 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 size-72 translate-x-[15%] -translate-y-[15%] rounded-full bg-primary/20 blur-3xl"
      />
      {children}
      <nav className="relative z-10 mt-6 flex items-center gap-4 text-xs text-white/70">
        <Link href="/privacy" className={legalLinkClass}>
          {tLegal("privacy.short")}
        </Link>
        <span aria-hidden>·</span>
        <Link href="/terms" className={legalLinkClass}>
          {tLegal("terms.short")}
        </Link>
        <span aria-hidden>·</span>
        <Link href="/developers" className={legalLinkClass}>
          {tLegal("developers")}
        </Link>
      </nav>
    </main>
  );
}
