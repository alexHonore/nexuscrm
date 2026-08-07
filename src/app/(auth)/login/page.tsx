import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("pageTitle") };
}

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const t = await getTranslations("auth");
  const tLegal = await getTranslations("legal");

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-br from-sidebar via-sidebar to-primary p-4">
      <div className="w-full max-w-sm rounded-2xl bg-card p-8 shadow-2xl">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground">
            N
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Groupe Nexus</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <LoginForm />
      </div>
      <nav className="mt-6 flex items-center gap-4 text-xs text-white/70">
        <Link href="/privacy" className="hover:text-white hover:underline">
          {tLegal("privacy.short")}
        </Link>
        <span aria-hidden>·</span>
        <Link href="/terms" className="hover:text-white hover:underline">
          {tLegal("terms.short")}
        </Link>
      </nav>
    </main>
  );
}
