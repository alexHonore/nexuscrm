import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ForgotForm } from "./forgot-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("forgot.title") };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations("auth");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-sidebar via-sidebar to-primary p-4">
      <div className="w-full max-w-sm rounded-2xl bg-card p-8 shadow-2xl">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground">
            N
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t("forgot.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("forgot.subtitle")}</p>
        </div>
        <ForgotForm />
        <p className="mt-6 text-center text-sm">
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t("forgot.backToLogin")}
          </Link>
        </p>
      </div>
    </main>
  );
}
