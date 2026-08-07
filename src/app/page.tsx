import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/guards";
import { LandingPage } from "./landing";

/**
 * Racine : page d'accueil PUBLIQUE (exigée par la vérification Google OAuth —
 * elle doit expliquer l'objet de l'application). Les personnes déjà connectées
 * vont directement au tableau de bord.
 */
export default async function Home() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  return <LandingPage />;
}
