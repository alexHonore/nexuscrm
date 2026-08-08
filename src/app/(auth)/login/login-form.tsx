"use client";

import { Loader2, Lock, Mail } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction, type LoginState } from "./actions";

const FIELD_ICON_CLASS =
  "pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground";

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
        <div className="relative">
          <Mail aria-hidden className={FIELD_ICON_CLASS} />
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            autoFocus
            className="h-11 rounded-xl pl-9"
          />
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="password">{t("password")}</Label>
          <Link
            href="/forgot-password"
            className="text-xs font-medium text-primary hover:underline"
          >
            {t("forgot.link")}
          </Link>
        </div>
        <div className="relative">
          <Lock aria-hidden className={FIELD_ICON_CLASS} />
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="h-11 rounded-xl pl-9"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="remember" name="remember" defaultChecked />
        <Label htmlFor="remember" className="font-normal">
          {t("remember")}
        </Label>
      </div>
      {errorMessage ? (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive"
          role="alert"
        >
          {errorMessage}
        </p>
      ) : null}
      <Button type="submit" className="h-12 w-full text-base" disabled={pending}>
        {pending ? (
          <>
            <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
            {t("signingIn")}
          </>
        ) : (
          t("signIn")
        )}
      </Button>
    </form>
  );
}
