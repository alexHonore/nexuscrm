"use client";

/**
 * Contexte téléphonie partagé par toute l'app.
 *
 * NOTE MODULE WEBPHONE : ce fichier est un stub de fondation. Le module
 * webphone le remplace ENTIÈREMENT en gardant exactement la même API exportée
 * (TelephonyProvider, useTelephony, TelephonyContextValue, DialTarget) —
 * d'autres modules (fiche client, tableau de bord) appellent déjà dial().
 */

import { createContext, useContext, useMemo } from "react";
import { toast } from "sonner";
import type { ActiveCall, CallState, RegistrationState } from "@/lib/telephony/types";

export type DialTarget = {
  /** E.164 */
  number: string;
  clientId?: string;
  clientName?: string;
};

export type TelephonyContextValue = {
  provider: "voipms" | "twilio" | null;
  /** false tant que l'utilisateur n'a pas de ligne configurée par l'admin */
  ready: boolean;
  registration: RegistrationState;
  callState: CallState;
  activeCall: (ActiveCall & { clientId?: string; clientName?: string }) | null;
  muted: boolean;
  held: boolean;
  dial: (target: DialTarget) => void;
  answer: () => void;
  hangup: () => void;
  reject: () => void;
  toggleMute: () => void;
  toggleHold: () => void;
  sendDTMF: (digit: string) => void;
};

const TelephonyContext = createContext<TelephonyContextValue | null>(null);

export function TelephonyProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<TelephonyContextValue>(
    () => ({
      provider: null,
      ready: false,
      registration: "unregistered",
      callState: "idle",
      activeCall: null,
      muted: false,
      held: false,
      dial: () => toast.error("Téléphone non configuré — contactez l'administrateur."),
      answer: () => {},
      hangup: () => {},
      reject: () => {},
      toggleMute: () => {},
      toggleHold: () => {},
      sendDTMF: () => {},
    }),
    [],
  );

  return <TelephonyContext.Provider value={value}>{children}</TelephonyContext.Provider>;
}

export function useTelephony(): TelephonyContextValue {
  const ctx = useContext(TelephonyContext);
  if (!ctx) throw new Error("useTelephony must be used within TelephonyProvider");
  return ctx;
}
