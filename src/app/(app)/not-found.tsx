import { LayoutDashboard, SearchX } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * « Il n'y a rien ici » — et c'est tout ce que cet écran a le droit de dire.
 *
 * Il sert deux situations que l'application doit rendre INDISCERNABLES (règle
 * 1) : une adresse qui n'existe pas, et une fiche qu'on n'a pas le droit de
 * voir. Un `notFound()` est justement ce que renvoient les gardes de
 * visibilité, parce qu'un refus explicite confirmerait l'existence de la fiche
 * — « ce client existe, mais pas pour vous » est déjà une fuite. Le texte ne
 * parle donc jamais de droits, ni de permission, ni de compte : il parle d'un
 * lien qui ne mène nulle part.
 *
 * Composant serveur : il n'a rien à faire côté client, et le rendre statique
 * évite d'expédier du JavaScript pour une impasse.
 */
export default async function AppNotFound() {
  const t = await getTranslations("common");

  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center py-10">
      <EmptyState
        icon={<SearchX />}
        title={t("notFound")}
        hint={t("errorScreen.notFoundHint")}
        action={
          <Button size="lg" className="min-h-11" render={<Link href="/dashboard" />}>
            <LayoutDashboard aria-hidden />
            {t("errorScreen.home")}
          </Button>
        }
      />
    </div>
  );
}
