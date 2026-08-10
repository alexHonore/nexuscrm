"use client";

import { fr as frLocale, enCA } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { CalendarX2, ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AppointmentCard, type AppointmentItem } from "./appointments-list";

const TZ = "America/Toronto";

/**
 * Vue calendrier des rendez-vous : grille mensuelle (semaine commençant le
 * lundi, jours calculés dans le fuseau de Toronto), pastilles/étiquettes par
 * jour, et le détail du jour choisi sous la grille — mêmes cartes que la
 * liste. Les rendez-vous annulés n'apparaissent pas.
 *
 * Toute l'arithmétique de calendrier se fait sur des dates CIVILES
 * (« yyyy-MM-dd » + Date.UTC) : le jour d'un rendez-vous vient de
 * formatInTimeZone(startsAt, Toronto), et plus aucun fuseau n'intervient
 * ensuite — pas de dérive d'un jour aux changements d'heure.
 */
export function AppointmentsCalendar({
  items,
  now,
  minMonth,
  maxMonth,
}: {
  items: AppointmentItem[];
  now: number;
  /**
   * Bornes « yyyy-MM » de la fenêtre de données chargée par la page (null =
   * tout est chargé). Au-delà, les mois paraîtraient à tort vides : la
   * navigation s'y arrête.
   */
  minMonth: string | null;
  maxMonth: string | null;
}) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const dateLocale = locale === "en" ? enCA : frLocale;
  const chipTimeFormat = locale === "en" ? "h:mm a" : "HH:mm";

  const todayKey = formatInTimeZone(new Date(now), TZ, "yyyy-MM-dd");
  const [month, setMonth] = useState(() => todayKey.slice(0, 7)); // « yyyy-MM »
  const [selectedKey, setSelectedKey] = useState(todayKey);

  const byDay = useMemo(() => {
    const map = new Map<string, AppointmentItem[]>();
    for (const a of items) {
      if (a.status === "cancelled") continue;
      const key = formatInTimeZone(new Date(a.startsAt), TZ, "yyyy-MM-dd");
      const list = map.get(key);
      if (list) list.push(a);
      else map.set(key, [a]);
    }
    for (const list of map.values()) list.sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    return map;
  }, [items]);

  const [year, monthNum] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  // Décalage lundi-en-tête : getUTCDay() donne 0 = dimanche.
  const lead = (new Date(Date.UTC(year, monthNum - 1, 1)).getUTCDay() + 6) % 7;
  const dayKeys = Array.from(
    { length: daysInMonth },
    (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
  );

  const monthPlus = (delta: number): string => {
    const total = year * 12 + (monthNum - 1) + delta;
    const y = Math.floor(total / 12);
    const m = total - y * 12 + 1;
    return `${y}-${String(m).padStart(2, "0")}`;
  };
  // Comparaison lexicale : « yyyy-MM » est trié comme les dates.
  const inBounds = (key: string) =>
    (!minMonth || key >= minMonth) && (!maxMonth || key <= maxMonth);
  const shiftMonth = (delta: number) => {
    const next = monthPlus(delta);
    if (inBounds(next)) setMonth(next);
  };

  const civil = (key: string) => new Date(`${key}T12:00:00Z`);
  const monthLabel = formatInTimeZone(civil(`${month}-15`), "UTC", "MMMM yyyy", {
    locale: dateLocale,
  });
  // 2024-01-01 est un lundi — sert uniquement à produire les libellés des jours.
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    formatInTimeZone(new Date(Date.UTC(2024, 0, 1 + i, 12)), "UTC", "EEE", { locale: dateLocale }),
  );

  const selected = byDay.get(selectedKey) ?? [];
  const selectedLabel = formatInTimeZone(
    civil(selectedKey),
    "UTC",
    locale === "en" ? "EEEE, MMMM d" : "EEEE d MMMM",
    { locale: dateLocale },
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-card p-3 shadow-xs ring-1 ring-foreground/10">
        {/* ── Navigation de mois ── */}
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold capitalize">{monthLabel}</p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-11 px-2.5 text-muted-foreground md:h-8"
              onClick={() => {
                setMonth(todayKey.slice(0, 7));
                setSelectedKey(todayKey);
              }}
            >
              {t("page.calendarView.today")}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("page.calendarView.prevMonth")}
              className="size-11 md:size-8"
              disabled={!inBounds(monthPlus(-1))}
              onClick={() => shiftMonth(-1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("page.calendarView.nextMonth")}
              className="size-11 md:size-8"
              disabled={!inBounds(monthPlus(1))}
              onClick={() => shiftMonth(1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>

        {/* ── Grille ── */}
        <div className="grid grid-cols-7 gap-1">
          {weekdays.map((w) => (
            <div
              key={w}
              className="pb-1 text-center text-[11px] font-medium text-muted-foreground capitalize"
            >
              {w}
            </div>
          ))}
          {Array.from({ length: lead }, (_, i) => (
            <div key={`lead-${i}`} aria-hidden />
          ))}
          {dayKeys.map((key) => {
            const events = byDay.get(key) ?? [];
            const isToday = key === todayKey;
            const isSelected = key === selectedKey;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={isSelected}
                aria-label={`${formatInTimeZone(civil(key), "UTC", locale === "en" ? "MMMM d" : "d MMMM", { locale: dateLocale })}${
                  events.length > 0 ? ` — ${events.length}` : ""
                }`}
                onClick={() => setSelectedKey(key)}
                className={cn(
                  "flex min-h-12 flex-col items-stretch gap-0.5 rounded-lg border border-transparent p-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:min-h-20",
                  isSelected
                    ? "border-primary/40 bg-primary/10"
                    : "hover:bg-muted/60",
                )}
              >
                <span
                  className={cn(
                    "self-center text-xs tabular-nums md:self-start",
                    isToday
                      ? "flex size-5 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {Number(key.slice(8))}
                </span>
                {/* Mobile : pastilles ; md+ : étiquettes heure + prénom. */}
                {events.length > 0 ? (
                  <>
                    <span className="flex flex-wrap justify-center gap-0.5 md:hidden">
                      {events.slice(0, 3).map((e) => (
                        <span
                          key={e.id}
                          aria-hidden
                          className={cn(
                            "size-1.5 rounded-full",
                            e.type === "meet" ? "bg-primary" : "bg-emerald-500",
                          )}
                        />
                      ))}
                      {events.length > 3 ? (
                        <span className="text-[9px] leading-none text-muted-foreground">
                          +{events.length - 3}
                        </span>
                      ) : null}
                    </span>
                    <span className="hidden md:flex md:flex-col md:gap-0.5">
                      {events.slice(0, 2).map((e) => (
                        <span
                          key={e.id}
                          className={cn(
                            "truncate rounded px-1 py-0.5 text-[10px] leading-tight font-medium",
                            e.type === "meet"
                              ? "bg-primary/10 text-primary"
                              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                          )}
                        >
                          {formatInTimeZone(new Date(e.startsAt), TZ, chipTimeFormat, {
                            locale: dateLocale,
                          })}{" "}
                          {e.clientName.split(/\s+/)[0]}
                        </span>
                      ))}
                      {events.length > 2 ? (
                        <span className="px-1 text-[10px] text-muted-foreground">
                          {t("page.calendarView.more", { count: events.length - 2 })}
                        </span>
                      ) : null}
                    </span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Détail du jour choisi ── */}
      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold capitalize">
          {selectedKey === todayKey ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          ) : null}
          {selectedLabel}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {selected.length}
          </span>
        </h2>
        {selected.length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
            <CalendarX2 className="size-4 shrink-0" />
            {t("page.calendarView.dayEmpty")}
          </p>
        ) : (
          <div className="space-y-2">
            {selected.map((a) => (
              <AppointmentCard key={a.id} item={a} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
