import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { AuthCard } from "../auth-card";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("pageTitle") };
}

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const t = await getTranslations("auth");

  return (
    <AuthCard title="Groupe Nexus" subtitle={t("subtitle")}>
      <LoginForm />
    </AuthCard>
  );
}
