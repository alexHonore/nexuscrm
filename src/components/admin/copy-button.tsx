"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "./api";

export function CopyButton({
  value,
  label,
  className,
  variant = "outline",
  size = "sm",
}: {
  value: string;
  label?: string;
  className?: string;
  variant?: "outline" | "ghost" | "secondary";
  size?: "sm" | "xs" | "icon-sm" | "default";
}) {
  const t = useTranslations("admin");
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      toast.success(t("copied"));
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn("min-h-11 md:min-h-8", className)}
      onClick={onCopy}
      aria-label={label ?? t("copy")}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {label !== undefined ? label : t("copy")}
    </Button>
  );
}

/** Bloc « secret affiché une seule fois » : grande valeur mono + bouton copier. */
export function OneTimeSecret({ value, hint }: { value: string; hint?: string }) {
  const t = useTranslations("admin");
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-dashed bg-muted/50 p-3">
        <code className="block break-all text-center font-mono text-base font-semibold select-all">
          {value}
        </code>
      </div>
      <div className="flex items-center justify-center">
        <CopyButton value={value} label={t("copy")} />
      </div>
      <p className="text-center text-xs text-muted-foreground">{hint ?? t("shownOnce")}</p>
    </div>
  );
}

/**
 * Identifiants de connexion affichés une seule fois : le COURRIEL est montré
 * aussi visiblement que le mot de passe, et copié avec lui.
 *
 * Sans cela, une adresse mal saisie à la création passe inaperçue et l'admin
 * croit que le mot de passe généré est cassé (incident vécu en production).
 */
export function LoginCredentials({
  email,
  password,
  hint,
}: {
  email: string;
  password: string;
  hint?: string;
}) {
  const t = useTranslations("admin");
  const bothLines = `${t("users.credentials.emailPrefix")} : ${email}\n${t("users.credentials.passwordPrefix")} : ${password}`;

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-lg border border-dashed bg-muted/50 p-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("users.credentials.loginEmail")}</p>
          <code className="block break-all font-mono text-sm font-semibold select-all">{email}</code>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("users.credentials.password")}</p>
          <code className="block break-all font-mono text-base font-semibold select-all">{password}</code>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <CopyButton
          value={bothLines}
          label={t("users.credentials.copyBoth")}
          variant="secondary"
          className="min-h-11 md:min-h-8"
        />
        <CopyButton
          value={password}
          label={t("users.credentials.copyPasswordOnly")}
          className="min-h-11 md:min-h-8"
        />
      </div>

      <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        <span>{t("users.credentials.verifyEmail")}</span>
      </p>
      <p className="text-center text-xs text-muted-foreground">{hint ?? t("shownOnce")}</p>
    </div>
  );
}
