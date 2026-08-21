"use client";

import { formatInTimeZone } from "date-fns-tz";
import { enCA, fr } from "date-fns/locale";
import {
  CalendarDays,
  CheckCircle2,
  Loader2,
  MessageSquareText,
  PhoneCall,
  Power,
  Unplug,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { cn } from "@/lib/utils";
import { CONSENT_VALIDITIES, type ConsentValidity } from "@/lib/sms/consent";
import { api } from "./api";

const TZ = "America/Toronto";

/** Pastille d'icône commune aux en-têtes de cartes de réglages. */
function CardIcon({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-4"
    >
      {children}
    </div>
  );
}

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
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <CardIcon>
            <CalendarDays />
          </CardIcon>
          <div className="space-y-0.5">
            <CardTitle>{t("settings.google.title")}</CardTitle>
            <CardDescription>{t("settings.google.desc")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {connected ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge
                variant="secondary"
                className="gap-1 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              >
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
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.google.notConnected")}</p>
        )}
      </CardContent>
      <CardFooter>
        {connected ? (
          <Button
            variant="outline"
            onClick={() => void disconnect()}
            disabled={pending}
            className="min-h-11 md:min-h-8"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
            {t("settings.google.disconnect")}
          </Button>
        ) : (
          <Button render={<a href="/api/google/connect" />} className="min-h-11 md:min-h-8">
            {t("settings.google.connect")}
          </Button>
        )}
      </CardFooter>
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
  brokerEmail: string;
};

/** Lundi → dimanche (valeurs date-fns : 0 = dimanche). */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function BookingCard({ initial }: { initial: BookingFormValues }) {
  const t = useTranslations("admin");
  const [form, setForm] = useState(initial);
  const [pending, setPending] = useState(false);
  const [emailInvalid, setEmailInvalid] = useState(false);

  const toggleDay = (day: number, checked: boolean) => {
    setForm((f) => ({
      ...f,
      days: checked ? [...f.days, day].sort((a, b) => a - b) : f.days.filter((d) => d !== day),
    }));
  };

  const submit = async () => {
    // Même règle que le serveur (zod, pas la validation HTML — elle accepte
    // « info@alexhonore » sans domaine complet, que le serveur refuserait).
    const brokerEmail = form.brokerEmail.trim();
    if (!z.email().or(z.literal("")).safeParse(brokerEmail).success) {
      setEmailInvalid(true);
      toast.error(t("settings.booking.brokerEmailInvalid"));
      return;
    }
    setPending(true);
    try {
      await api("/api/admin/settings/booking", {
        method: "POST",
        body: JSON.stringify({ ...form, brokerEmail }),
      });
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
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <CardIcon>
            <CalendarDays />
          </CardIcon>
          <div className="space-y-0.5">
            <CardTitle>{t("settings.booking.title")}</CardTitle>
            <CardDescription>{t("settings.booking.desc")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>{t("settings.booking.days")}</Label>
          <div className="flex flex-wrap gap-2">
            {DAY_ORDER.map((day) => {
              const active = form.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleDay(day, !active)}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:min-h-7",
                    active
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "bg-background text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {t(`settings.booking.day${day}`)}
                </button>
              );
            })}
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

        <div className="max-w-md space-y-1.5">
          <Label htmlFor="booking-broker-email">{t("settings.booking.brokerEmail")}</Label>
          <Input
            id="booking-broker-email"
            type="email"
            value={form.brokerEmail}
            aria-invalid={emailInvalid || undefined}
            onChange={(e) => {
              setEmailInvalid(false);
              setForm({ ...form, brokerEmail: e.target.value });
            }}
          />
          <p className="text-xs text-muted-foreground">{t("settings.booking.brokerEmailHint")}</p>
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={() => void submit()} disabled={pending} className="min-h-11 md:min-h-8">
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("save")}
        </Button>
      </CardFooter>
    </Card>
  );
}

// ── c. SMS et consentements ──────────────────────────────────────────────────

/** Compte rendu du recalcul du registre (aperçu comme application réelle). */
type SmsBackfillCounts = { updated: number; revived: number; lapsed: number };

