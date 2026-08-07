import Link from "next/link";
import { cn } from "@/lib/utils";
import { getLocale, getTranslations } from "next-intl/server";

/** Coquille commune aux pages légales publiques (confidentialité, conditions). */
export async function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations("legal");
  const locale = await getLocale();
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
            <Link href="/privacy" className="hover:text-foreground hover:underline">
              {t("privacy.short")}
            </Link>
            <Link href="/terms" className="hover:text-foreground hover:underline">
              {t("terms.short")}
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
