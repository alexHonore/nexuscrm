import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth/guards";
import { afterLoginPath } from "@/lib/auth/next-path";
import { AuthCard } from "../auth-card";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("pageTitle") };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // `next` porte la fiche que la notification désignait. Une session encore
  // valide n'a aucune raison de repasser par le formulaire : on l'y emmène
  // directement, sinon ouvrir une notification pendant qu'on est déjà connecté
  // afficherait un écran de connexion pour rien.
  const { next } = await searchParams;
  const target = afterLoginPath(next);
  const user = await getCurrentUser();
  if (user) redirect(target);
  const t = await getTranslations("auth");

  return (
    <AuthCard title="Groupe Nexus" subtitle={t("subtitle")}>
      <LoginForm next={target} />
    </AuthCard>
  );
}
