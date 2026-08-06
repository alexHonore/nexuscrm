"use client";

import { PhoneIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTelephony } from "@/components/telephony/telephony-context";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * « Rappeler » — relance un appel via le webphone (useTelephony().dial).
 * Cible tactile ≥ 44 px partout ; désactivé avec infobulle quand la ligne
 * n'est pas prête (non configurée ou non connectée).
 */
export function RedialButton({
  number,
  clientId,
  clientName,
  iconOnly = false,
  className,
}: {
  /** E.164 — numéro distant de l'appel d'origine. */
  number: string;
  clientId?: string;
  clientName?: string;
  /** Carte mobile compacte : icône seule (le libellé passe en aria-label). */
  iconOnly?: boolean;
  className?: string;
}) {
  const t = useTranslations("phone");
  const { dial, ready } = useTelephony();
  const label = t("callsPage.list.redial");

  const button = (
    <Button
      type="button"
      variant="outline"
      className={cn(iconOnly ? "size-11 rounded-full" : "h-11", className)}
      aria-label={iconOnly ? label : undefined}
      disabled={!ready}
      onClick={() => dial({ number, clientId, clientName })}
    >
      <PhoneIcon className={cn("size-4.5", ready && "text-emerald-600 dark:text-emerald-500")} />
      {iconOnly ? null : label}
    </Button>
  );

  if (ready) return button;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
        <TooltipContent>{t("callsPage.list.notReady")}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
