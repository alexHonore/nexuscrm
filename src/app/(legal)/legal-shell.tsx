import Link from "next/link";
import { createTranslator } from "next-intl";
import { getLocale } from "next-intl/server";
import { cn } from "@/lib/utils";

/**
 * Ces pages existent pour des lecteurs SANS compte ni cookie (vérification
 * OAuth de Google, visiteur anonyme) : la langue doit donc pouvoir se forcer
 * par l'adresse — `?lang=` — comme sur /developers. Le cookie `NEXT_LOCALE`
 * ne sert que de repli, et `src/i18n/request.ts` (gelé) ignore une locale
 * explicite passée à `getTranslations` : on charge donc les messages du
 * namespace « legal » nous-mêmes.
 */
export type LegalLocale = "fr" | "en";

/** `?lang=` d'abord, cookie ensuite, français sinon. */
export async function resolveLegalLocale(lang: string | undefined): Promise<LegalLocale> {
  if (lang === "en" || lang === "fr") return lang;
  return (await getLocale()) === "en" ? "en" : "fr";
}

/** Traducteur du namespace « legal » pour une langue EXPLICITE. */
export async function legalTranslator(locale: LegalLocale) {
  const messages = (await import(`../../../messages/${locale}/legal.json`)).default;
  return createTranslator({ locale, messages: { legal: messages }, namespace: "legal" });
}

/** Coquille commune aux pages légales publiques (confidentialité, conditions). */
export async function LegalShell({
  locale,
  title,
  updated,
  children,
}: {
  locale: LegalLocale;
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  const t = await legalTranslator(locale);
  const other = locale === "en" ? "fr" : "en";

  return (
    <main className="min-h-dvh bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              N
            </span>
            <span className="text-base font-semibold tracking-tight">Groupe Nexus</span>
          </Link>
          {/* Un lien, pas un bouton : la page doit rester partageable dans la
              langue où on l'a lue — même choix que /developers. */}
          <Link
            href={`?lang=${other}`}
            className="text-sm font-medium text-primary hover:underline"
            hrefLang={other}
          >
            {other === "en" ? "English" : "Français"}
          </Link>
        </div>
      </header>

      <article className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("updated")} {updated}
        </p>
        <div className="mt-8 space-y-8 text-[15px] leading-relaxed">{children}</div>
      </article>

      <footer className="border-t bg-background">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} Groupe Nexus</span>
          <nav className="flex gap-4">
            {/* Les deux pages légales se relient dans la langue COURANTE :
                sans `?lang=`, passer de /privacy?lang=en à /terms retombait
                en français pour le lecteur sans cookie. Le lien /developers
                reste NU : unit-developers-page.test.ts vérifie ce libellé
                exact, et cette page résout sa langue elle-même. */}
            <Link href={`/privacy?lang=${locale}`} className="hover:text-foreground hover:underline">
              {t("privacy.short")}
            </Link>
            <Link href={`/terms?lang=${locale}`} className="hover:text-foreground hover:underline">
              {t("terms.short")}
            </Link>
            <Link href="/developers" className="hover:text-foreground hover:underline">
              {t("developers")}
            </Link>
            <Link href="/login" className="hover:text-foreground hover:underline">
              {t("backToApp")}
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}

/** Section titrée d'un document légal. */
export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight">{heading}</h2>
      {children}
    </section>
  );
}

export function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-muted-foreground", className)}>{children}</p>;
}

export function UL({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground marker:text-primary">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
