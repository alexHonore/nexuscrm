"use client";

import { LayoutDashboard, RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Ce qui s'affiche quand un écran de l'application tombe.
 *
 * Il n'existait aucune frontière d'erreur dans tout `src/app` : une requête qui
 * lève, un appel à Google qui expire, et le téléphoniste recevait la page
 * d'erreur brute de Next. Dans un onglet, c'est laid ; dans l'application
 * INSTALLÉE, c'est un cul-de-sac — il n'y a plus de barre d'adresse, plus de
 * bouton « précédent », plus rien à toucher pour revenir.
 *
 * La frontière est ici, dans le groupe (app), et pas à la racine : elle est
 * ainsi rendue DANS la coquille, donc avec la barre de navigation basse et le
 * menu latéral. L'écran fautif est remplacé, le reste de l'application tient
 * debout.
 *
 * Ce que cette page NE fait pas : afficher `error.message`. En production, Next
 * ne transmet plus le message d'une erreur serveur (il fuirait des noms de
 * colonnes, des adresses internes, parfois un fragment de données client) et ne
 * laisse que `digest`. C'est donc `digest` qu'on montre — un identifiant qui ne
 * dit rien à qui le lit, mais qui retrouve la ligne exacte dans les journaux du
 * serveur.
 */
export default function AppError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  /**
   * Depuis Next 16.3 : refait la requête ET le rendu du segment. C'est ce qu'il
   * faut ici — la cause la plus fréquente sur un téléphone est un réseau qui a
   * lâché en route, et seule une nouvelle requête peut y remédier.
   */
  retry?: () => void;
  /** L'ancien geste : vide l'état de la frontière sans rien redemander. */
  reset: () => void;
}) {
  useEffect(() => {
    // La console est le seul endroit où le message complet survit côté client,
    // et un téléphone branché en débogage est parfois le seul témoin qu'on ait.
    console.error(error);
  }, [error]);

  const t = useTranslations("common");

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center py-10">
      <EmptyState
        icon={<TriangleAlert />}
        title={t("error")}
        hint={t("errorScreen.hint")}
        action={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              size="lg"
              className="min-h-11"
              onClick={() => (retry ?? reset)()}
            >
              <RotateCcw aria-hidden />
              {t("errorScreen.retry")}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="min-h-11"
              render={<Link href="/dashboard" />}
            >
              <LayoutDashboard aria-hidden />
              {t("errorScreen.home")}
            </Button>
          </div>
        }
      />

      {error.digest ? (
        <p className="px-6 text-center text-xs text-muted-foreground">
          {t("errorScreen.reference", { digest: error.digest })}
        </p>
      ) : null}
    </div>
  );
}
