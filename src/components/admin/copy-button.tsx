"use client";

import { Check, Copy } from "lucide-react";
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
      className={cn("min-h-8", className)}
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
