"use client";

import { addDays, addMinutes } from "date-fns";
import { fr as frLocale, enCA } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import {
  ArrowLeft,
  ArrowRight,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidePanel } from "@/components/ui/side-panel";
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

// ── Petits blocs UI ──────────────────────────────────────────────────────────

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
        "flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-sm font-medium transition-colors outline-none select-none",
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

/** Menu déroulant compact pour les champs de qualification optionnels. */
function QualifSelect({
  label,
  placeholder,
  value,
  onChange,
  options,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  onChange: (v: string | null) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as string | null)}>
        <SelectTrigger className="h-11 w-full data-[size=default]:h-11">
          <SelectValue>{(v: string | null) => (v ? options.find((o) => o.value === v)?.label : placeholder)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── Panneau ──────────────────────────────────────────────────────────────────

/**
 * Flux de réservation — panneau latéral droit NON modal : la fiche client et
 * l'appel en cours restent accessibles (CallStrip en tête pendant un appel).
 * Le flux interne est monté seulement quand ouvert → état remis à zéro à
 * chaque ouverture.
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
      className="sm:w-[30rem]"
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

  // Étape 1 — qualification
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

  // Étape 2 — type + plage
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
        labelTop: formatInTimeZone(d, "UTC", "EEEEE", { locale: dateLocale }),
        labelDay: formatInTimeZone(d, "UTC", "d", { locale: dateLocale }),
      };
    });
  }, [todayStr, dateLocale]);

  /** Plages groupées : matin < 12 h, après-midi 12–17 h, soirée ≥ 17 h (heure locale). */
  const slotGroups = useMemo(() => {
    const groups: { key: "morning" | "afternoon" | "evening"; slots: string[] }[] = [
      { key: "morning", slots: [] },
      { key: "afternoon", slots: [] },
      { key: "evening", slots: [] },
    ];
    for (const iso of availability?.slots ?? []) {
      const hour = Number(formatInTimeZone(new Date(iso), tz, "H"));
      if (hour < 12) groups[0].slots.push(iso);
      else if (hour < 17) groups[1].slots.push(iso);
      else groups[2].slots.push(iso);
    }
    return groups.filter((g) => g.slots.length > 0);
  }, [availability, tz]);

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
      <div className="flex-1 space-y-5 p-4">
        {/* Contrôles d'appel à portée de main pendant la réservation */}
        <CallStrip />

        {/* Étapes — pastilles numérotées */}
        <ol
          className="flex items-center"
          aria-label={t("dialog.stepOf", { current: step, total: 3 })}
        >
          {steps.map((s, i) => (
            <li key={s.id} className={cn("flex items-center", i > 0 && "flex-1")}>
              {i > 0 ? (
                <span
                  className={cn("mx-2 h-px flex-1", step > i ? "bg-primary" : "bg-border")}
                  aria-hidden
                />
              ) : null}
              <button
                type="button"
                onClick={() => {
                  // Retour libre vers une étape déjà franchie.
                  if (s.id < step) setStep(s.id);
                }}
                className={cn(
                  "flex items-center gap-1.5",
                  s.id < step ? "cursor-pointer" : "cursor-default",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                    step > s.id
                      ? "bg-primary text-primary-foreground"
                      : step === s.id
                        ? "border-2 border-primary text-primary"
                        : "border border-border text-muted-foreground",
                  )}
                >
                  {step > s.id ? <Check className="size-3.5" /> : s.id}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    step === s.id ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </span>
              </button>
            </li>
          ))}
        </ol>

        {/* ── Étape 1 — qualification ── */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>
                {t("qualification.projectType")} <span className="text-destructive">*</span>
              </Label>
              <div
                role="radiogroup"
                aria-label={t("qualification.projectType")}
                className="grid grid-cols-3 gap-1.5"
              >
                {(["acheter", "vendre", "les_deux"] as const).map((v) => (
                  <Chip
                    key={v}
                    selected={projectType === v}
                    onClick={() => {
                      setProjectType(projectType === v ? null : v);
                      setProjectError(false);
                    }}
                  >
                    {t(`qualification.project.${v}`)}
                  </Chip>
                ))}
              </div>
              {projectError ? (
                <p className="text-xs text-destructive">{t("qualification.projectRequired")}</p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <QualifSelect
                label={t("qualification.timing")}
                placeholder={t("qualification.selectPlaceholder")}
                value={timing}
                onChange={setTiming}
                options={(["0_3", "3_6", "6_12", "12_plus"] as const).map((v) => ({
                  value: v,
                  label: t(`qualification.timingOptions.${v}`),
                }))}
              />
              <QualifSelect
                label={t("qualification.budget")}
                placeholder={t("qualification.selectPlaceholder")}
                value={budget}
                onChange={setBudget}
                options={(
                  ["lt_250k", "250_400k", "400_600k", "600_800k", "800k_1m", "gt_1m"] as const
                ).map((v) => ({ value: v, label: t(`qualification.budgetOptions.${v}`) }))}
              />
              <QualifSelect
                label={t("qualification.financing")}
                placeholder={t("qualification.selectPlaceholder")}
                value={financing}
                onChange={setFinancing}
                options={(["oui", "non", "en_demarche"] as const).map((v) => ({
                  value: v,
                  label: t(`qualification.financingOptions.${v}`),
                }))}
              />
              <QualifSelect
                label={t("qualification.situation")}
                placeholder={t("qualification.selectPlaceholder")}
                value={situation}
                onChange={setSituation}
                options={(["locataire", "proprietaire"] as const).map((v) => ({
                  value: v,
                  label: t(`qualification.situationOptions.${v}`),
                }))}
              />
            </div>

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
                placeholder={t("qualification.emailPlaceholder")}
                aria-invalid={emailError}
                className="h-11"
              />
              {emailError ? (
                <p className="text-xs text-destructive">{t("qualification.emailInvalid")}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("qualification.emailHint")}</p>
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

        {/* ── Étape 2 — type + plage ── */}
        {step === 2 && (
          <div className="space-y-4">
            <div
              role="radiogroup"
              aria-label={t("slot.type")}
              className="grid grid-cols-2 gap-1.5"
            >
              {(
                [
                  { v: "meet" as const, icon: Video, label: t("slot.meet") },
                  { v: "inperson" as const, icon: House, label: t("slot.inperson") },
                ] as const
              ).map(({ v, icon: Icon, label }) => (
                <Chip
                  key={v}
                  selected={type === v}
                  onClick={() => {
                    setType(v);
                    setSelectedSlot(null);
                  }}
                  className="h-16 flex-col gap-1"
                >
                  <Icon className="size-5" />
                  <span className="text-xs leading-tight">{label}</span>
                </Chip>
              ))}
            </div>
            {availability ? (
              <p className="-mt-2 text-xs text-muted-foreground">
                {t("slot.durationMin", { min: availability.duration })}
              </p>
            ) : null}

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
              {/* 14 jours en grille 7 × 2 — fluide, aucun défilement horizontal. */}
              <div
                className="grid grid-cols-7 gap-1"
                role="radiogroup"
                aria-label={t("slot.pickDate")}
              >
                {days.map((d) => {
                  const disabled = availability != null && !availability.days.includes(d.weekday);
                  const isToday = d.dateStr === todayStr;
                  return (
                    <Chip
                      key={d.dateStr}
                      selected={selectedDate === d.dateStr}
                      disabled={disabled}
                      onClick={() => {
                        setSelectedDate(d.dateStr);
                        setSelectedSlot(null);
                      }}
                      className={cn(
                        "h-12 flex-col gap-0 px-0",
                        isToday && selectedDate !== d.dateStr && "border-primary/50",
                      )}
                    >
                      <span className="text-[10px] uppercase opacity-70">{d.labelTop}</span>
                      <span className="text-sm font-semibold">{d.labelDay}</span>
                    </Chip>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>{t("slot.pickTime")}</Label>
                <span className="text-[11px] text-muted-foreground">{t("slot.timezoneNote")}</span>
              </div>
              {loadingSlots ? (
                <div className="grid grid-cols-3 gap-1.5">
                  {Array.from({ length: 9 }, (_, i) => (
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
              ) : slotGroups.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  {t("slot.noSlots")}
                </p>
              ) : (
                <div className="space-y-3">
                  {slotGroups.map((g) => (
                    <div key={g.key} className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t(`slot.groups.${g.key}`)}
                      </p>
                      <div
                        role="radiogroup"
                        aria-label={t(`slot.groups.${g.key}`)}
                        className="grid grid-cols-3 gap-1.5"
                      >
                        {g.slots.map((iso) => (
                          <Chip
                            key={iso}
                            selected={selectedSlot === iso}
                            onClick={() => setSelectedSlot(iso)}
                          >
                            {formatInTimeZone(new Date(iso), tz, timeFormat, {
                              locale: dateLocale,
                            })}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Étape 3 — confirmation ── */}
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
      </div>

      {/* ── Pied collant : actions toujours visibles ── */}
      <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        {step > 1 ? (
          <Button
            type="button"
            variant="outline"
            className="h-12 px-4"
            disabled={submitting}
            onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
          >
            <ArrowLeft className="size-4" />
            {t("actions.back")}
          </Button>
        ) : null}
        {step < 3 ? (
          <Button
            type="button"
            className="h-12 flex-1"
            onClick={goNext}
            disabled={step === 2 && !selectedSlot}
          >
            {t("actions.next")}
            <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            className="h-12 flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={submit}
            disabled={submitting}
          >
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
  );
}
