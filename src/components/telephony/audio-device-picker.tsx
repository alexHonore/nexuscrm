"use client";

/**
 * Choix du haut-parleur et du microphone, depuis le téléphone lui-même.
 *
 * Il remplace un bouton qui ne faisait rien : une icône de volume dont
 * l'infobulle disait « réglez le volume avec les contrôles de votre appareil ».
 * Or le problème du téléphoniste n'est pas le volume, c'est la DESTINATION —
 * son casque est branché, l'appel sonne dans les haut-parleurs du portable, et
 * il conclut que « ça n'a pas sonné ».
 *
 * Trois précautions qui décident du rendu :
 *  - `setSinkId` n'existe que sur Chrome et Edge. Ailleurs, on ne montre pas un
 *    sélecteur qui ne changerait rien : la liste des micros suffit, et s'il n'y
 *    a rien à choisir du tout, le bouton disparaît complètement.
 *  - Sans autorisation du micro, `enumerateDevices()` renvoie bien les
 *    appareils mais SANS libellé. « Périphérique 2 » n'aide personne : on
 *    propose alors de demander l'autorisation, ce qui débloque les noms.
 *  - Un appareil peut disparaître entre le choix et l'appel. On le SIGNALE
 *    sans effacer le choix — rebrancher le casque doit suffire à le retrouver.
 */

import { CheckIcon, HeadphonesIcon, MicIcon, Volume2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useTelephony } from "@/components/telephony/telephony-context";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  choiceMissing,
  getServerSnapshot,
  getSnapshot,
  refreshDevices,
  subscribe,
  supportsOutputSelection,
} from "@/lib/telephony/audio-devices";
import { cn } from "@/lib/utils";

export function AudioDevicePicker({ className }: { className?: string }) {
  const t = useTranslations("phone");
  const tel = useTelephony();
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);

  const outputs = snap.devices.filter((d) => d.kind === "audiooutput");
  const inputs = snap.devices.filter((d) => d.kind === "audioinput");
  const canPickOutput = supportsOutputSelection();

  /**
   * L'autorisation du micro est ce qui débloque les LIBELLÉS. On ouvre et on
   * ferme le flux aussitôt : on ne veut pas le micro, on veut les noms.
   */
  const askForLabels = useCallback(async () => {
    setAsking(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      await refreshDevices();
    } catch {
      // Refusé : la liste reste anonyme, le choix reste possible.
    } finally {
      setAsking(false);
    }
  }, []);

  // Rien à proposer nulle part (navigateur sans sélection de sortie ET sans
  // micro listé) : pas de bouton mort — on ne rend rien.
  if (!canPickOutput && inputs.length === 0) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refreshDevices();
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="secondary" className={cn("size-11", className)} aria-label={t("audio.title")} />
        }
      >
        <Volume2Icon className="size-5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[60dvh] w-76 overflow-y-auto">
        <PopoverTitle>{t("audio.title")}</PopoverTitle>

        {canPickOutput ? (
          <DeviceGroup
            icon={<HeadphonesIcon aria-hidden className="size-4" />}
            label={t("audio.output")}
            devices={outputs}
            value={snap.output}
            missing={choiceMissing("audiooutput", snap.output)}
            onPick={tel.setOutputDevice}
            defaultLabel={t("audio.systemDefault")}
            missingLabel={t("audio.missing")}
            anonymousLabel={t("audio.anonymous")}
          />
        ) : (
          <p className="text-xs text-muted-foreground">{t("audio.outputUnsupported")}</p>
        )}

        {inputs.length > 0 ? (
          <DeviceGroup
            icon={<MicIcon aria-hidden className="size-4" />}
            label={t("audio.input")}
            devices={inputs}
            value={snap.input}
            missing={choiceMissing("audioinput", snap.input)}
            onPick={tel.setInputDevice}
            defaultLabel={t("audio.systemDefault")}
            missingLabel={t("audio.missing")}
            anonymousLabel={t("audio.anonymous")}
          />
        ) : null}

        {snap.labelled ? null : (
          <Button
            variant="outline"
            className="h-11 w-full"
            disabled={asking}
            onClick={() => void askForLabels()}
          >
            {t("audio.reveal")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DeviceGroup({
  icon,
  label,
  devices,
  value,
  missing,
  onPick,
  defaultLabel,
  missingLabel,
  anonymousLabel,
}: {
  icon: React.ReactNode;
  label: string;
  devices: MediaDeviceInfo[];
  /** `""` = défaut du système. */
  value: string;
  missing: boolean;
  onPick: (deviceId: string) => void;
  defaultLabel: string;
  missingLabel: string;
  anonymousLabel: string;
}) {
  // Chrome liste un « default » synthétique en plus de l'appareil réel : il
  // ferait doublon avec notre propre entrée « appareil par défaut ».
  const real = devices.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");

  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </p>
      <ul className="space-y-0.5">
        <DeviceRow
          label={defaultLabel}
          selected={value === ""}
          onPick={() => onPick("")}
        />
        {real.map((d, i) => (
          <DeviceRow
            key={d.deviceId}
            label={d.label || `${anonymousLabel} ${i + 1}`}
            selected={value === d.deviceId}
            onPick={() => onPick(d.deviceId)}
          />
        ))}
      </ul>
      {missing ? <p className="px-1 text-xs text-destructive">{missingLabel}</p> : null}
    </div>
  );
}

function DeviceRow({
  label,
  selected,
  onPick,
}: {
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <Button
        variant="ghost"
        aria-pressed={selected}
        onClick={onPick}
        className={cn(
          "h-11 w-full justify-start gap-2 px-2 text-left font-normal",
          selected && "bg-muted font-medium",
        )}
      >
        <CheckIcon
          aria-hidden
          className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
        />
        <span className="truncate">{label}</span>
      </Button>
    </li>
  );
}
