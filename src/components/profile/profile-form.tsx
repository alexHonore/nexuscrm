"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { changePasswordAction, updateProfileAction } from "@/app/(app)/profile/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Formulaires « Mon profil » : identité (nom / courriel) et mot de passe. */
export function ProfileForm({ initialName, initialEmail }: { initialName: string; initialEmail: string }) {
  const t = useTranslations("common");
  const router = useRouter();

  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [savingProfile, startProfile] = useTransition();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [savingPassword, startPassword] = useTransition();

  const saveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    startProfile(async () => {
      const res = await updateProfileAction({ name, email });
      if (res.ok) {
        toast.success(t("profile.saved"));
        // Le nom en bas de la barre latérale vient du serveur.
        router.refresh();
      } else {
        toast.error(res.error === "emailTaken" ? t("profile.emailTaken") : t("error"));
      }
    });
  };

  const savePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      toast.error(t("profile.passwordMismatch"));
      return;
    }
    startPassword(async () => {
      const res = await changePasswordAction({ current, next });
      if (res.ok) {
        toast.success(t("profile.passwordChanged"));
        setCurrent("");
        setNext("");
        setConfirm("");
      } else {
        toast.error(res.error === "wrongPassword" ? t("profile.wrongPassword") : t("error"));
      }
    });
  };

  const field = "min-h-11 md:min-h-9";

  return (
    <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
      <Card className="shadow-xs">
        <CardHeader className="border-b">
          <CardTitle>{t("profile.identityTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveProfile} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name">{t("profile.name")}</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                autoComplete="name"
                className={field}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-email">{t("profile.email")}</Label>
              <Input
                id="profile-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={200}
                autoComplete="email"
                className={field}
              />
            </div>
            <Button type="submit" disabled={savingProfile} className={field}>
              {t("profile.save")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="shadow-xs">
        <CardHeader className="border-b">
          <CardTitle>{t("profile.passwordTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={savePassword} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile-current">{t("profile.currentPassword")}</Label>
              <Input
                id="profile-current"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                required
                autoComplete="current-password"
                className={field}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-next">{t("profile.newPassword")}</Label>
              <Input
                id="profile-next"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                required
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                className={field}
              />
              <p className="text-xs text-muted-foreground">{t("profile.passwordRule")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-confirm">{t("profile.confirmPassword")}</Label>
              <Input
                id="profile-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                className={field}
              />
            </div>
            <Button type="submit" disabled={savingPassword} className={field}>
              {t("profile.change")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
