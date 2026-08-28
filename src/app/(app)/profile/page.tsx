import { UserRound } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { ProfileForm } from "@/components/profile/profile-form";
import { LookGlyph, roleLook } from "@/components/look";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/phone";
import { requireActor } from "@/lib/permissions/server";

/** « Mon profil » — accessible à tous les rôles depuis le menu utilisateur. */
export default async function ProfilePage() {
  // L'acteur plutôt que le compte seul : la pastille annonce le rôle CONFIGURÉ
  // (« Superviseur », « Observateur », celui inventé ce matin), pas le plancher
  // administrateur/téléphoniste de la base — deux personnes de la même colonne
  // `users.role` n'ont plus du tout les mêmes droits.
  const actor = await requireActor();
  const user = actor.user;
  const t = await getTranslations("common");
  const locale = await getLocale();
  const roleName = locale === "en" ? actor.role.nameEn : actor.role.nameFr;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-4 md:px-6 md:py-6">
      <PageHeader
        icon={<UserRound />}
        title={user.name}
        titleAccessory={
          <Badge variant="secondary" className="gap-1.5">
            <LookGlyph look={roleLook(actor.role.look)} className="size-3" />
            {roleName}
          </Badge>
        }
        subtitle={
          user.didNumber
            ? `${t("profile.lineNumber")} : ${formatPhone(user.didNumber)}`
            : undefined
        }
      />

      <ProfileForm initialName={user.name} initialEmail={user.email} />
    </div>
  );
}
