"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const t = useTranslations("auth");
  const [state, formAction, pending] = useActionState<LoginState, FormData>(loginAction, null);

  const errorMessage =
    state?.error === "invalid"
      ? t("invalidCredentials")
      : state?.error === "disabled"
        ? t("accountDisabled")
        : state?.error === "throttled"
          ? t("tooManyAttempts")
          : null;

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t("password")}</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="remember" name="remember" defaultChecked />
        <Label htmlFor="remember" className="font-normal">
          {t("remember")}
        </Label>
      </div>
      {errorMessage ? (
        <p className="text-sm font-medium text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <Button type="submit" className="w-full" size="lg" disabled={pending}>
        {pending ? t("signingIn") : t("signIn")}
      </Button>
    </form>
  );
}
