"use client";

/**
 * Dock du téléphone navigateur — monté globalement dans le layout (app).
 *
 * 1. FAB + clavier de composition (Sheet bas, pouces d'abord)
 * 2. Barre d'appel en cours (minuterie, sourdine, attente, DTMF, raccrocher)
 * 3. Popup d'appel entrant (sonnerie WebAudio, fiche client si reconnue)
 * 4. Popup de disposition d'après-appel (cœur du pipeline)
 *
 * Mobile d'abord : tout est positionné AU-DESSUS de la nav basse (h-14 + safe
 * area) ; cibles tactiles ≥ 44 px.
 */

import { fr as frLocale, enUS as enLocale } from "date-fns/locale";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import {
  Delete,
  ExternalLink,
  Hash,
  Mic,
  MicOff,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneOff,
  Play,
  RotateCw,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Disposition } from "@/db/schema";
import { DISPOSITION_CONFIG, DISPOSITION_ORDER } from "@/lib/dispositions";
import { formatPhone, normalizePhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import {
  type PendingDisposition,
  type TelephonyContextValue,
  useTelephony,
} from "@/components/telephony/telephony-context";

const TZ = "America/Toronto";
/** Au-dessus de la nav basse mobile (h-14) + safe area. */
const ABOVE_NAV = "bottom-[calc(4.5rem+env(safe-area-inset-bottom))]";

const DIAL_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

function formatTimer(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────

export function WebphoneDock() {
  const tel = useTelephony();
  if (!tel.provider) return null;
  return (
    <TooltipProvider>
      {tel.ready ? <DialFab /> : null}
      <CallBar />
      <IncomingCallDialog />
      <DispositionDialog />
    </TooltipProvider>
  );
}

// ── 1. FAB + clavier de composition ─────────────────────────────────────────

const REG_DOT: Record<string, string> = {
  registered: "bg-emerald-500",
  registering: "bg-amber-500",
  unregistered: "bg-amber-500",
  failed: "bg-red-500",
};

function DialFab() {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");

  if (tel.callState !== "idle" || tel.incomingCall) return null;

  const statusLabel = t(`status.${tel.registration}`);

  const placeCall = () => {
    const normalized = normalizePhone(number);
    if (!normalized) {
      toast.error(t("errors.invalid_number"));
      return;
    }
    tel.dial({ number: normalized });
    setNumber("");
    setOpen(false);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              onClick={() => setOpen(true)}
              aria-label={t("fab.open")}
              className={cn(
                "fixed right-4 z-40 size-14 rounded-full shadow-lg md:right-6 md:bottom-6",
                ABOVE_NAV,
              )}
            />
          }
        >
          <Phone className="size-6" />
          <span
            aria-hidden
            className={cn(
              "absolute top-1 right-1 size-3 rounded-full ring-2 ring-background",
              REG_DOT[tel.registration],
            )}
          />
        </TooltipTrigger>
        <TooltipContent side="left">{statusLabel}</TooltipContent>
      </Tooltip>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto w-full max-w-sm">
            <SheetHeader className="pb-0">
              <SheetTitle>{t("dialpad.title")}</SheetTitle>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={cn("size-2 rounded-full", REG_DOT[tel.registration])}
                  aria-hidden
                />
                {statusLabel}
                {tel.registration === "failed" ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={tel.retryRegistration}
                    className="ml-1"
                  >
                    <RotateCw data-icon="inline-start" />
                    {t("status.retry")}
                  </Button>
                ) : null}
              </div>
            </SheetHeader>

            <div className="space-y-3 p-4">
              <div className="flex items-center gap-2">
                <Input
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") placeCall();
                  }}
                  placeholder={t("dialpad.placeholder")}
                  aria-label={t("dialpad.placeholder")}
                  className="h-12 text-center text-lg font-medium tracking-wide"
                />
                <Button
                  variant="ghost"
                  className="size-12 shrink-0"
                  onClick={() => setNumber((n) => n.slice(0, -1))}
                  aria-label={t("dialpad.backspace")}
                >
                  <Delete className="size-5" />
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {DIAL_KEYS.map((key) => (
                  <Button
                    key={key}
                    variant="secondary"
                    className="h-14 text-xl font-semibold"
                    onClick={() => setNumber((n) => n + key)}
                  >
                    {key}
                  </Button>
                ))}
              </div>

              <Button
                onClick={placeCall}
                disabled={tel.registration !== "registered" || !number.trim()}
                className="h-14 w-full bg-emerald-600 text-base text-white hover:bg-emerald-700"
              >
                <Phone data-icon="inline-start" className="size-5" />
                {t("dialpad.call")}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