export function SmsCard({ initialValidity }: { initialValidity: ConsentValidity }) {
  const t = useTranslations("admin");
  const router = useRouter();
  // Valeur enregistrée côté serveur — mise à jour après chaque sauvegarde pour
  // que « inchangé » redevienne vrai sans attendre le refresh.
  const [saved, setSaved] = useState(initialValidity);
  const [validity, setValidity] = useState(initialValidity);
  const [applyExisting, setApplyExisting] = useState(false);
  const [pending, setPending] = useState(false);
  // Aperçu du recalcul (dry run) — conservé pendant l'animation de fermeture.
  // La durée y est FIGÉE au moment de l'aperçu : la confirmation applique
  // exactement ce que le dialogue a montré, même si le sélecteur bouge entre-temps.
  const [preview, setPreview] = useState<(SmsBackfillCounts & { validity: ConsentValidity }) | null>(
    null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);

  const submit = async () => {
    const chosen = validity;
    setPending(true);
    try {
      if (!applyExisting) {
        await api("/api/admin/settings/sms", {
          method: "POST",
          body: JSON.stringify({ consentValidity: chosen }),
        });
        setSaved(chosen);
        toast.success(t("saved"));
        router.refresh();
        return;
      }
      // Aperçu d'abord (aucune écriture) : on ne touche au registre qu'après
      // confirmation explicite des conséquences.
      const { preview: counts } = await api<{ preview: SmsBackfillCounts }>(
        "/api/admin/settings/sms",
        {
          method: "POST",
          body: JSON.stringify({ consentValidity: chosen, applyToExisting: true, dryRun: true }),
        },
      );
      if (counts.updated === 0) {
        // Aucune échéance ne changerait — rien à confirmer, sauvegarde directe.
        await api("/api/admin/settings/sms", {
          method: "POST",
          body: JSON.stringify({ consentValidity: chosen, applyToExisting: true }),
        });
        setSaved(chosen);
        setApplyExisting(false);
        toast.success(t("saved"));
        router.refresh();
        return;
      }
      setPreview({ ...counts, validity: chosen });
      setConfirmOpen(true);
    } catch {
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  const confirmApply = async () => {
    if (!preview) return;
    setPending(true);
    try {
      const res = await api<{ backfill: SmsBackfillCounts }>("/api/admin/settings/sms", {
        method: "POST",
        body: JSON.stringify({ consentValidity: preview.validity, applyToExisting: true }),
      });
      setSaved(preview.validity);
      setValidity(preview.validity);
      setApplyExisting(false);
      setConfirmOpen(false);
      toast.success(t("settings.sms.backfillDone", { updated: res.backfill.updated }));
      router.refresh();
    } catch {
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <CardIcon>
            <MessageSquareText />
          </CardIcon>
          <div className="space-y-0.5">
            <CardTitle>{t("settings.sms.title")}</CardTitle>
            <CardDescription>{t("settings.sms.desc")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-sm space-y-1.5">
          <Label id="sms-consent-validity-label">{t("settings.sms.validityLabel")}</Label>
          <Select
            items={CONSENT_VALIDITIES.map((v) => ({
              value: v,
              label: t(`settings.sms.validity.${v}`),
            }))}
            value={validity}
            onValueChange={(v) => setValidity(v as ConsentValidity)}
            disabled={pending}
          >
            <SelectTrigger
              aria-labelledby="sms-consent-validity-label"
              className="min-h-11 w-full md:min-h-8"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONSENT_VALIDITIES.map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`settings.sms.validity.${v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="max-w-prose text-xs text-muted-foreground">{t("settings.sms.hint")}</p>

        <div className="space-y-1.5">
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium md:min-h-0">
            <Checkbox
              checked={applyExisting}
              onCheckedChange={(checked) => setApplyExisting(checked === true)}
              disabled={pending}
            />
            {t("settings.sms.applyExisting")}
          </label>
          <p className="max-w-prose text-xs text-muted-foreground">
            {t("settings.sms.applyExistingHint")}
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          onClick={() => void submit()}
          // Coché = recalcul du registre : action légitime même à durée égale.
          disabled={pending || (!applyExisting && validity === saved)}
          className="min-h-11 md:min-h-8"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("save")}
        </Button>
      </CardFooter>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.sms.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.sms.confirmBody", { updated: preview?.updated ?? 0 })}
            </AlertDialogDescription>
            {preview && preview.revived > 0 ? (
              <p className="text-sm font-medium text-balance text-amber-700 dark:text-amber-400">
                {t("settings.sms.confirmRevived", { revived: preview.revived })}
              </p>
            ) : null}
            {preview && preview.lapsed > 0 ? (
              <p className="text-sm font-medium text-balance text-destructive">
                {t("settings.sms.confirmLapsed", { lapsed: preview.lapsed })}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending} className="min-h-11 md:min-h-8">
              {t("settings.sms.confirmCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => void confirmApply()}
              className="min-h-11 md:min-h-8"
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("settings.sms.confirmApply")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── d. Téléphonie ────────────────────────────────────────────────────────────

function EnvHint({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-sm">
      {ok ? (
        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
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
    <Card className="shadow-xs">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <CardIcon>
            <PhoneCall />
          </CardIcon>
          <div className="space-y-0.5">
            <CardTitle>{t("settings.telephony.title")}</CardTitle>
            <CardDescription>{t("settings.telephony.desc")}</CardDescription>
          </div>
        </div>
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
                <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
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

/**
 * L'interrupteur d'arrêt, enfin à portée de main. Il n'existait que comme
 * route API : la page de mise en service disait « relevez-le dans les
 * réglages SMS » et il n'y avait rien à relever.
 */
export function KillSwitchCard({
  initial,
}: {
  initial: { enabled: boolean; reason: string | null; at: string | null };
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const apply = async (enabled: boolean) => {
    setPending(true);
    try {
      const res = await api<{ enabled: boolean; cancelledJobs: number }>("/api/kill-switch", {
        method: "POST",
        body: JSON.stringify({ enabled, reason: reason.trim() || undefined }),
      });
      setState({
        enabled: res.enabled,
        reason: enabled ? reason.trim() || null : null,
        at: enabled ? new Date().toISOString() : null,
      });
      setReason("");
      setConfirmOpen(false);
      toast.success(
        enabled
          ? t("settings.killSwitch.lowered", { cancelled: res.cancelledJobs })
          : t("settings.killSwitch.raised"),
      );
      router.refresh();
    } catch {
      toast.error(t("genericError"));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className={state.enabled ? "border-destructive/50 shadow-xs" : "shadow-xs"}>
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <CardIcon>
            <Power className={state.enabled ? "text-destructive" : undefined} />
          </CardIcon>
          <div className="space-y-0.5">
            <CardTitle>{t("settings.killSwitch.title")}</CardTitle>
            <CardDescription>{t("settings.killSwitch.desc")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p
          role={state.enabled ? "alert" : undefined}
          className={
            state.enabled
              ? "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
              : "rounded-lg border bg-muted/40 px-3 py-2 text-sm"
          }
        >
          {state.enabled ? t("settings.killSwitch.down") : t("settings.killSwitch.up")}
          {state.enabled && state.at ? (
            <span className="block text-xs font-normal opacity-80">
              {t("settings.killSwitch.since", {
                when: new Date(state.at).toLocaleString("fr-CA", { timeZone: "America/Toronto" }),
              })}
              {state.reason ? ` — ${state.reason}` : ""}
            </span>
          ) : null}
        </p>
        {!state.enabled ? (
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="kill-switch-reason">{t("settings.killSwitch.reason")}</Label>
            <Input
              id="kill-switch-reason"
              className="min-h-11 md:min-h-8"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        ) : null}
      </CardContent>
      <CardFooter>
        {state.enabled ? (
          <Button onClick={() => void apply(false)} disabled={pending} className="min-h-11 md:min-h-8">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("settings.killSwitch.raise")}
          </Button>
        ) : (
          <Button
            variant="destructive"
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
            className="min-h-11 md:min-h-8"
          >
            <Power className="size-4" /> {t("settings.killSwitch.lower")}
          </Button>
        )}
      </CardFooter>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.killSwitch.confirmLower")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.killSwitch.confirmLowerBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void apply(true)} disabled={pending}>
              {t("settings.killSwitch.lower")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
