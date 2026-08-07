"use client";

import { MailCheck } from "lucide-react";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestResetAction, type ForgotState } from "./actions";

export function ForgotForm() {
  const t = useTranslations("auth");
  const [state, formAction, pending] = useActionState<ForgotState, FormData>(
    requestResetAction,
    null,
  );

  if (state && "done" in state) {
    return (
      <div className="space-y-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-center">
        <MailCheck className="mx-auto size-7 text-emerald-600 dark:text-emerald-400" />
        <p className="text-sm font-medium">{t("forgot.sentTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("forgot.sentBody")}</p>
      </div>
    );
  }

  const error =
    state?.error === "throttled"
      ? t("forgot.throttled")
      : state?.error === "unavailable"
        ? t("forgot.unavailable")
        : state?.error === "invalid"
          ? t("forgot.invalidEmail")
          : null;

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          autoFocus
          className="h-11"
        />
      </div>
      {error ? (
        <p className="text-sm font-medium text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="h-11 w-full" disabled={pending}>
        {pending ? t("forgot.sending") : t("forgot.submit")}
      </Button>
    </form>
  );
}
