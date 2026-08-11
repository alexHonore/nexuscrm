"use client";

import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  CalendarDaysIcon,
  HistoryIcon,
  MapPinIcon,
  Mic2Icon,
  PhoneIncomingIcon,
  PhoneMissedIcon,
  PhoneOutgoingIcon,
  VideoIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DISPOSITION_CONFIG } from "@/lib/dispositions";
import type { Disposition } from "@/db/schema";
import { APP_TZ } from "./timezone";

export type CallData = {
  id: string;
  direction: "outbound" | "inbound";
  /** Entrant jamais décroché — le client a tenté de nous joindre sans succès. */
  missed: boolean;
  startedAt: string; // ISO
  durationSec: number;
  disposition: string | null;
  /** Libellé/couleur du statut du pipeline (préparés côté serveur) — null : repli local. */
  dispositionLabel: string | null;
  dispositionColor: string | null;
  note: string | null;
  recordingUrl: string | null;
  userName: string | null;
};

export type AppointmentData = {
  id: string;
  title: string;
  type: "meet" | "inperson";
  status: "scheduled" | "cancelled" | "completed" | "noshow";
  startsAt: string; // ISO
  endsAt: string; // ISO
  location: string | null;
  meetLink: string | null;
  userName: string | null;
};

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ClientHistory({
  calls,
  appointments,
}: {
  calls: CallData[];
  appointments: AppointmentData[];
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;

  const fmt = (iso: string, pattern = "d MMM yyyy, HH:mm") =>
    formatInTimeZone(new Date(iso), APP_TZ, pattern, { locale: dfnsLocale });

  const dispositionChip = (d: string | null, override?: { label?: string | null; color?: string | null }) => {
    if (!d) return null;
    const config = DISPOSITION_CONFIG[d as Disposition];
    const known = Boolean(config);
    const label = override?.label ?? (known ? t(`dispositions.${d as Disposition}`) : d);
    const color = override?.color ?? config?.color ?? "#64748b";
    return (
      <span
        className="inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap"
        style={{ color, backgroundColor: `${color}1a`, borderColor: `${color}40` }}
      >
        {label}
      </span>
    );
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <HistoryIcon className="size-4 text-muted-foreground" />
          {t("history.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="calls">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="calls" className="min-h-9">
              {t("history.calls")} ({calls.length})
            </TabsTrigger>
            <TabsTrigger value="appointments" className="min-h-9">
              {t("history.appointments")} ({appointments.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="calls">
            {calls.length === 0 ? (
              <EmptyState
                icon={<PhoneOutgoingIcon />}
                title={t("history.noCalls")}
                className="py-8"
              />
            ) : (
              <ul className="divide-y">
                {calls.map((c) => (
                  <li
                    key={c.id}
                    className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-muted/50"
                  >
                    {c.missed ? (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-600 dark:text-red-400">
                        <PhoneMissedIcon aria-label={t("history.missed")} className="size-4" />
                      </span>
                    ) : c.direction === "outbound" ? (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        <PhoneOutgoingIcon
                          aria-label={t("history.outbound")}
                          className="size-4"
                        />
                      </span>
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
                        <PhoneIncomingIcon
                          aria-label={t("history.inbound")}
                          className="size-4"
                        />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium tabular-nums">{fmt(c.startedAt)}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {formatDuration(c.durationSec)}
                        </span>
                        {c.missed && !c.disposition ? (
                          <span className="inline-flex h-5 items-center rounded-full border border-red-500/25 bg-red-500/10 px-2 text-xs font-medium whitespace-nowrap text-red-600 dark:text-red-400">
                            {t("history.missed")}
                          </span>
                        ) : null}
                        {dispositionChip(c.disposition, {
                          label: c.dispositionLabel,
                          color: c.dispositionColor,
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {c.userName ?? "—"}
                        {c.note ? ` · ${c.note}` : null}
                      </p>
                      {c.recordingUrl ? (
                        <a
                          href={c.recordingUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex min-h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                        >
                          <Mic2Icon className="size-3.5" />
                          {t("history.recording")}
                        </a>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="appointments">
            {appointments.length === 0 ? (
              <EmptyState
                icon={<CalendarDaysIcon />}
                title={t("history.noAppointments")}
                className="py-8"
              />
            ) : (
              <ul className="divide-y">
                {appointments.map((a) => (
                  <li
                    key={a.id}
                    className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-muted/50"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <CalendarDaysIcon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium tabular-nums">
                          {fmt(a.startsAt)}
                          {" – "}
                          {formatInTimeZone(new Date(a.endsAt), APP_TZ, "HH:mm", {
                            locale: dfnsLocale,
                          })}
                        </span>
                        <Badge variant="secondary" className="gap-1">
                          {a.type === "meet" ? (
                            <VideoIcon className="size-3" />
                          ) : (
                            <MapPinIcon className="size-3" />
                          )}
                          {t(`history.types.${a.type}`)}
                        </Badge>
                        <Badge variant={a.status === "cancelled" || a.status === "noshow" ? "destructive" : "outline"}>
                          {t(`history.statuses.${a.status}`)}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.title}
                        {a.userName ? ` · ${a.userName}` : null}
                        {a.location ? ` · ${a.location}` : null}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
