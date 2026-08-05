"use client";

import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  CalendarDaysIcon,
  HistoryIcon,
  MapPinIcon,
  Mic2Icon,
  PhoneIncomingIcon,
  PhoneOutgoingIcon,
  VideoIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DISPOSITION_CONFIG } from "@/lib/dispositions";
import type { Disposition } from "@/db/schema";
import { APP_TZ } from "./timezone";

export type CallData = {
  id: string;
  direction: "outbound" | "inbound";
  startedAt: string; // ISO
  durationSec: number;
  disposition: string | null;
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

  const dispositionChip = (d: string | null) => {
    if (!d) return null;
    const config = DISPOSITION_CONFIG[d as Disposition];
    const known = Boolean(config);
    const label = known ? t(`dispositions.${d as Disposition}`) : d;
    const color = config?.color ?? "#64748b";
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
    <Card>
      <CardHeader>
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
              <p className="py-2 text-sm text-muted-foreground">{t("history.noCalls")}</p>
            ) : (
              <ul className="divide-y">
                {calls.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 py-3">
                    {c.direction === "outbound" ? (
                      <PhoneOutgoingIcon
                        aria-label={t("history.outbound")}
                        className="mt-0.5 size-4 shrink-0 text-emerald-600"
                      />
                    ) : (
                      <PhoneIncomingIcon
                        aria-label={t("history.inbound")}
                        className="mt-0.5 size-4 shrink-0 text-blue-600"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium tabular-nums">{fmt(c.startedAt)}</span>
                        <span className="text-muted-foreground tabular-nums">
                          {formatDuration(c.durationSec)}
                        </span>
                        {dispositionChip(c.disposition)}
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
                          className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary hover:underline"
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
              <p className="py-2 text-sm text-muted-foreground">{t("history.noAppointments")}</p>
            ) : (
              <ul className="divide-y">
                {appointments.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 py-3">
                    <CalendarDaysIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
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
