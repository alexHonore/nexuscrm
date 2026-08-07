import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ResetForm } from "./reset-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("reset.title") };
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getTranslations("auth");
  const { token } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-sidebar via-sidebar to-primary p-4">
      <div className="w-full max-w-sm rounded-2xl bg-card p-8 shadow-2xl">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground">
            N
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{t("reset.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("reset.subtitle")}</p>
        </div>
        {token ? (
          <ResetForm token={token} />
        ) : (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {t("reset.invalidToken")}
          </p>
        )}
        <p className="mt-6 text-center text-sm">
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t("forgot.backToLogin")}
          </Link>
        </p>
      </div>
    </main>
  );
}
