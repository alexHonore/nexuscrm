import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const t = await getTranslations("auth");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-sidebar via-sidebar to-primary p-4">
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
    </main>
  );
}
