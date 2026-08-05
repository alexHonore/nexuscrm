"use client";

import { addDays, format } from "date-fns";
import { enUS, fr } from "date-fns/locale";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { CalendarClockIcon, CheckIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  completeFollowupAction,
  createFollowupAction,
  updateFollowupDueAction,
} from "@/app/(app)/clients/actions";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { APP_TZ } from "./timezone";

export type FollowupData = {
  id: string;
  dueAt: string; // ISO
  note: string | null;
  doneAt: string | null; // ISO
  /** Computed server-side at render time. */
  overdue: boolean;
};

export function FollowupsCard({
  clientId,
  followups,
}: {
  clientId: string;
  followups: FollowupData[];
}) {
  const t = useTranslations("clients");
  const locale = useLocale();
  const dfnsLocale = locale === "en" ? enUS : fr;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const tomorrow = format(addDays(new Date(), 1), "yyyy-MM-dd");
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState("09:00");
  const [note, setNote] = useState("");

  const open = followups.filter((f) => !f.doneAt);
  const done = followups.filter((f) => f.doneAt).slice(0, 5);

  const fmtDue = (iso: string) =>
    formatInTimeZone(new Date(iso), APP_TZ, "EEE d MMM yyyy, HH:mm", { locale: dfnsLocale });

  const openCreate = () => {
    setDate(tomorrow);
    setTime("09:00");
    setNote("");
    setCreateOpen(true);
  };

  const openEdit = (f: FollowupData) => {
    const zoned = toZonedTime(new Date(f.dueAt), APP_TZ);
    setDate(format(zoned, "yyyy-MM-dd"));
    setTime(format(zoned, "HH:mm"));
    setEditId(f.id);
  };

  const submitCreate = () => {
    startTransition(async () => {
      const res = await createFollowupAction({ clientId, date, time, note: note || undefined });
      if (res.ok) {
        toast.success(t("followups.created"));
        setCreateOpen(false);
        router.refresh();
      } else {
        toast.error(t("errors.generic"));
      }
    });
  };

  const submitEdit = () => {
    if (!editId) return;
    startTransition(async () => {
      const res = await updateFollowupDueAction({ followupId: editId, date, time });
      if (res.ok) {
        toast.success(t("followups.updated"));
        setEditId(null);
        router.refresh();
      } else {
        toast.error(t("errors.generic"));
      }
    });
  };

  const complete = (id: string) => {
    startTransition(async () => {
      const res = await completeFollowupAction(id);
      if (res.ok) {
        toast.success(t("followups.completed"));
        router.refresh();
      } else {
        toast.error(t("errors.generic"));
      }
    });
  };

  const dateTimeFields = (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="fu-date">{t("followups.date")}</Label>
        <Input
          id="fu-date"
          type="date"
          className="min-h-11 md:min-h-8"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="fu-time">{t("followups.time")}</Label>
        <Input
          id="fu-time"
          type="time"
          className="min-h-11 md:min-h-8"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          required
        />
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClockIcon className="size-4 text-muted-foreground" />
          {t("followups.title")}
        </CardTitle>
        <CardAction>
          <Button variant="outline" size="sm" className="min-h-11 md:min-h-7" onClick={openCreate}>
            <PlusIcon />
            {t("followups.add")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {open.length === 0 && done.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("followups.empty")}</p>
        ) : null}

        {open.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t("followups.openSection")}
            </p>
            <ul className="space-y-2">
              {open.map((f) => {
                const overdue = f.overdue;
                return (
                  <li
                    key={f.id}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border py-2 pr-1.5 pl-3",
                      overdue && "border-l-4 border-l-destructive",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          "text-sm font-medium tabular-nums",
                          overdue && "text-destructive",
                        )}
                      >
                        {fmtDue(f.dueAt)}
                        {overdue ? (
                          <span className="ml-2 text-xs font-semibold uppercase">
                            {t("followups.overdue")}
                          </span>
                        ) : null}
                      </p>
                      {f.note ? (
                        <p className="truncate text-xs text-muted-foreground">{f.note}</p>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      className="size-11 md:size-8"
                      aria-label={t("followups.editDue")}
                      onClick={() => openEdit(f)}
                    >
                      <PencilIcon className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      className="size-11 text-emerald-600 md:size-8"
                      aria-label={t("followups.complete")}
                      disabled={pending}
                      onClick={() => complete(f.id)}
                    >
                      <CheckIcon className="size-5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {done.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t("followups.doneSection")}
            </p>
            <ul className="space-y-1.5">
              {done.map((f) => (
                <li key={f.id} className="text-xs text-muted-foreground">
                  <span className="line-through">{fmtDue(f.dueAt)}</span>
                  {f.note ? <span className="ml-2 line-through">{f.note}</span> : null}
                  {f.doneAt ? (
                    <span className="ml-2">
                      {t("followups.doneAt", {
                        date: formatInTimeZone(new Date(f.doneAt), APP_TZ, "d MMM HH:mm", {
                          locale: dfnsLocale,
                        }),
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("followups.add")}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitCreate();
            }}
          >
            {dateTimeFields}
            <div className="space-y-1.5">
              <Label htmlFor="fu-note">{t("followups.note")}</Label>
              <Textarea
                id="fu-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t("followups.notePlaceholder")}
                maxLength={1000}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                {t("followups.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {t("followups.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit due date dialog */}
      <Dialog open={editId !== null} onOpenChange={(o) => !o && setEditId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("followups.editDue")}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitEdit();
            }}
          >
            {dateTimeFields}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditId(null)}>
                {t("followups.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {t("followups.editDue")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
