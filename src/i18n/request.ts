import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

export const LOCALES = ["fr", "en"] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "fr";

/**
 * Un fichier JSON par module et par langue (messages/<locale>/<ns>.json).
 * Chaque module remplit son propre namespace — usage : useTranslations("clients").
 */
const NAMESPACES = [
  "common",
  "auth",
  "legal",
  "home",
  "dashboard",
  "clients",
  "pipeline",
  "phone",
  "booking",
  "admin",
  "analytics",
  "notifications",
  "assistants",
  "campaigns",
] as const;

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get("NEXT_LOCALE")?.value;
  const locale: AppLocale = cookieLocale === "en" ? "en" : "fr";

  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => {
      const mod = await import(`../../messages/${locale}/${ns}.json`);
      return [ns, mod.default] as const;
    }),
  );

  return {
    locale,
    messages: Object.fromEntries(entries),
    timeZone: "America/Toronto",
  };
});
