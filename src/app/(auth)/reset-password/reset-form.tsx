"use client";

import { CircleCheckBig, Loader2, Lock } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { applyResetAction, type ResetState } from "@/app/(auth)/forgot-password/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const FIELD_ICON_CLASS =
  "pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground";

export function ResetForm({ token }: { token: string }) {
  const t = useTranslations("auth");
  const [state, formAction, pending] = useActionState<ResetState, FormData>(applyResetAction, null);

  if (state && "done" in state) {
    return (
      <div className="space-y-4 text-center">
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
          <CircleCheckBig className="mx-auto mb-2 size-7 text-emerald-600 dark:text-emerald-400" />
          <p className="text-sm font-medium">{t("reset.doneTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("reset.doneBody")}</p>
        </div>
        <Button className="h-12 w-full text-base" render={<Link href="/login" />}>
          {t("signIn")}
        </Button>
      </div>
    );
  }

  const error =
    state?.error === "invalid_token"
      ? t("reset.invalidToken")
      : state?.error === "weak"
        ? t("reset.weak")
        : state?.error === "mismatch"
          ? t("reset.mismatch")
          : null;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <div className="space-y-2">
        <Label htmlFor="password">{t("reset.newPassword")}</Label>
        <div className="relative">
          <Lock aria-hidden className={FIELD_ICON_CLASS} />
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            autoFocus
            className="h-11 rounded-xl pl-9"
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("reset.hint")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">{t("reset.confirmPassword")}</Label>
        <div className="relative">
          <Lock aria-hidden className={FIELD_ICON_CLASS} />
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            className="h-11 rounded-xl pl-9"
          />
        </div>
      </div>
      {error ? (
        <p
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <Button type="submit" className="h-12 w-full text-base" disabled={pending}>
        {pending ? (
          <>
            <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
            {t("reset.saving")}
          </>
        ) : (
          t("reset.submit")
        )}
      </Button>
    </form>
  );
}
