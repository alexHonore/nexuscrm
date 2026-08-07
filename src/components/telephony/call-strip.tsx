"use client";

import { Mic, MicOff, Pause, PhoneOff, Play } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { useTelephony } from "@/components/telephony/telephony-context";

function formatTimer(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Bandeau d'appel compact — affiché en tête du panneau de réservation (et
 * réutilisable ailleurs) pour garder sourdine / attente / raccrocher à portée
 * de main pendant qu'on remplit le formulaire. Ne rend rien hors appel.
 */
export function CallStrip({ className }: { className?: string }) {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const call = tel.activeCall;

  const answeredAtMs = call?.answeredAt?.getTime() ?? null;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (answeredAtMs === null) return;
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - answeredAtMs) / 1000)));
    update();
    const idInterval = setInterval(update, 1_000);
    return () => clearInterval(idInterval);
  }, [answeredAtMs]);

  const inCall =
    call !== null &&
    (tel.callState === "connecting" ||
      tel.callState === "ringing" ||
      tel.callState === "active" ||
      tel.callState === "held");
  if (!inCall || !call) return null;

  const title = call.clientName || formatPhone(call.remoteNumber) || t("call.unknownNumber");

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2",
        className,
      )}
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          tel.callState === "active" ? "animate-pulse bg-emerald-500" : "bg-amber-500",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        {call.clientId ? (
          <Link
            href={`/clients/${call.clientId}`}
            className="block truncate text-sm font-medium hover:underline"
          >
            {title}
          </Link>
        ) : (
          <p className="truncate text-sm font-medium">{title}</p>
        )}
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {answeredAtMs !== null
            ? formatTimer(elapsed)
            : t(tel.callState === "ringing" ? "call.ringing" : "call.connecting")}
        </p>
      </div>
      <Button
        variant={tel.muted ? "default" : "secondary"}
        className="size-11"
        onClick={tel.toggleMute}
        aria-label={tel.muted ? t("call.unmute") : t("call.mute")}
        aria-pressed={tel.muted}
      >
        {tel.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </Button>
      <Button
        variant={tel.held ? "default" : "secondary"}
        className="size-11"
        onClick={tel.toggleHold}
        aria-label={tel.held ? t("call.resume") : t("call.hold")}
        aria-pressed={tel.held}
      >
        {tel.held ? <Play className="size-4" /> : <Pause className="size-4" />}
      </Button>
      <Button
        className="size-11 bg-red-600 text-white hover:bg-red-700"
        onClick={tel.hangup}
        aria-label={t("call.hangup")}
      >
        <PhoneOff className="size-4" />
      </Button>
    </div>
  );
}
