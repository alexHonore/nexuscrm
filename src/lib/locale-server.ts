import "server-only";
import { cookies } from "next/headers";
import { docLocale, type DocLocale } from "@/lib/docs/types";

/**
 * La langue de la requête, pour du code serveur qui n'est pas un composant.
 *
 * `getLocale()` de next-intl est fait pour les composants serveur ; dans une
 * ROUTE (`app/api/**`) il dépend de la résolution « react-server » du paquet,
 * et il lève « not supported in Client Components » dès qu'on l'exécute hors
 * de ce contexte — un test, par exemple. Une route qui explose en rendant un
 * diagnostic d'erreur est le pire endroit possible pour cette fragilité.
 *
 * On lit donc le cookie directement, exactement comme `src/i18n/request.ts` :
 * même source, même défaut français, et un code qu'on peut exécuter partout.
 */
export async function requestDocLocale(): Promise<DocLocale> {
  const store = await cookies();
  return docLocale(store.get("NEXT_LOCALE")?.value ?? "");
}
