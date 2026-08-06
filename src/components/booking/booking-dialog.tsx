"use client";

import { addDays, addMinutes } from "date-fns";
import { fr as frLocale, enCA } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  ArrowLeft,
  Check,
  Copy,
  House,
  LoaderCircle,
  MapPin,
  TriangleAlert,
  Video,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { createAppointment, type CreateAppointmentInput } from "@/app/(app)/appointments/actions";
import { CallStrip } from "@/components/telephony/call-strip";
import { Button } from "@/components/ui/button";
import { SidePanel } from "@/components/ui/side-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

const FALLBACK_TZ = "America/Toronto";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type BookingClient = { id: string; fullName: string; phone: string; email: string | null };

type AvailabilityResponse = {
  slots: string[];
  duration: number;
  googleConnected: boolean;
  days: number[];
  timezone: string;
  defaultLocation: string;
  viewerIsAdmin: boolean;
};

type Step = 1 | 2 | 3;

function Chip({
  selected,
  disabled,
  onClick,
  className,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors outline-none select-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-40",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-transparent hover:bg-muted dark:bg-input/30",
        className,
      )}
    >
      {children}
    </button>
  );
}

function FieldChips({
  label,
  options,
  value,
  onChange,
  columns = 2,
  error,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string | null;
  onChange: (v: string | null) => void;
  columns?: 2 | 3;
  error?: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn("grid gap-1.5", columns === 3 ? "grid-cols-3" : "grid-cols-2")}
      >
        {options.map((o) => (
          <Chip
            key={o.value}
            selected={value === o.value}
            onClick={() => onChange(value === o.value ? null : o.value)}
          >
            {o.label}
          </Chip>
        ))}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Booking flow used by other modules (client page, post-call popup).
 * Rendered as a NON-modal right side panel so the caller can keep talking
 * (and keep the call controls at hand via the CallStrip) while booking.
 * The inner flow is mounted only while open, so state resets on every opening.
 */
export function BookingDialog({
  client,
  open,
  onOpenChange,
}: {
  client: BookingClient;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useTranslations("booking");
  return (
    <SidePanel
      id="booking"
      open={open}
      onClose={() => onOpenChange(false)}
      title={t("dialog.title")}
      subtitle={`${client.fullName} · ${formatPhone(client.phone)}`}
    >
      {open ? <BookingFlow client={client} onOpenChange={onOpenChange} /> : null}
    </SidePanel>
  );
}

function BookingFlow({
  client,
  onOpenChange,
}: {
  client: BookingClient;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const dateLocale = locale === "en" ? enCA : frLocale;
  const router = useRouter();

  const todayStr = useMemo(() => formatInTimeZone(new Date(), FALLBACK_TZ, "yyyy-MM-dd"), []);

  const [step, setStep] = useState<Step>(1);

  // Step 1 — qualification
  const [projectType, setProjectType] = useState<string | null>(null);
  const [timing, setTiming] = useState<string | null>(null);
  const [budget, setBudget] = useState<string | null>(null);
  const [financing, setFinancing] = useState<string | null>(null);
  const [situation, setSituation] = useState<string | null>(null);
  const [sector, setSector] = useState("");
  const [email, setEmail] = useState(client.email ?? "");
  const [notes, setNotes] = useState("");
  const [projectError, setProjectError] = useState(false);
  const [emailError, setEmailError] = useState(false);

  // Step 2 — type + slot
  const [type, setType] = useState<"meet" | "inperson">("meet");
  const [location, setLocation] = useState("");
  const locationTouchedRef = useRef(false);
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [fetchNonce, setFetchNonce] = useState(0);
  const [query, setQuery] = useState<{
    key: string;
    data: AvailabilityResponse | null;
    error: boolean;
  } | null>(null);

  const [submitting, startSubmit] = useTransition();

  const queryKey = `${selectedDate}|${type}|${fetchNonce}`;

  useEffect(() => {
    if (step !== 2) return;
    const controller = new AbortController();
    const key = queryKey;
    fetch(`/api/availability?date=${selectedDate}&type=${type}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("availability_failed");
        const data = (await res.json()) as AvailabilityResponse;
        if (!locationTouchedRef.current && data.defaultLocation) {
          setLocation((loc) => (loc === "" ? data.defaultLocation : loc));
        }
        setQuery({ key, data, error: false });
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setQuery((prev) => ({ key, data: prev?.data ?? null, error: true }));
      });
    return () => controller.abort();
  }, [step, selectedDate, type, queryKey]);

  const availability = query?.data ?? null;
  const fresh = query?.key === queryKey;
  const loadingSlots = !fresh;
  const slotsError = fresh && query?.error === true;
  const tz = availability?.timezone ?? FALLBACK_TZ;
  const timeFormat = locale === "en" ? "h:mm a" : "HH 'h' mm";

  const days = useMemo(() => {
    const anchor = new Date(`${todayStr}T12:00:00Z`);
    return Array.from({ length: 14 }, (_, i) => {
      const d = addDays(anchor, i);
      return {
        dateStr: d.toISOString().slice(0, 10),
        weekday: d.getUTCDay(),
        labelTop: formatInTimeZone(d, "UTC", "EEE", { locale: dateLocale }),
        labelDay: formatInTimeZone(d, "UTC", "d", { locale: dateLocale }),
      };
    });
  }, [todayStr, dateLocale]);

  function validateStep1(): boolean {
    const badProject = !projectType;
    const badEmail = email.trim() !== "" && !EMAIL_RE.test(email.trim());
    setProjectError(badProject);
    setEmailError(badEmail);
    return !badProject && !badEmail;
  }

  function goNext() {
    if (step === 1) {
      if (!validateStep1()) return;
      setStep(2);
    } else if (step === 2) {
      if (!selectedSlot) return;
      setStep(3);
    }
  }

  function refetchSlots() {
    setFetchNonce((n) => n + 1);
  }

  function submit() {
    if (!selectedSlot || !projectType) return;
    const input: CreateAppointmentInput = {
      clientId: client.id,
      type,
      startsAt: selectedSlot,
      location: type === "inperson" ? location.trim() : null,
      email: email.trim(),
      qualification: {
        projectType: projectType as "acheter" | "vendre" | "les_deux",
        timing: (timing as CreateAppointmentInput["qualification"]["timing"]) ?? null,
        budget: (budget as CreateAppointmentInput["qualification"]["budget"]) ?? null,
        financing: (financing as CreateAppointmentInput["qualification"]["financing"]) ?? null,
        currentSituation:
          (situation as CreateAppointmentInput["qualification"]["currentSituation"]) ?? null,
        sector: sector.trim(),
        notes: notes.trim(),
      },
    };
    startSubmit(async () => {
      const res = await createAppointment(input);
      if (res.ok) {
        const when = formatInTimeZone(
          new Date(res.startsAt),
          tz,
          locale === "en" ? `EEE MMM d, ${timeFormat}` : `EEE d MMM, ${timeFormat}`,
          { locale: dateLocale },
        );
        toast.success(t("toasts.booked", { date: when }), {
          duration: 10000,
          action: res.meetLink
            ? {
                label: t("toasts.copyMeet"),
                onClick: () => {
                  void navigator.clipboard.writeText(res.meetLink as string);
                  toast.success(t("toasts.meetCopied"));
                },
              }
            : undefined,
        });
        if (res.warning === "google_not_connected") {
          toast.warning(t("toasts.googleNotConnected"));
        } else if (res.warning === "google_sync_failed") {
          toast.warning(t("toasts.googleSyncFailed"));
        }
        onOpenChange(false);
        router.refresh();
      } else if (res.error === "slot_taken") {
        toast.error(t("toasts.slotTaken"));
        setSelectedSlot(null);
        setStep(2);
        refetchSlots();
      } else {
        toast.error(t("toasts.error"));
      }
    });
  }

  const steps: { id: Step; label: string }[] = [
    { id: 1, label: t("dialog.steps.qualification") },
    { id: 2, label: t("dialog.steps.slot") },
    { id: 3, label: t("dialog.steps.confirm") },
  ];

  const slotDate = selectedSlot ? new Date(selectedSlot) : null;
  const slotEnd = slotDate && availability ? addMinutes(slotDate, availability.duration) : null;

  return (
    <div className="flex min-h-full flex-col">
      <div className="space-y-3 p-4 pb-3">
        {/* Contrôles d'appel à portée de main pendant la réservation */}
        <CallStrip />

        {/* Progress header */}
        <ol
          className="flex items-center gap-1.5"
          aria-label={t("dialog.stepOf", { current: step, total: 3 })}
        >
          {steps.map((s) => (
            <li key={s.id} className="flex flex-1 flex-col gap-1">
              <span
                className={cn("h-1 rounded-full", step >= s.id ? "bg-primary" : "bg-muted")}
              />
              <span
                className={cn(
                  "truncate text-[11px] leading-tight",
                  step === s.id ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {s.label}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="space-y-4 px-4 pb-4">
        {/* ── Step 1 — qualification ── */}
        {step === 1 && (
          <div className="space-y-4">
            <FieldChips
              label={t("qualification.projectType")}
              columns={3}
              options={[
                { value: "acheter", label: t("qualification.project.acheter") },
                { value: "vendre", label: t("qualification.project.vendre") },
                { value: "les_deux", label: t("qualification.project.les_deux") },
              ]}
              value={projectType}
              onChange={(v) => {
                setProjectType(v);
                if (v) setProjectError(false);
              }}
              error={projectError ? t("qualification.projectRequired") : null}
            />
            <FieldChips
              label={t("qualification.timing")}
              options={(["0_3", "3_6", "6_12", "12_plus"] as const).map((v) => ({
                value: v,
                label: t(`qualification.timingOptions.${v}`),
              }))}
              value={timing}
              onChange={setTiming}
            />
            <FieldChips
              label={t("qualification.budget")}
              options={(
                ["lt_250k", "250_400k", "400_600k", "600_800k", "800k_1m", "gt_1m"] as const
              ).map((v) => ({ value: v, label: t(`qualification.budgetOptions.${v}`) }))}
              value={budget}
              onChange={setBudget}
            />
            <FieldChips
              label={t("qualification.financing")}
              columns={3}
              options={(["oui", "non", "en_demarche"] as const).map((v) => ({
                value: v,
                label: t(`qualification.financingOptions.${v}`),
              }))}
              value={financing}
              onChange={setFinancing}
            />
            <FieldChips
              label={t("qualification.situation")}
              options={(["locataire", "proprietaire"] as const).map((v) => ({
                value: v,
                label: t(`qualification.situationOptions.${v}`),
              }))}
              value={situation}
              onChange={setSituation}
            />
            <div className="space-y-1.5">
              <Label htmlFor="booking-sector">{t("qualification.sector")}</Label>
              <Input
                id="booking-sector"
                value={sector}
                onChange={(e) => setSector(e.target.value)}
                placeholder={t("qualification.sectorPlaceholder")}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-email">{t("qualification.email")}</Label>
              <Input
                id="booking-email"
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError(false);
                }}
                aria-invalid={emailError || undefined}
                placeholder={t("qualification.emailPlaceholder")}
                className="h-11"
              />
              {emailError ? (
                <p className="text-xs text-destructive">{t("qualification.emailInvalid")}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("qualification.emailHelp")}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-notes">{t("qualification.notes")}</Label>
              <Textarea
                id="booking-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("qualification.notesPlaceholder")}
              />
            </div>
          </div>
        )}

        {/* ── Step 2 — type + slot ── */}
        {step === 2 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("slot.type")}</Label>
              <div
                role="radiogroup"
                aria-label={t("slot.type")}
                className="grid grid-cols-2 gap-1.5"
              >
                <Chip
                  selected={type === "meet"}
                  onClick={() => {
                    setType("meet");
                    setSelectedSlot(null);
                  }}
                >
                  <Video className="size-4" />
                  {t("slot.meet")}
                </Chip>
                <Chip
                  selected={type === "inperson"}
                  onClick={() => {
                    setType("inperson");
                    setSelectedSlot(null);
                  }}
                >
                  <House className="size-4" />
                  {t("slot.inperson")}
                </Chip>
              </div>
              {availability ? (
                <p className="text-xs text-muted-foreground">
                  {t("slot.durationMin", { min: availability.duration })}
                </p>
              ) : null}
            </div>

            {type === "inperson" && (
              <div className="space-y-1.5">
                <Label htmlFor="booking-location">{t("slot.location")}</Label>
                <Input
                  id="booking-location"
                  value={location}
                  onChange={(e) => {
                    locationTouchedRef.current = true;
                    setLocation(e.target.value);
                  }}
                  placeholder={t("slot.locationPlaceholder")}
                  className="h-11"
                />
              </div>
            )}

            {availability && !availability.googleConnected && availability.viewerIsAdmin && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{t("slot.googleWarning")}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>{t("slot.pickDate")}</Label>
              {/* 14 jours en grille 7 × 2 — aucun défilement horizontal. */}
              <div
                className="grid grid-cols-7 gap-1"
                role="radiogroup"
                aria-label={t("slot.pickDate")}
              >
                {days.map((d) => {
                  const disabled =
                    availability != null && !availability.days.includes(d.weekday);
                  return (
                    <Chip
                      key={d.dateStr}
                      selected={selectedDate === d.dateStr}
                      disabled={disabled}
                      onClick={() => {
                        setSelectedDate(d.dateStr);
                        setSelectedSlot(null);
                      }}
                      className="min-w-0 flex-col gap-0 px-0.5"
                    >
                      <span className="text-[10px] uppercase opacity-70">{d.labelTop}</span>
                      <span className="text-sm font-semibold">{d.labelDay}</span>
                    </Chip>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label>{t("slot.pickTime")}</Label>
                <span className="text-[11px] text-muted-foreground">
                  {t("slot.timezoneNote")}
                </span>
              </div>
              {loadingSlots ? (
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                  {Array.from({ length: 8 }, (_, i) => (
                    <Skeleton key={i} className="h-11 rounded-lg" />
                  ))}
                </div>
              ) : slotsError ? (
                <div className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm text-muted-foreground">
                  <p>{t("slot.loadError")}</p>
                  <Button type="button" variant="outline" size="sm" onClick={refetchSlots}>
                    {t("slot.retry")}
                  </Button>
                </div>
              ) : availability && availability.slots.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  {t("slot.noSlots")}
                </p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label={t("slot.pickTime")}
                  className="grid grid-cols-3 gap-1.5 sm:grid-cols-4"
                >
                  {availability?.slots.map((iso) => (
                    <Chip
                      key={iso}
                      selected={selectedSlot === iso}
                      onClick={() => setSelectedSlot(iso)}
                    >
                      {formatInTimeZone(new Date(iso), tz, timeFormat, { locale: dateLocale })}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Step 3 — confirmation ── */}
        {step === 3 && slotDate && (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/30 p-4">
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t("confirm.client")}</dt>
                  <dd className="text-right font-medium">{client.fullName}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t("confirm.phone")}</dt>
                  <dd className="text-right">{formatPhone(client.phone)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t("confirm.email")}</dt>
                  <dd className="text-right break-all">
                    {email.trim() || (
                      <span className="text-muted-foreground italic">{t("confirm.noEmail")}</span>
                    )}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t("confirm.date")}</dt>
                  <dd className="text-right font-medium capitalize">
                    {formatInTimeZone(
                      slotDate,
                      tz,
                      locale === "en" ? "EEEE, MMMM d, yyyy" : "EEEE d MMMM yyyy",
                      { locale: dateLocale },
                    )}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t("confirm.time")}</dt>
                  <dd className="text-right font-medium">
                    {formatInTimeZone(slotDate, tz, timeFormat, { locale: dateLocale })}
                    {slotEnd
                      ? ` – ${formatInTimeZone(slotEnd, tz, timeFormat, { locale: dateLocale })}`
                      : ""}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{t("confirm.type")}</dt>
                  <dd className="flex items-center justify-end gap-1.5 text-right">
                    {type === "meet" ? (
                      <>
                        <Video className="size-4" /> {t("slot.meet")}
                      </>
                    ) : (
                      <>
                        <House className="size-4" /> {t("slot.inperson")}
                      </>
                    )}
                  </dd>
                </div>
                {type === "inperson" && location.trim() ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{t("confirm.location")}</dt>
                    <dd className="flex items-start justify-end gap-1.5 text-right">
                      <MapPin className="mt-0.5 size-4 shrink-0" />
                      {location.trim()}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
            {type === "meet" && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Copy className="size-3.5" /> {t("confirm.meetInfo")}
              </p>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-1">
          {step > 1 ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11 px-3"
              disabled={submitting}
              onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
            >
              <ArrowLeft className="size-4" />
              {t("actions.back")}
            </Button>
          ) : (
            <span />
          )}
          {step < 3 ? (
            <Button
              type="button"
              className="h-11 px-5"
              onClick={goNext}
              disabled={step === 2 && !selectedSlot}
            >
              {t("actions.next")}
            </Button>
          ) : (
            <Button type="button" className="h-11 px-5" onClick={submit} disabled={submitting}>
              {submitting ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {t("confirm.booking")}
                </>
              ) : (
                <>
                  <Check className="size-4" />
                  {t("confirm.confirm")}
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
