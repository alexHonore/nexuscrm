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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AudioDevicePicker } from "@/components/telephony/audio-device-picker";
import {
  startRingtone,
  stopRingtone,
  subscribeToneState,
  tonesAudible,
  unlockTones,
} from "@/lib/telephony/tones";
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
import { SidePanel, type SidePanelEventDetail } from "@/components/ui/side-panel";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DISPOSITION_CONFIG,
  DISPOSITION_ORDER,
  dispositionTextColor,
  pipelineDispositionOptions,
  type DispositionOption,
  type PipelineCategory,
} from "@/lib/dispositions";
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

/** Lettres classiques du cadran téléphonique — universelles, pas d'i18n. */
const DIAL_KEY_LETTERS: Partial<Record<(typeof DIAL_KEYS)[number], string>> = {
  "2": "ABC",
  "3": "DEF",
  "4": "GHI",
  "5": "JKL",
  "6": "MNO",
  "7": "PQRS",
  "8": "TUV",
  "9": "WXYZ",
  "0": "+",
};

function formatTimer(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────

function isDesktopViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
}

export function WebphoneDock() {
  const tel = useTelephony();
  const [panelOpen, setPanelOpen] = useState(false);
  const [otherPanelOpen, setOtherPanelOpen] = useState(false);

  // Préchauffe la liste des statuts : le popup d'après-appel ne doit pas
  // s'ouvrir sur les 7 anciens boutons puis se réordonner sous les doigts.
  useEffect(() => {
    void fetchPipelineCategories();
  }, []);

  const inCall =
    tel.activeCall !== null &&
    (tel.callState === "connecting" ||
      tel.callState === "ringing" ||
      tel.callState === "active" ||
      tel.callState === "held");

  // Coordination : si un autre panneau (réservation) s'ouvre, le nôtre se ferme
  // via SidePanel ; on retient son état pour masquer la pastille flottante.
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<SidePanelEventDetail>).detail;
      if (d.id !== "phone") setOtherPanelOpen(d.open);
    };
    window.addEventListener("nexus:sidepanel", handler);
    return () => window.removeEventListener("nexus:sidepanel", handler);
  }, []);

  // Desktop : ouverture auto du panneau au début d'un appel, fermeture à la fin.
  const prevInCallRef = useRef(false);
  useEffect(() => {
    const was = prevInCallRef.current;
    prevInCallRef.current = inCall;
    if (inCall && !was && isDesktopViewport() && !otherPanelOpen) setPanelOpen(true);
    else if (!inCall && was) setPanelOpen(false);
  }, [inCall, otherPanelOpen]);

  if (!tel.provider) return null;

  return (
    <TooltipProvider>
      {tel.ready && !panelOpen ? <DialFab onOpenPanel={() => setPanelOpen(true)} /> : null}
      <CallBar />
      <PhonePanel open={panelOpen} onClose={() => setPanelOpen(false)} inCall={inCall} />
      {inCall && !panelOpen && !otherPanelOpen ? (
        <DesktopCallPill onOpen={() => setPanelOpen(true)} />
      ) : null}
      <IncomingCallDialog />
      <DispositionDialog />
    </TooltipProvider>
  );
}

// ── 0. Panneau téléphone (desktop) ──────────────────────────────────────────

function PhonePanel({
  open,
  onClose,
  inCall,
}: {
  open: boolean;
  onClose: () => void;
  inCall: boolean;
}) {
  const t = useTranslations("phone");
  const tel = useTelephony();

  return (
    <SidePanel id="phone" open={open} onClose={onClose} title={t("panel.title")}>
      <div className="space-y-4 p-4">
        {inCall && tel.activeCall ? (
          <ActiveCallPanelCard tel={tel} call={tel.activeCall} />
        ) : (
          <DialpadContent />
        )}
      </div>
    </SidePanel>
  );
}

