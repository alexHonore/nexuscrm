import type { Metadata } from "next";
import { WifiOff } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * L'écran que le service worker sert quand une navigation n'aboutit pas.
 *
 * Trois contraintes, toutes dictées par le moment où cette page s'affiche —
 * c'est-à-dire le moment où plus rien ne répond :
 *
 * 1. **Publique.** `src/proxy.ts` la laisse passer sans cookie. Derrière la
 *    session, elle serait redirigée vers /login au moment de sa mise en cache
 *    et ne s'afficherait donc jamais.
 * 2. **Autonome.** Aucune donnée, aucune session, aucun appel réseau : elle est
 *    mise en cache une fois pour toutes à l'installation du worker
 *    (`SHELL_ASSETS`), et elle doit rester juste des mois plus tard.
 * 3. **Sans JavaScript.** Le worker ne garde QUE ce document — pas les fragments
 *    de code de Next. Hors réseau, ces fragments ne se chargent pas : un bouton
 *    « Réessayer » écrit en composant client n'aurait jamais son gestionnaire
 *    et ne ferait rien du tout, ce qui est pire que pas de bouton. On s'en tient
 *    donc à une ancre HTML : la toucher déclenche une vraie navigation, donc une
 *    vraie tentative réseau.
 *
 * La langue est celle de qui a installé l'application : la copie en cache est
 * figée au moment de l'installation du worker. C'est acceptable — un téléphone
 * a un propriétaire — et c'est le prix de l'autonomie.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return { title: t("offline.title"), robots: { index: false, follow: false } };
}

export default async function OfflinePage() {
  const t = await getTranslations("common");

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-card p-8 text-center ring-1 ring-foreground/10">
        <div
          aria-hidden
          className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-6"
        >
          <WifiOff />
        </div>

        <h1 className="font-heading text-xl font-semibold tracking-tight">{t("offline.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("offline.hint")}</p>
        <p className="mt-2 text-sm text-muted-foreground">{t("offline.reassure")}</p>

        {/*
          Une ancre ordinaire, pas un <Link> : la navigation cliente de Next
          irait chercher une charge RSC qui, hors réseau, échoue autrement — et
          l'écran resterait figé sans rien dire. Ici, la tentative est franche.
        */}
        <a
          href="/dashboard"
          className={cn(buttonVariants({ size: "lg" }), "mt-6 min-h-11 w-full")}
        >
          {t("offline.retry")}
        </a>

        {/* Ce que veut dire « il ne s'est rien passé » quand on touche le bouton. */}
        <p className="mt-3 text-xs text-muted-foreground">{t("offline.retryHint")}</p>
      </div>
    </main>
  );
}
