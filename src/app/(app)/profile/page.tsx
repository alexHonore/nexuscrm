import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/guards";
import { ProfileForm } from "@/components/profile/profile-form";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/phone";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** « Mon profil » — accessible à tous les rôles depuis le menu utilisateur. */
export default async function ProfilePage() {
  const user = await requireUser();
  const t = await getTranslations("common");

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-4 md:px-6 md:py-6">
      <div className="flex items-center gap-3">
        <Avatar className="size-12">
          <AvatarFallback className="bg-primary text-sm text-primary-foreground">
            {initials(user.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <h1 className="truncate font-heading text-xl font-semibold tracking-tight">
            {user.name}
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="secondary">
              {user.role === "admin" ? t("roleAdmin") : t("roleCaller")}
            </Badge>
            {user.didNumber ? (
              <span className="tabular-nums">
                {t("profile.lineNumber")} : {formatPhone(user.didNumber)}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <ProfileForm initialName={user.name} initialEmail={user.email} />
    </div>
  );
}
