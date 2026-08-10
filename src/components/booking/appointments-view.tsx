"use client";

import { CalendarDays, List } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { AppointmentsCalendar } from "./appointments-calendar";
import { AppointmentsList, type AppointmentItem } from "./appointments-list";

export type AppointmentsViewMode = "list" | "calendar";

/**
 * Bascule Liste / Calendrier de la page Rendez-vous. La vue initiale vient de
 * l'URL (?view=calendar — le tableau de bord y mène directement) ; le
 * changement de vue reste local, sans navigation.
 */
export function AppointmentsView({
  items,
  now,
  initialView,
  minMonth,
  maxMonth,
}: {
  items: AppointmentItem[];
  now: number;
  initialView: AppointmentsViewMode;
  /** Bornes « yyyy-MM » de la fenêtre chargée (null = pas de borne). */
  minMonth: string | null;
  maxMonth: string | null;
}) {
  const t = useTranslations("booking");
  const [view, setView] = useState<AppointmentsViewMode>(initialView);

  const chipClass = (active: boolean) =>
    cn(
      "inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 md:h-8 md:px-3 md:text-xs",
      active
        ? "border-foreground bg-foreground text-background"
        : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
    );

  return (
    <div className="space-y-4">
      <div role="group" aria-label={t("page.view.label")} className="flex items-center gap-2">
        <button
          type="button"
          aria-pressed={view === "list"}
          className={chipClass(view === "list")}
          onClick={() => setView("list")}
        >
          <List aria-hidden className="size-3.5" />
          {t("page.view.list")}
        </button>
        <button
          type="button"
          aria-pressed={view === "calendar"}
          className={chipClass(view === "calendar")}
          onClick={() => setView("calendar")}
        >
          <CalendarDays aria-hidden className="size-3.5" />
          {t("page.view.calendar")}
        </button>
      </div>

      {view === "list" ? (
        <AppointmentsList items={items} now={now} />
      ) : (
        <AppointmentsCalendar items={items} now={now} minMonth={minMonth} maxMonth={maxMonth} />
      )}
    </div>
  );
}
