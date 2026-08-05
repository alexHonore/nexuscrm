"use client";

import { fr as frLocale, enCA } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  CalendarX,
  ChevronDown,
  Copy,
  ExternalLink,
  House,
  MapPin,
  Video,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelAppointment } from "@/app/(app)/appointments/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

const TZ = "America/Toronto";

export type AppointmentItem = {
  id: string;
  type: "meet" | "inperson";
  status: "scheduled" | "cancelled" | "completed" | "noshow";
  startsAt: string;
  endsAt: string;
  meetLink: string | null;
  location: string | null;
  clientId: string;
  clientName: string;
  clientPhone: string;
  bookedByName: string;
  canCancel: boolean;
};

function StatusBadge({ status }: { status: AppointmentItem["status"] }) {
  const t = useTranslations("booking");
  const variant =
    status === "scheduled"
      ? "secondary"
      : status === "cancelled"
        ? "destructive"
        : "outline";
  return <Badge variant={variant}>{t(`page.status.${status}`)}</Badge>;
}

function AppointmentCard({ item }: { item: AppointmentItem }) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const dateLocale = locale === "en" ? enCA : frLocale;
  const timeFormat = locale === "en" ? "h:mm a" : "HH 'h' mm";
  const router = useRouter();
  const [pending, startCancel] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const start = new Date(item.startsAt);
  const end = new Date(item.endsAt);
  const timeRange = `${formatInTimeZone(start, TZ, timeFormat, { locale: dateLocale })} – ${formatInTimeZone(end, TZ, timeFormat, { locale: dateLocale })}`;
  const fullDate = formatInTimeZone(
    start,
    TZ,
    locale === "en" ? "EEE MMM d, yyyy" : "EEE d MMM yyyy",
    { locale: dateLocale },
  );
  const cancelled = item.status === "cancelled";

  function onCancel() {
    startCancel(async () => {
      const res = await cancelAppointment(item.id);
      if (res.ok) {
        toast.success(t("toasts.cancelled"));
        setConfirmOpen(false);
        router.refresh();
      } else {
        toast.error(t("toasts.cancelError"));
      }
    });
  }

  const TypeIcon = item.type === "meet" ? Video : House;

  return (
    <div
      className={cn(
        "rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10",
        cancelled && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <TypeIcon className="size-4.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("font-medium tabular-nums", cancelled && "line-through")}>
              {timeRange}
            </span>
            <StatusBadge status={item.status} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground md:hidden">{fullDate}</p>
          <p className="mt-1 truncate">
            <Link
              href={`/clients/${item.clientId}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {item.clientName}
            </Link>
            <span className="text-muted-foreground"> · {formatPhone(item.clientPhone)}</span>
          </p>
          {item.type === "inperson" && item.location ? (
            <p className="mt-0.5 flex items-start gap-1 text-xs text-muted-foreground">
              <MapPin className="mt-0.5 size-3 shrink-0" />
              <span className="truncate">{item.location}</span>
            </p>
          ) : null}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("page.bookedBy", { name: item.bookedByName })}
          </p>
        </div>
      </div>

      {(item.meetLink && item.status === "scheduled") || item.canCancel ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          {item.meetLink && item.status === "scheduled" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-11 md:h-8"
                render={
                  <a href={item.meetLink} target="_blank" rel="noopener noreferrer" />
                }
              >
                <ExternalLink className="size-3.5" />
                {t("page.openMeet")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-11 md:h-8"
                onClick={() => {
                  void navigator.clipboard.writeText(item.meetLink as string);
                  toast.success(t("toasts.meetCopied"));
                }}
              >
                <Copy className="size-3.5" />
                {t("page.copyMeet")}
              </Button>
            </>
          ) : null}
          {item.canCancel ? (
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <AlertDialogTrigger
                render={
                  <Button variant="destructive" size="sm" className="ml-auto h-11 md:h-8" />
                }
              >
                <CalendarX className="size-3.5" />
                {t("page.cancel")}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogMedia>
                    <CalendarX className="text-destructive" />
                  </AlertDialogMedia>
                  <AlertDialogTitle>{t("page.cancelTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("page.cancelDescription", {
                      name: item.clientName,
                      date: `${fullDate}, ${timeRange}`,
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pending}>{t("page.cancelKeep")}</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={pending}
                    onClick={onCancel}
                  >
                    {t("page.cancelConfirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AppointmentsList({ items, now }: { items: AppointmentItem[]; now: number }) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const dateLocale = locale === "en" ? enCA : frLocale;
  const [showPast, setShowPast] = useState(false);

  const { groups, past } = useMemo(() => {
    const upcoming = items.filter(
      (a) => a.status === "scheduled" && new Date(a.endsAt).getTime() >= now,
    );
    const pastItems = items
      .filter((a) => a.status !== "scheduled" || new Date(a.endsAt).getTime() < now)
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt));

    const todayKey = formatInTimeZone(new Date(now), TZ, "yyyy-MM-dd");
    const tomorrowKey = formatInTimeZone(new Date(now + 86_400_000), TZ, "yyyy-MM-dd");
    const map = new Map<string, { label: string; items: AppointmentItem[] }>();
    for (const a of upcoming) {
      const key = formatInTimeZone(new Date(a.startsAt), TZ, "yyyy-MM-dd");
      if (!map.has(key)) {
        const label =
          key === todayKey
            ? t("page.today")
            : key === tomorrowKey
              ? t("page.tomorrow")
              : formatInTimeZone(
                  new Date(a.startsAt),
                  TZ,
                  locale === "en" ? "EEEE, MMMM d" : "EEEE d MMMM",
                  { locale: dateLocale },
                );
        map.set(key, { label, items: [] });
      }
      map.get(key)?.items.push(a);
    }
    return { groups: Array.from(map.entries()), past: pastItems };
  }, [items, now, t, locale, dateLocale]);

  return (
    <div className="space-y-6">
      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">{t("page.empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("page.emptyHint")}</p>
        </div>
      ) : (
        groups.map(([key, group]) => (
          <section key={key} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground capitalize">
              {group.label}
            </h2>
            <div className="space-y-2">
              {group.items.map((a) => (
                <AppointmentCard key={a.id} item={a} />
              ))}
            </div>
          </section>
        ))
      )}

      {past.length > 0 && (
        <section className="space-y-2">
          <Button
            variant="ghost"
            className="h-11 w-full justify-between px-3 text-sm text-muted-foreground md:h-9"
            onClick={() => setShowPast((s) => !s)}
            aria-expanded={showPast}
          >
            {showPast ? t("page.hidePast") : t("page.showPast", { count: past.length })}
            <ChevronDown className={cn("size-4 transition-transform", showPast && "rotate-180")} />
          </Button>
          {showPast && (
            <div className="space-y-2">
              {past.map((a) => (
                <AppointmentCard key={a.id} item={a} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
