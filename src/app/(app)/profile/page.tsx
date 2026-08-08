import { UserRound } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/guards";
import { ProfileForm } from "@/components/profile/profile-form";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/phone";

/** « Mon profil » — accessible à tous les rôles depuis le menu utilisateur. */
export default async function ProfilePage() {
  const user = await requireUser();
  const t = await getTranslations("common");

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-4 md:px-6 md:py-6">
      <PageHeader
        icon={<UserRound />}
        title={user.name}
        titleAccessory={
          <Badge variant="secondary">
            {user.role === "admin" ? t("roleAdmin") : t("roleCaller")}
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