function ActiveCallPanelCard({
  tel,
  call,
}: {
  tel: TelephonyContextValue;
  call: NonNullable<TelephonyContextValue["activeCall"]>;
}) {
  const t = useTranslations("phone");
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
      className={cn(
        "flex flex-col items-center gap-4 rounded-2xl p-4 pt-6 text-center transition-colors",
        tel.callState === "active" && "bg-emerald-500/5",
        tel.callState === "held" && "bg-amber-500/5",
      )}
    >
      <span
        className={cn(
          "flex size-16 items-center justify-center rounded-full",
          tel.callState === "active"
            ? "bg-emerald-100 text-emerald-700 ring-4 ring-emerald-500/15 dark:bg-emerald-950 dark:text-emerald-400"
            : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
          tel.callState === "held" && "ring-4 ring-amber-500/15",
        )}
      >
        {tel.callState === "held" ? (
          <Pause className="size-7" />
        ) : (
          <Phone className={cn("size-7", tel.callState !== "active" && "animate-pulse")} />
        )}
      </span>
      <div className="min-w-0 space-y-0.5">
        {call.clientId ? (
          <Link
            href={`/clients/${call.clientId}`}
            className="block truncate text-lg font-semibold hover:underline"
          >
            {title}
          </Link>
        ) : (
          <p className="truncate text-lg font-semibold">{title}</p>
        )}
        <p className="text-sm text-muted-foreground">
          {stateLabel}
          {call.clientName ? ` · ${formatPhone(call.remoteNumber)}` : ""}
        </p>
        <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums">
          {elapsed !== null ? formatTimer(elapsed) : "—"}
        </p>
      </div>
      <div className="w-full">
        <CallControlsSection tel={tel} />
      </div>
    </div>
  );
}

// ── 0b. Pastille flottante (desktop, panneau fermé pendant un appel) ────────

function DesktopCallPill({ onOpen }: { onOpen: () => void }) {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const call = tel.activeCall;
  const elapsed = useElapsedSeconds(call?.answeredAt?.getTime() ?? null);
  if (!call) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("panel.showCall")}
      className="fixed right-6 bottom-6 z-40 hidden h-12 items-center gap-2.5 rounded-full bg-emerald-600 px-4 text-white shadow-xl transition-colors hover:bg-emerald-700 md:flex"
    >
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70" />
        <span className="relative inline-flex size-2.5 rounded-full bg-white" />
      </span>
      <span className="max-w-40 truncate text-sm font-medium">
        {call.clientName || formatPhone(call.remoteNumber)}
      </span>
      <span className="font-mono text-sm tabular-nums">
        {elapsed !== null ? formatTimer(elapsed) : ""}
      </span>
    </button>
  );
}

// ── 1. FAB + clavier de composition ─────────────────────────────────────────

const REG_DOT: Record<string, string> = {
  registered: "bg-emerald-500",
  registering: "bg-amber-500",
  unregistered: "bg-amber-500",
  failed: "bg-red-500",
};

function DialFab({ onOpenPanel }: { onOpenPanel: () => void }) {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const [open, setOpen] = useState(false);

  if (tel.callState !== "idle" || tel.incomingCall) return null;

  const statusLabel = t(`status.${tel.registration}`);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              onClick={() => (isDesktopViewport() ? onOpenPanel() : setOpen(true))}
              aria-label={t("fab.open")}
              className={cn(
                "fixed right-4 z-40 size-14 rounded-full shadow-lg transition-all hover:scale-105 hover:shadow-xl active:scale-95 md:right-6 md:bottom-6",
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

      {/* Mobile : clavier en feuille basse (pouces d'abord) */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto w-full max-w-sm">
            <SheetHeader className="pb-0">
              <SheetTitle>{t("dialpad.title")}</SheetTitle>
            </SheetHeader>
            <div className="p-4">
              <DialpadContent onCalled={() => setOpen(false)} />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Clavier de composition — réutilisé par la feuille mobile et le panneau desktop. */
function DialpadContent({ onCalled }: { onCalled?: () => void }) {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const [number, setNumber] = useState("");

  const statusLabel = t(`status.${tel.registration}`);

  const placeCall = () => {
    const normalized = normalizePhone(number);
    if (!normalized) {
      toast.error(t("errors.invalid_number"));
      return;
    }
    tel.dial({ number: normalized });
    setNumber("");
    onCalled?.();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn("size-2 rounded-full", REG_DOT[tel.registration])} aria-hidden />
        {statusLabel}
        {tel.registration === "failed" ? (
          <Button variant="outline" size="xs" onClick={tel.retryRegistration} className="ml-1">
            <RotateCw data-icon="inline-start" />
            {t("status.retry")}
          </Button>
        ) : null}
        {/* Le casque se choisit AVANT de composer — c'est là qu'on y pense,
            pas une fois que ça sonne dans le mauvais haut-parleur. */}
        <AudioDevicePicker className="ml-auto size-9" />
      </div>

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
          className="h-12 text-center text-lg font-medium tracking-wide tabular-nums"
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
            className="h-14 flex-col gap-0.5 rounded-2xl text-xl font-semibold active:scale-95"
            onClick={() => setNumber((n) => n + key)}
          >
            <span className="leading-none">{key}</span>
            <span
              aria-hidden
              className="h-3 text-[10px] leading-none font-normal tracking-widest text-muted-foreground"
            >
              {DIAL_KEY_LETTERS[key] ?? ""}
            </span>
          </Button>
        ))}
      </div>

      <Button
        onClick={placeCall}
        disabled={tel.registration !== "registered" || !number.trim()}
        className="h-14 w-full bg-emerald-600 text-base text-white shadow-lg shadow-emerald-600/30 hover:bg-emerald-700"
      >
        <Phone data-icon="inline-start" className="size-5" />
        {t("dialpad.call")}
      </Button>
    </div>
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
        // Mobile seulement — sur desktop, l'appel vit dans le panneau de droite.
        "fixed inset-x-2 z-40 rounded-2xl border bg-background/95 p-3 shadow-xl backdrop-blur md:hidden",
        ABOVE_NAV,
      )}
    >
      <div className="flex items-center gap-3">
        <span className="relative flex size-2.5 shrink-0">
          <span
            className={cn(
              "absolute inline-flex h-full w-full rounded-full opacity-75",
              tel.callState === "active"
                ? "animate-ping bg-emerald-500"
                : tel.callState === "held"
                  ? "bg-amber-500"
                  : "animate-pulse bg-amber-500",
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

      <div className="mt-3">
        <CallControlsSection tel={tel} />
      </div>
    </div>
  );
}

