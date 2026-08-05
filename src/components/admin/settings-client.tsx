"use client";

import { formatInTimeZone } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import { CalendarDays, CheckCircle2, Loader2, PhoneCall, Unplug, XCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "./api";

const TZ = "America/Toronto";

// ── a. Google Calendar ───────────────────────────────────────────────────────

export function GoogleCard({
  connected,
  email,
  connectedAt,
  calendarId,
}: {
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  calendarId: string;
}) {
  const t = useTranslations("admin");
  const locale = useLocale();
  const router = useRouter();
  const [calendars, setCalendars] = useState<{ id: string; summary: string; primary: boolean }[] | null>(
    null,
  );
  const [selected, setSelected] = useState(calendarId);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void api<{ calendars: { id: string; summary: string; primary: boolean }[] }>(
      "/api/admin/google/calendars",
    )
      .then((res) => {
        if (!cancelled) setCalendars(res.calendars);
      })
      .catch(() => {
        if (!cancelled) setCalendars([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  const saveCalendar = async (id: string) => {
    setSelected(id);
    try {
      await api("/api/admin/settings/google", { method: "POST", body: JSON.stringify({ calendarId: id }) });
      toast.success(t("saved"));
    } catch {
      toast.error(t("genericError"));
    }
  };

  const disconnect = async () => {
    setPending(true);
    try {
      await api("/api/admin/google/disconnect", { method: "POST" });
      toast.success(t("settings.google.disconnected"));
      router.refresh();
    } catch {
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="size-4" />
          {t("settings.google.title")}
        </CardTitle>
        <CardDescription>{t("settings.google.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connected ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge className="gap-1 bg-green-600 text-white dark:bg-green-700">
                <CheckCircle2 className="size-3" />
                {t("settings.google.connected")}
              </Badge>
              <span className="font-medium">{email}</span>
              {connectedAt ? (
                <span className="text-muted-foreground">
                  {t("settings.google.since", {
                    date: formatInTimeZone(new Date(connectedAt), TZ, "d MMM yyyy", {
                      locale: locale === "fr" ? fr : enCA,
                    }),
                  })}
                </span>
              ) : null}
            </div>

            <div className="max-w-sm space-y-1.5">
              <Label>{t("settings.google.calendar")}</Label>
              {calendars === null ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("loading")}
                </p>
              ) : (
                <Select
                  items={
                    calendars.length > 0
                      ? calendars.map((c) => ({ value: c.id, label: c.summary }))
                      : [{ value: selected, label: selected }]
                  }
                  value={selected}
                  onValueChange={(v) => void saveCalendar(String(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(calendars.length > 0 ? calendars : [{ id: selected, summary: selected, primary: false }]).map(
                      (c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.summary}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>

            <Button
              variant="outline"
              onClick={() => void disconnect()}
              disabled={pending}
              className="min-h-11 md:min-h-8"
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
              {t("settings.google.disconnect")}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t("settings.google.notConnected")}</p>
            <Button render={<a href="/api/google/connect" />} className="min-h-11 md:min-h-8">
              {t("settings.google.connect")}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── b. Réservation ───────────────────────────────────────────────────────────

export type BookingFormValues = {
  days: number[];
  startHour: string;
  endHour: string;
  meetDurationMin: number;
  inPersonDurationMin: number;
  bufferMin: number;
  inPersonDefaultLocation: string;
};

/** Lundi → dimanche (valeurs date-fns : 0 = dimanche). */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function BookingCard({ initial }: { initial: BookingFormValues }) {
  const t = useTranslations("admin");
  const [form, setForm] = useState(initial);
  const [pending, setPending] = useState(false);

  const toggleDay = (day: number, checked: boolean) => {
    setForm((f) => ({
      ...f,
      days: checked ? [...f.days, day].sort((a, b) => a - b) : f.days.filter((d) => d !== day),
    }));
  };

  const submit = async () => {
    setPending(true);
    try {
      await api("/api/admin/settings/booking", { method: "POST", body: JSON.stringify(form) });
      toast.success(t("saved"));
    } catch {
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  const numberInput = (
    id: string,
    label: string,
    value: number,
    onChange: (v: number) => void,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={5}
        max={480}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="size-4" />
          {t("settings.booking.title")}
        </CardTitle>
        <CardDescription>{t("settings.booking.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>{t("settings.booking.days")}</Label>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {DAY_ORDER.map((day) => (
              <label key={day} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
                <Checkbox
                  checked={form.days.includes(day)}
                  onCheckedChange={(checked) => toggleDay(day, checked === true)}
                />
                {t(`settings.booking.day${day}`)}
              </label>
            ))}
          </div>
        </div>

        <div className="grid max-w-md grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="booking-start">{t("settings.booking.startHour")}</Label>
            <Input
              id="booking-start"
              type="time"
              value={form.startHour}
              onChange={(e) => setForm({ ...form, startHour: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="booking-end">{t("settings.booking.endHour")}</Label>
            <Input
              id="booking-end"
              type="time"
              value={form.endHour}
              onChange={(e) => setForm({ ...form, endHour: e.target.value })}
            />
          </div>
        </div>

        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          {numberInput("booking-meet", t("settings.booking.meetDuration"), form.meetDurationMin, (v) =>
            setForm({ ...form, meetDurationMin: v }),
          )}
          {numberInput(
            "booking-inperson",
            t("settings.booking.inPersonDuration"),
            form.inPersonDurationMin,
            (v) => setForm({ ...form, inPersonDurationMin: v }),
          )}
          {numberInput("booking-buffer", t("settings.booking.buffer"), form.bufferMin, (v) =>
            setForm({ ...form, bufferMin: v }),
          )}
        </div>

        <div className="max-w-md space-y-1.5">
          <Label htmlFor="booking-location">{t("settings.booking.location")}</Label>
          <Input
            id="booking-location"
            value={form.inPersonDefaultLocation}
            onChange={(e) => setForm({ ...form, inPersonDefaultLocation: e.target.value })}
            placeholder={t("settings.booking.locationPlaceholder")}
          />
        </div>

        <Button onClick={() => void submit()} disabled={pending} className="min-h-11 md:min-h-8">
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("save")}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── c. Téléphonie ────────────────────────────────────────────────────────────

function EnvHint({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-sm">
      {ok ? (
        <CheckCircle2 className="size-4 text-green-600" />
      ) : (
        <XCircle className="size-4 text-destructive" />
      )}
      {label}
    </span>
  );
}

export function TelephonyCard({
  initialProvider,
  voipms,
  twilio,
}: {
  initialProvider: "voipms" | "twilio";
  voipms: { sipWss: boolean; apiCreds: boolean };
  twilio: Record<string, boolean>;
}) {
  const t = useTranslations("admin");
  const [provider, setProvider] = useState(initialProvider);
  const [pending, setPending] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message?: string; count?: number } | null>(null);
  const [testing, setTesting] = useState(false);

  const changeProvider = async (next: "voipms" | "twilio") => {
    const prev = provider;
    setProvider(next);
    setPending(true);
    try {
      await api("/api/admin/settings/telephony", {
        method: "POST",
        body: JSON.stringify({ provider: next }),
      });
      toast.success(t("settings.telephony.providerSaved"));
    } catch {
      setProvider(prev);
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const res = await api<{ ok: boolean; count?: number; message?: string; status?: string }>(
        "/api/admin/voipms/test",
      );
      setTest({ ok: res.ok, count: res.count, message: res.message ?? res.status });
    } catch {
      setTest({ ok: false, message: t("genericError") });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PhoneCall className="size-4" />
          {t("settings.telephony.title")}
        </CardTitle>
        <CardDescription>{t("settings.telephony.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup
          value={provider}
          onValueChange={(v) => void changeProvider(v as "voipms" | "twilio")}
          className="gap-2"
        >
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium md:min-h-0">
            <RadioGroupItem value="voipms" disabled={pending} />
            voip.ms (SIP / WebRTC)
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium md:min-h-0">
            <RadioGroupItem value="twilio" disabled={pending} />
            Twilio
          </label>
        </RadioGroup>

        {provider === "voipms" ? (
          <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
            <EnvHint ok={voipms.sipWss} label={t("settings.telephony.sipWssConfigured")} />
            <EnvHint ok={voipms.apiCreds} label={t("settings.telephony.voipmsCreds")} />
            <div className="pt-1">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                onClick={() => void runTest()}
                disabled={testing}
              >
                {testing ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("settings.telephony.test")}
              </Button>
            </div>
            {test ? (
              test.ok ? (
                <p className="flex items-center gap-1.5 text-sm text-green-600">
                  <CheckCircle2 className="size-4" />
                  {t("settings.telephony.testOk", { count: test.count ?? 0 })}
                </p>
              ) : (
                <div className="text-sm text-destructive">
                  <p className="flex items-center gap-1.5">
                    <XCircle className="size-4" />
                    {t("settings.telephony.testFail")}
                  </p>
                  {test.message ? <p className="mt-1 font-mono text-xs">{test.message}</p> : null}
                  <p className="mt-1 text-xs text-muted-foreground">{t("settings.telephony.ipHint")}</p>
                </div>
              )
            ) : null}
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">{t("settings.telephony.twilioEnvNote")}</p>
            {Object.entries(twilio).map(([name, ok]) => (
              <EnvHint key={name} ok={ok} label={name} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
