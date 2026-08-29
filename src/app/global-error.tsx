"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import enCommon from "../../messages/en/common.json";
import frCommon from "../../messages/fr/common.json";
import "./globals.css";

/**
 * La dernière page de l'application — celle qui s'affiche quand la coquille
 * elle-même n'a pas tenu.
 *
 * `src/app/(app)/error.tsx` couvre les écrans ; il ne couvre PAS le gabarit
 * au-dessus de lui. Or c'est justement là que vit ce qui casse le plus
 * durement : `requireUser()`, le comptage des non-lues, le fournisseur de
 * téléphonie. Une base injoignable ne produit donc pas un écran fautif dans une
 * application intacte — elle emporte le document entier, et ce fichier est tout
 * ce qui reste.
 *
 * Trois décisions, toutes commandées par ce moment-là :
 *
 * · **Ses propres `<html>` et `<body>`.** Next l'exige : cette page REMPLACE le
 *   gabarit racine. Elle doit donc importer les styles elle-même — ils ne lui
 *   sont pas transmis — et redonner à `--font-sans` une valeur réelle : la
 *   variable de `globals.css` (gelé) se référence elle-même et n'est résolue
 *   que par la police de `layout.tsx`, qui n'existe plus ici. Sans cette ligne,
 *   l'écran de panne s'afficherait en Times.
 * · **Aucun `next-intl`.** Le fournisseur vivait dans le gabarit racine : le
 *   crochet `useTranslations` lèverait, à l'intérieur de la frontière d'erreur,
 *   ce qui produit une page blanche et une boucle. Les textes sont donc lus
 *   DIRECTEMENT dans `messages/{fr,en}/common.json` — la même source unique
 *   qu'ailleurs (règle 2), simplement sans intermédiaire qui puisse tomber. Le
 *   ternaire sur deux fichiers importés a un effet secondaire heureux : une
 *   clé oubliée d'un côté ne compile pas.
 * · **Le français par défaut.** La langue se lit dans le cookie APRÈS le
 *   montage — pendant le rendu, il n'y a rien de fiable à lire, et trancher au
 *   rendu produirait une discordance d'hydratation sur la page dont le seul
 *   travail est de ne pas retomber en panne. Le français est la source (règle
 *   2), c'est donc lui qui s'affiche en premier.
 */

const emptySubscribe = () => () => {};

/**
 * La langue du cookie, lue depuis le navigateur et de nulle part ailleurs.
 *
 * `useSyncExternalStore` plutôt qu'un `setState` dans un effet : c'est le
 * patron déjà employé dans les écrans clients du dépôt (`saved-views.tsx`,
 * `client-card.tsx`), et le seul qui donne au serveur une réponse DIFFÉRENTE
 * (le français) sans creuser d'écart d'hydratation.
 */
function readLocale(): "fr" | "en" {
  try {
    return /(?:^|;\s*)NEXT_LOCALE=en(?:\s*;|$)/.test(document.cookie) ? "en" : "fr";
  } catch {
    // Cookies inaccessibles : le français, comme partout ailleurs.
    return "fr";
  }
}

/** Le rendu serveur ne lit rien : le français est la source (règle 2). */
const serverLocale = (): "fr" | "en" => "fr";

/**
 * La pile de polices de secours.
 *
 * `globals.css` (gelé) déclare `--font-sans: var(--font-sans)` : la variable ne
 * vaut quelque chose que parce que `layout.tsx` pose dessus celle de next/font
 * — et ce gabarit-là vient précisément d'être remplacé. Sans cette valeur, la
 * page de panne s'afficherait dans le serif par défaut du navigateur.
 */
const FALLBACK_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export default function GlobalError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  /** Next 16.3 : refait la requête ET le rendu, ce qu'il faut après un réseau perdu. */
  retry?: () => void;
  /** L'ancien geste, gardé en repli : vide l'état de la frontière. */
  reset: () => void;
}) {
  const locale = useSyncExternalStore(emptySubscribe, readLocale, serverLocale);

  useEffect(() => {
    // La console est le seul endroit où le message complet survit côté client.
    // Sur un téléphone branché en débogage, c'est parfois le seul témoin.
    console.error(error);
  }, [error]);

  const t = (locale === "en" ? enCommon : frCommon).errorScreen;

  return (
    <html lang={locale} style={{ "--font-sans": FALLBACK_FONT } as React.CSSProperties}>
      <body className="antialiased">
        {/* `metadata` n'existe pas dans un composant client : c'est React qui pose le titre. */}
        <title>{t.criticalTitle}</title>

        <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 p-6">
          <div className="w-full max-w-sm rounded-2xl bg-card p-8 text-center ring-1 ring-foreground/10">
            <div
              aria-hidden
              className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-6"
            >
              <TriangleAlert />
            </div>

            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {t.criticalTitle}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{t.criticalHint}</p>

            <div className="mt-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => (retry ?? reset)()}
                className={cn(buttonVariants({ size: "lg" }), "min-h-11 w-full")}
              >
                {t.retry}
              </button>
              {/*
                Le rechargement complet est le seul geste qui reprenne TOUT —
                fragments de code compris. Après un déploiement, un onglet resté
                ouvert demande des fichiers qui n'existent plus : c'est
                exactement cette panne-là, et « Réessayer » seul n'en sortirait
                jamais.
              */}
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={cn(buttonVariants({ variant: "outline", size: "lg" }), "min-h-11 w-full")}
              >
                {t.reload}
              </button>
            </div>

            {/* Une ancre nue : il n'y a plus de routeur à qui confier ce lien. */}
            <a
              href="/dashboard"
              className="mt-4 inline-block text-sm text-muted-foreground underline underline-offset-4"
            >
              {t.home}
            </a>

            {error.digest ? (
              <p className="mt-4 text-xs text-muted-foreground">
                {t.reference.replace("{digest}", error.digest)}
              </p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
