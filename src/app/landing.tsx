import Link from "next/link";
import {
  CalendarCheck,
  ChartNoAxesColumn,
  PhoneCall,
  ShieldCheck,
  UsersRound,
  Webhook,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";


const FEATURE_ICONS = [PhoneCall, CalendarCheck, UsersRound, Webhook, ChartNoAxesColumn, ShieldCheck];

/**
 * Page d'accueil PUBLIQUE — explique la raison d'être de l'application.
 * Exigée par la vérification OAuth de Google (« votre page d'accueil doit
 * expliquer l'objet de votre application » et porter le même nom que l'app).
 */
export async function LandingPage() {
  const t = await getTranslations("home");
  const features = t.raw("features") as { title: string; body: string }[];

  return (
    <main className="min-h-dvh bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-5 py-4">
          <span className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              N
            </span>
            <span className="text-base font-semibold tracking-tight">Groupe Nexus</span>
          </span>
          <Button size="sm" render={<Link href="/login" />}>
            {t("signIn")}
          </Button>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-5 py-16 md:py-24">
        <p className="text-sm font-medium text-primary">{t("eyebrow")}</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight md:text-5xl">
          Groupe Nexus — {t("tagline")}
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted-foreground">{t("purpose")}</p>
        <p className="mt-4 max-w-2xl text-muted-foreground">{t("audience")}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button size="lg" className="h-12 px-6" render={<Link href="/login" />}>
            {t("signIn")}
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="h-12 px-6"
            render={<Link href="/privacy" />}
          >
            {t("readPrivacy")}
          </Button>
        </div>
      </section>

      <section className="border-t bg-muted/30">
        <div className="mx-auto max-w-5xl px-5 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">{t("featuresTitle")}</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f, i) => {
              const Icon = FEATURE_ICONS[i] ?? PhoneCall;
              return (
                <div key={f.title} className="rounded-xl border bg-background p-5">
                  <Icon className="size-5 text-primary" />
                  <h3 className="mt-3 font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-t">
        <div className="mx-auto max-w-5xl px-5 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">{t("googleTitle")}</h2>
          <p className="mt-4 max-w-3xl text-muted-foreground">{t("googleBody")}</p>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{t("googleLimited")}</p>
        </div>
      </section>

      <footer className="border-t bg-muted/30">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-8 text-sm text-muted-foreground">
          <span>
            © {new Date().getFullYear()} Groupe Nexus · {t("contact")}
          </span>
          <nav className="flex gap-4">
            <Link href="/privacy" className="hover:text-foreground hover:underline">
              {t("privacy")}
            </Link>
            <Link href="/terms" className="hover:text-foreground hover:underline">
              {t("terms")}
            </Link>
            {/* La référence d'intégration se trouve depuis l'extérieur ou pas
                du tout : celui qui la cherche n'a pas de compte, et n'a donc
                que cette page pour tomber dessus. */}
            <Link href="/developers" className="hover:text-foreground hover:underline">
              {t("developers")}
            </Link>
            <Link href="/login" className="hover:text-foreground hover:underline">
              {t("signIn")}
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
