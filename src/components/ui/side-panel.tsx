"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Panneau latéral droit NON modal : la page (et l'appel en cours) restent
 * utilisables derrière. Un seul panneau ouvert à la fois — l'ouverture d'un
 * panneau ferme les autres via l'événement `nexus:sidepanel`.
 */

export type SidePanelEventDetail = { id: string; open: boolean };

export function announceSidePanel(id: string, open: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<SidePanelEventDetail>("nexus:sidepanel", { detail: { id, open } }),
  );
}

export function SidePanel({
  id,
  open,
  onClose,
  title,
  subtitle,
  children,
  className,
}: {
  /** Identifiant unique du panneau (coordination inter-panneaux). */
  id: string;
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const t = useTranslations("common");

  // Annonce ouverture/fermeture aux autres panneaux.
  useEffect(() => {
    announceSidePanel(id, open);
    return () => {
      if (open) announceSidePanel(id, false);
    };
  }, [id, open]);

  // Ferme ce panneau si un autre s'ouvre.
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SidePanelEventDetail>).detail;
      if (detail.open && detail.id !== id) onClose();
    };
    window.addEventListener("nexus:sidepanel", handler);
    return () => window.removeEventListener("nexus:sidepanel", handler);
  }, [open, id, onClose]);

  if (!open) return null;

  return (
    <aside
      role="complementary"
      aria-label={typeof title === "string" ? title : undefined}
      className={cn(
        "fixed inset-y-0 right-0 z-45 flex w-full flex-col border-l bg-background shadow-2xl",
        "sm:w-[26.5rem]",
        "animate-in fade-in-0 slide-in-from-right-8 duration-200",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          {subtitle ? (
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          onClick={onClose}
          aria-label={t("actions.close")}
        >
          <X className="size-5" />
        </Button>
      </header>
      <div className="pb-safe min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </aside>
  );
}