/** Rangée de contrôles + clavier DTMF — partagée entre la barre mobile et le panneau desktop. */
function CallControlsSection({ tel }: { tel: TelephonyContextValue }) {
  const t = useTranslations("phone");
  const [dtmfOpen, setDtmfOpen] = useState(false);
  const [dtmfHistory, setDtmfHistory] = useState("");

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="secondary"
          className={cn(
            "size-11",
            tel.muted && "bg-destructive/15 text-destructive hover:bg-destructive/25",
          )}
          onClick={tel.toggleMute}
          aria-label={tel.muted ? t("call.unmute") : t("call.mute")}
          aria-pressed={tel.muted}
        >
          {tel.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </Button>
        <Button
          variant="secondary"
          className={cn(
            "size-11",
            tel.held &&
              "bg-amber-500/20 text-amber-700 hover:bg-amber-500/30 dark:text-amber-400",
          )}
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
        <AudioDevicePicker />
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
                className="h-11 rounded-xl text-base font-semibold active:scale-95"
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

/**
 * Sonnerie d'appel entrant. Le son lui-même vit dans `lib/telephony/tones` —
 * un contexte audio unique, créé au montage du téléphone et déverrouillé au
 * premier geste de l'usager. Fabriqué ici, à l'arrivée de l'appel, il naîtrait
 * suspendu : un appel entrant est un événement réseau, jamais un clic, et
 * Chrome refuse de faire du bruit sans geste préalable.
 *
 * `audible` dit si le son sort VRAIMENT. Quand il ne sort pas (onglet jamais
 * cliqué depuis le chargement), le popup propose de le débloquer plutôt que
 * de sonner dans le vide.
 */
function useRingtone(active: boolean): boolean {
  const audible = useSyncExternalStore(subscribeToneState, tonesAudible, () => true);
  useEffect(() => {
    if (!active) return;
    startRingtone();
    return () => stopRingtone();
  }, [active]);
  return audible;
}

function IncomingCallDialog() {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const incoming = tel.incomingCall;
  const audible = useRingtone(incoming !== null);

  return (
    <Dialog open={incoming !== null} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        {incoming ? (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div className="relative">
              <span
                aria-hidden
                className="absolute inset-0 animate-ping rounded-full bg-emerald-500/40"
              />
              <div className="relative flex size-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                <PhoneIncoming className="size-8" />
              </div>
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
                  {/* Le lookup NOMME l'appelant même quand la fiche n'est pas
                      ouverte à ce regard (décrocher passe avant), mais un lien
                      mènerait droit à un « introuvable », en pleine sonnerie et
                      avec le client en ligne. Le nom reste, le lien part. */}
                  {incoming.client.canOpen ? (
                    <Link
                      href={`/clients/${incoming.client.id}`}
                      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                      {t("incoming.viewClient")}
                      <ExternalLink className="size-3.5" />
                    </Link>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t("incoming.unknown")}</p>
              )}
            </DialogHeader>
            {audible ? null : (
              // Le navigateur refuse de faire du bruit tant que la page n'a
              // pas reçu de geste. Ce bouton EST le geste — et il déverrouille
              // la sonnerie pour tous les appels suivants de la session.
              <Button
                variant="outline"
                onClick={unlockTones}
                className="h-11 w-full border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400"
              >
                <Volume2 data-icon="inline-start" className="size-4" />
                {t("incoming.enableSound")}
              </Button>
            )}
            <div className="flex w-full gap-3">
              <Button
                onClick={tel.reject}
                className="h-14 flex-1 bg-red-600 text-base text-white shadow-lg shadow-red-600/25 hover:bg-red-700"
              >
                <PhoneOff data-icon="inline-start" className="size-5" />
                {t("incoming.decline")}
              </Button>
              <Button
                onClick={tel.answer}
                className="h-14 flex-1 bg-emerald-600 text-base text-white shadow-lg shadow-emerald-600/25 hover:bg-emerald-700"
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

/**
 * Statuts du pipeline pour les boutons d'après-appel — chargés une fois par
 * session d'onglet (une refonte du pipeline en cours de journée se voit au
 * prochain rechargement de la page, cas rarissime).
 */
let pipelineCategoriesCache: PipelineCategory[] | null = null;

async function fetchPipelineCategories(): Promise<PipelineCategory[] | null> {
  if (pipelineCategoriesCache) return pipelineCategoriesCache;
  try {
    const res = await fetch("/api/categories");
    if (!res.ok) return null;
    const data = (await res.json()) as { categories?: PipelineCategory[] };
    pipelineCategoriesCache = data.categories ?? null;
    return pipelineCategoriesCache;
  } catch {
    return null;
  }
}

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

  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [callbackChoice, setCallbackChoice] = useState<CallbackChoice>("in1h");
  const [customDate, setCustomDate] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pipelineCats, setPipelineCats] = useState<PipelineCategory[] | null>(
    pipelineCategoriesCache,
  );

  useEffect(() => {
    let active = true;
    void fetchPipelineCategories().then((cats) => {
      if (active && cats) setPipelineCats(cats);
    });
    return () => {
      active = false;
    };
  }, []);

  // Boutons = « Sans réponse » + les statuts du pipeline. Repli sur les 7
  // anciens boutons si la liste des statuts est injoignable : le popup ne
  // doit JAMAIS bloquer le classement d'un appel.
  const options: DispositionOption[] = useMemo(() => {
    if (pipelineCats) {
      return pipelineDispositionOptions(pipelineCats, locale, t("disposition.options.no_answer"));
    }
    return DISPOSITION_ORDER.map((d) => ({
      value: d,
      label: t(`disposition.options.${d}`),
      color: DISPOSITION_CONFIG[d].color,
      key: d,
    }));
  }, [pipelineCats, locale, t]);

  const selectedOption = options.find((o) => o.value === selected) ?? null;

  const dateLocale = locale === "en" ? enLocale : frLocale;
  const withClient = Boolean(pending.clientId);
  const showCallbackPicker = withClient && selectedOption?.key === "callback";
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
      if (!res.ok) {
        if (res.status === 400) {
          // Statut supprimé/renommé depuis le chargement de l'onglet : liste
          // périmée. On la recharge et on efface le choix — l'agent reclasse
          // aussitôt, sans recharger la page.
          pipelineCategoriesCache = null;
          const fresh = await fetchPipelineCategories();
          if (fresh) {
            setPipelineCats(fresh);
            setSelected(null);
          }
        }
        throw new Error("save_failed");
      }
      toast.success(t("disposition.saved"));
      tel.clearPendingDisposition();
      if (selectedOption?.key === "booked" && pending.clientId) {
        router.push(`/clients/${pending.clientId}?book=1`);
      }
    } catch {
      toast.error(t("errors.save_failed"));
      setSaving(false);
    }
  }, [
    pending,
    selected,
    selectedOption,
    saving,
    showCallbackPicker,
    followupDueAt,
    note,
    t,
    tel,
    router,
  ]);

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
          {options.map((o) => {
            const active = selected === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setSelected(o.value)}
                aria-pressed={active}
                className={cn(
                  "flex min-h-12 items-center gap-2.5 rounded-xl border-2 px-3 py-2 text-left text-sm font-semibold transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px",
                  active ? "shadow-md" : "hover:shadow-sm",
                )}
                style={
                  active
                    ? {
                        backgroundColor: o.color,
                        borderColor: o.color,
                        // Texte noir/blanc selon la luminosité — les statuts
                        // Notion peuvent être clairs (jaune, lime).
                        color: dispositionTextColor(o.color),
                      }
                    : { borderColor: `${o.color}66`, backgroundColor: `${o.color}14` }
                }
              >
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: active ? dispositionTextColor(o.color) : o.color }}
                />
                {o.label}
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
                  className="h-11 md:h-9"
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
                className="h-11 flex-1 md:h-10"
                onClick={() => setConfirmClose(false)}
              >
                {t("disposition.dismissCancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="h-11 flex-1 md:h-10"
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