// ── 2. Barre d'appel en cours ───────────────────────────────────────────────

function CallBar() {
  const tel = useTelephony();

  const inCall =
    tel.activeCall !== null &&
    !tel.incomingCall &&
    (tel.callState === "connecting" ||
      tel.callState === "ringing" ||
      tel.callState === "active" ||
      tel.callState === "held");

  // Le composant interne est démonté entre les appels : son état (DTMF,
  // minuterie) repart à zéro naturellement à chaque nouvel appel.
  if (!inCall || !tel.activeCall) return null;
  return <ActiveCallBar tel={tel} call={tel.activeCall} />;
}

/** Minuterie d'appel — tic 1 s à partir du décroché. */
function useElapsedSeconds(answeredAtMs: number | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(answeredAtMs === null ? null : 0);
  useEffect(() => {
    if (answeredAtMs === null) return;
    const update = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - answeredAtMs) / 1000)));
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [answeredAtMs]);
  return answeredAtMs === null ? null : (elapsed ?? 0);
}

function ActiveCallBar({
  tel,
  call,
}: {
  tel: TelephonyContextValue;
  call: NonNullable<TelephonyContextValue["activeCall"]>;
}) {
  const t = useTranslations("phone");
  const [dtmfOpen, setDtmfOpen] = useState(false);
  const [dtmfHistory, setDtmfHistory] = useState("");
  const elapsed = useElapsedSeconds(call.answeredAt?.getTime() ?? null);

  const stateLabel =
    tel.callState === "active"
      ? t("call.active")
      : tel.callState === "held"
        ? t("call.held")
        : tel.callState === "ringing"
          ? t("call.ringing")
          : t("call.connecting");

  const title = call.clientName || formatPhone(call.remoteNumber) || t("call.unknownNumber");

  return (
    <div
      role="status"
      className={cn(
        "fixed inset-x-2 z-40 rounded-2xl border bg-background/95 p-3 shadow-xl backdrop-blur",
        "md:inset-x-auto md:bottom-6 md:left-1/2 md:w-[28rem] md:-translate-x-1/2",
        ABOVE_NAV,
      )}
    >
      <div className="flex items-center gap-3">
        <span className="relative flex size-2.5 shrink-0">
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-75",
              tel.callState === "active" ? "animate-ping bg-emerald-500" : "bg-amber-500",
            )}
          />
          <span
            className={cn(
              "relative inline-flex size-2.5 rounded-full",
              tel.callState === "active" ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
        </span>
        <div className="min-w-0 flex-1">
          {call.clientId ? (
            <Link
              href={`/clients/${call.clientId}`}
              className="block truncate text-sm font-semibold hover:underline"
            >
              {title}
            </Link>
          ) : (
            <p className="truncate text-sm font-semibold">{title}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {stateLabel}
            {call.clientName ? ` · ${formatPhone(call.remoteNumber)}` : ""}
          </p>
        </div>
        <span className="font-mono text-sm tabular-nums text-muted-foreground">
          {elapsed !== null ? formatTimer(elapsed) : "—"}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <Button
          variant={tel.muted ? "default" : "secondary"}
          className="size-11"
          onClick={tel.toggleMute}
          aria-label={tel.muted ? t("call.unmute") : t("call.mute")}
          aria-pressed={tel.muted}
        >
          {tel.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </Button>
        <Button
          variant={tel.held ? "default" : "secondary"}
          className="size-11"
          onClick={tel.toggleHold}
          aria-label={tel.held ? t("call.resume") : t("call.hold")}
          aria-pressed={tel.held}
        >
          {tel.held ? <Play className="size-5" /> : <Pause className="size-5" />}
        </Button>
        <Button
          variant={dtmfOpen ? "default" : "secondary"}
          className="size-11"
          onClick={() => setDtmfOpen((v) => !v)}
          aria-label={t("call.dtmf")}
          aria-pressed={dtmfOpen}
        >
          <Hash className="size-5" />
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="secondary"
                className="size-11"
                aria-label={t("call.speakerHint")}
              />
            }
          >
            <Volume2 className="size-5" />
          </TooltipTrigger>
          <TooltipContent>{t("call.speakerHint")}</TooltipContent>
        </Tooltip>
        <Button
          onClick={tel.hangup}
          className="h-11 flex-1 bg-red-600 text-white hover:bg-red-700"
          aria-label={t("call.hangup")}
        >
          <PhoneOff data-icon="inline-start" className="size-5" />
          {t("call.hangup")}
        </Button>
      </div>

      {dtmfOpen ? (
        <div className="mt-3 border-t pt-3">
          {dtmfHistory ? (
            <p className="mb-2 text-center font-mono text-sm tracking-widest text-muted-foreground">
              {dtmfHistory}
            </p>
          ) : null}
          <div className="grid grid-cols-3 gap-1.5">
            {DIAL_KEYS.map((key) => (
              <Button
                key={key}
                variant="secondary"
                className="h-11 text-base font-semibold"
                onClick={() => {
                  tel.sendDTMF(key);
                  setDtmfHistory((h) => (h + key).slice(-24));
                }}
              >
                {key}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── 3. Appel entrant ────────────────────────────────────────────────────────

/** Sonnerie nord-américaine (440+480 Hz, 2 s / 4 s) — WebAudio, aucun fichier. */
function useRingtone(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let ctx: AudioContext | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let gain: GainNode | null = null;
    const oscillators: OscillatorNode[] = [];
    try {
      ctx = new AudioContext();
      void ctx.resume().catch(() => {});
      gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);
      for (const freq of [440, 480]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start();
        oscillators.push(osc);
      }
      let sec = 0;
      const cadence = () => {
        if (!ctx || !gain) return;
        const on = sec % 6 < 2; // 2 s ON / 4 s OFF
        gain.gain.setTargetAtTime(on ? 0.12 : 0, ctx.currentTime, 0.02);
        if (on && sec % 6 === 0 && typeof navigator !== "undefined" && "vibrate" in navigator) {
          navigator.vibrate?.([400, 200, 400]);
        }
        sec += 1;
      };
      cadence();
      interval = setInterval(cadence, 1_000);
    } catch {
      // WebAudio indisponible — le popup reste visible, sans son
    }
    return () => {
      if (interval) clearInterval(interval);
      for (const osc of oscillators) {
        try {
          osc.stop();
        } catch {
          // déjà arrêté
        }
      }
      gain?.disconnect();
      void ctx?.close().catch(() => {});
    };
  }, [active]);
}

function IncomingCallDialog() {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const incoming = tel.incomingCall;
  useRingtone(incoming !== null);

  return (
    <Dialog open={incoming !== null} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        {incoming ? (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div className="flex size-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
              <PhoneIncoming className="size-8 animate-pulse" />
            </div>
            <DialogHeader className="items-center gap-1">
              <DialogDescription>{t("incoming.title")}</DialogDescription>
              <DialogTitle className="text-2xl leading-tight">
                {incoming.client ? incoming.client.fullName : formatPhone(incoming.number)}
              </DialogTitle>
              {incoming.client ? (
                <div className="flex flex-col items-center gap-1.5">
                  {incoming.client.categoryName ? (
                    <Badge
                      style={
                        incoming.client.categoryColor
                          ? { backgroundColor: incoming.client.categoryColor, color: "#fff" }
                          : undefined
                      }
                    >
                      {incoming.client.categoryName}
                    </Badge>
                  ) : null}
                  <p className="text-sm text-muted-foreground">{formatPhone(incoming.number)}</p>
                  <Link
                    href={`/clients/${incoming.client.id}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    {t("incoming.viewClient")}
                    <ExternalLink className="size-3.5" />
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t("incoming.unknown")}</p>
              )}
            </DialogHeader>
            <div className="flex w-full gap-3">
              <Button
                onClick={tel.reject}
                className="h-14 flex-1 bg-red-600 text-base text-white hover:bg-red-700"
              >
                <PhoneOff data-icon="inline-start" className="size-5" />
                {t("incoming.decline")}
              </Button>
              <Button
                onClick={tel.answer}
                className="h-14 flex-1 bg-emerald-600 text-base text-white hover:bg-emerald-700"
              >
                <Phone data-icon="inline-start" className="size-5" />
                {t("incoming.answer")}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── 4. Disposition d'après-appel ────────────────────────────────────────────

type CallbackChoice = "in1h" | "tomorrow9" | "in3d" | "custom";

function computeCallbackDate(choice: CallbackChoice, customValue: string): Date | null {
  const now = new Date();
  switch (choice) {
    case "in1h":
      return new Date(now.getTime() + 60 * 60 * 1000);
    case "tomorrow9": {
      const zoned = toZonedTime(now, TZ);
      zoned.setDate(zoned.getDate() + 1);
      zoned.setHours(9, 0, 0, 0);
      return fromZonedTime(zoned, TZ);
    }
    case "in3d": {
      const zoned = toZonedTime(now, TZ);
      zoned.setDate(zoned.getDate() + 3);
      zoned.setHours(9, 0, 0, 0);
      return fromZonedTime(zoned, TZ);
    }
    case "custom": {
      if (!customValue) return null;
      const parsed = new Date(customValue);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }
}

function DispositionDialog() {
  const tel = useTelephony();
  const pending = tel.pendingDisposition;
  if (!pending) return null;
  // key = un formulaire vierge pour chaque appel classé.
  return <DispositionForm key={pending.callLogId} tel={tel} pending={pending} />;
}

function DispositionForm({
  tel,
  pending,
}: {
  tel: TelephonyContextValue;
  pending: PendingDisposition;
}) {
  const t = useTranslations("phone");
  const locale = useLocale();
  const router = useRouter();

  const [selected, setSelected] = useState<Disposition | null>(null);
  const [note, setNote] = useState("");
  const [callbackChoice, setCallbackChoice] = useState<CallbackChoice>("in1h");
  const [customDate, setCustomDate] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);

  const dateLocale = locale === "en" ? enLocale : frLocale;
  const withClient = Boolean(pending.clientId);
  const showCallbackPicker = withClient && selected === "callback";
  const followupDueAt = useMemo(
    () => (showCallbackPicker ? computeCallbackDate(callbackChoice, customDate) : null),
    [showCallbackPicker, callbackChoice, customDate],
  );

  const submit = useCallback(async () => {
    if (!selected || saving) return;
    if (showCallbackPicker && !followupDueAt) {
      toast.error(t("disposition.pickDate"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/calls/${pending.callLogId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          disposition: selected,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(followupDueAt ? { followupDueAt: followupDueAt.toISOString() } : {}),
        }),
      });
      if (!res.ok) throw new Error("save_failed");
      toast.success(t("disposition.saved"));
      tel.clearPendingDisposition();
      if (selected === "booked" && pending.clientId) {
        router.push(`/clients/${pending.clientId}?book=1`);
      }
    } catch {
      toast.error(t("errors.save_failed"));
      setSaving(false);
    }
  }, [pending, selected, saving, showCallbackPicker, followupDueAt, note, t, tel, router]);

  const title = pending.clientName || formatPhone(pending.number) || t("call.unknownNumber");

  const requestClose = () => {
    if (!confirmClose) setConfirmClose(true);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("disposition.title")}</DialogTitle>
          <DialogDescription>
            {title}
            {pending.durationSec > 0 ? ` · ${formatTimer(pending.durationSec)}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          {DISPOSITION_ORDER.map((d) => {
            const config = DISPOSITION_CONFIG[d];
            const active = selected === d;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setSelected(d)}
                aria-pressed={active}
                className={cn(
                  "flex min-h-12 items-center gap-2.5 rounded-xl border-2 px-3 py-2 text-left text-sm font-semibold transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px",
                  active ? "text-white shadow-md" : "bg-background hover:bg-muted",
                )}
                style={
                  active
                    ? { backgroundColor: config.color, borderColor: config.color }
                    : { borderColor: `${config.color}66` }
                }
              >
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: active ? "#fff" : config.color }}
                />
                {t(`disposition.options.${d}`)}
              </button>
            );
          })}
        </div>

        {showCallbackPicker ? (
          <div className="space-y-2 rounded-xl bg-muted/60 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              {t("disposition.callbackWhen")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(["in1h", "tomorrow9", "in3d", "custom"] as const).map((choice) => (
                <Button
                  key={choice}
                  size="sm"
                  variant={callbackChoice === choice ? "default" : "outline"}
                  className="h-9"
                  onClick={() => setCallbackChoice(choice)}
                >
                  {t(`disposition.chips.${choice}`)}
                </Button>
              ))}
            </div>
            {callbackChoice === "custom" ? (
              <Input
                type="datetime-local"
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="h-11"
                aria-label={t("disposition.chips.custom")}
              />
            ) : null}
            {followupDueAt ? (
              <p className="text-xs text-muted-foreground">
                {t("disposition.followupPlanned", {
                  date: formatInTimeZone(
                    followupDueAt,
                    TZ,
                    locale === "en" ? "EEEE, MMMM d, h:mm a" : "EEEE d MMMM, HH 'h' mm",
                    { locale: dateLocale },
                  ),
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("disposition.notePlaceholder")}
          className="min-h-20"
        />

        {confirmClose ? (
          <div className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-sm font-medium">{t("disposition.dismissTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("disposition.dismissBody")}</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-10 flex-1"
                onClick={() => setConfirmClose(false)}
              >
                {t("disposition.dismissCancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-10 flex-1"
                onClick={tel.clearPendingDisposition}
              >
                {t("disposition.dismissConfirm")}
              </Button>
            </div>
          </div>
        ) : null}

        <Button
          onClick={submit}
          disabled={!selected || saving}
          className="h-12 w-full text-base"
        >
          {saving ? t("disposition.saving") : t("disposition.save")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
