"use client";

/**
 * Contexte téléphonie partagé par toute l'app (module webphone).
 *
 * API exportée conservée à l'identique du stub de fondation :
 * TelephonyProvider, useTelephony, TelephonyContextValue, DialTarget —
 * d'autres modules (fiche client, tableau de bord) appellent dial().
 *
 * En plus : incomingCall (popup entrant), pendingDisposition (popup
 * d'après-appel) et retryRegistration — consommés par WebphoneDock.
 */

import { useLocale, useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { emitDataChange } from "@/lib/live";
import { formatPhone, normalizePhone } from "@/lib/phone";
import {
  getInputChoice,
  getOutputChoice,
  primeAudioDevices,
  setInputChoice,
  setOutputChoice,
} from "@/lib/telephony/audio-devices";
import { primeTones } from "@/lib/telephony/tones";
import type {
  ActiveCall,
  CallDirection,
  CallState,
  EngineConfig,
  RegistrationState,
  TelephonyEngine,
} from "@/lib/telephony/types";

export type DialTarget = {
  /** E.164 */
  number: string;
  clientId?: string;
  clientName?: string;
};

export type IncomingCallInfo = {
  number: string;
  client: {
    id: string;
    fullName: string;
    categoryName: string | null;
    categoryColor: string | null;
  } | null;
};

export type PendingDisposition = {
  callLogId: string;
  clientId?: string;
  clientName?: string;
  number: string;
  direction: CallDirection;
  durationSec: number;
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
  /** Appel entrant en attente de réponse (popup). */
  incomingCall: IncomingCallInfo | null;
  /** Appel terminé en attente de classement (popup disposition). */
  pendingDisposition: PendingDisposition | null;
  clearPendingDisposition: () => void;
  /** Relance l'inscription SIP après un échec (bouton « Réessayer »). */
  retryRegistration: () => void;
  /** Haut-parleur de sortie ; `""` = appareil par défaut du système. */
  setOutputDevice: (deviceId: string) => void;
  /** Microphone d'entrée ; `""` = défaut. Prend effet même en plein appel. */
  setInputDevice: (deviceId: string) => void;
};

type TelephonyConfigResponse = {
  provider: "voipms" | "twilio";
  ready: boolean;
  wssUrl?: string | null;
  sipDomain?: string | null;
  sipUsername?: string | null;
  sipPassword?: string | null;
  callerId?: string | null;
};

const KNOWN_ERRORS = new Set([
  "mic_denied",
  "mic_unavailable",
  "mic_timeout",
  "dial_timeout",
  "ice_failed",
  "not_registered",
  "already_in_call",
  "busy",
  "call_failed",
  "connect_failed",
  "not_configured",
]);

const TelephonyContext = createContext<TelephonyContextValue | null>(null);

async function createCallLog(body: {
  clientId?: string | null;
  direction: CallDirection;
  toNumber?: string | null;
  fromNumber?: string | null;
  startedAt: string;
  /** Posé dès le décroché : si le PATCH final se perd (onglet fermé en plein
   *  appel), la rangée reste classée « répondu » au lieu de « manqué ». */
  answeredAt?: string;
  /** Entrant jamais décroché : l'appel manqué se journalise en une requête. */
  endedAt?: string;
}): Promise<string | null> {
  try {
    const res = await fetch("/api/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
}

async function finalizeCallLog(
  id: string,
  patch: { answeredAt: string | null; endedAt: string; durationSec: number },
): Promise<void> {
  try {
    await fetch(`/api/calls/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {
    // le journal reste incomplet — la disposition pourra quand même être posée
  }
}

export function TelephonyProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("phone");
  const locale = useLocale();

  const [provider, setProvider] = useState<"voipms" | "twilio" | null>(null);
  const [ready, setReady] = useState(false);
  const [registration, setRegistration] = useState<RegistrationState>("unregistered");
  const [callState, setCallState] = useState<CallState>("idle");
  const [activeCall, setActiveCall] = useState<TelephonyContextValue["activeCall"]>(null);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);
  const [pendingDisposition, setPendingDisposition] = useState<PendingDisposition | null>(null);

  const engineRef = useRef<TelephonyEngine | null>(null);
  const configRef = useRef<TelephonyConfigResponse | null>(null);
  /** Métadonnées client du dernier appel composé/répondu. */
  const callMetaRef = useRef<{ clientId?: string; clientName?: string }>({});
  /** Id (promis) de la ligne de journal d'appel en cours. */
  const callLogIdRef = useRef<Promise<string | null> | null>(null);
  const incomingRef = useRef<IncomingCallInfo | null>(null);
  /**
   * Sonnerie en cours (numéro, fiche trouvée, début) — survit au refus et à la
   * fermeture du popup pour journaliser l'appel manqué et dater l'entrant au
   * DÉBUT de la sonnerie (le CDR voip.ms date l'appel là, pas au décroché).
   */
  const ringRef = useRef<{
    number: string;
    client: IncomingCallInfo["client"];
    startedAt: Date;
  } | null>(null);
  /** Jeton de sonnerie — invalide le lookup en vol dès que le ring est consommé. */
  const ringTokenRef = useRef(0);
  /** i18n accessible depuis les callbacks du moteur (mis à jour par effet). */
  const i18nRef = useRef<{ t: ReturnType<typeof useTranslations>; locale: string }>({ t, locale });
  useEffect(() => {
    i18nRef.current = { t, locale };
  }, [t, locale]);

  // ── Démarrage : config → moteur ────────────────────────────────────────────
  const bootRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;

    const showError = (code: string) => {
      const { t: tt } = i18nRef.current;
      if (code === "mic_prompt") {
        // Pas une erreur : l'invite micro du navigateur attend une réponse.
        toast.info(tt("errors.mic_prompt"));
        return;
      }
      toast.error(KNOWN_ERRORS.has(code) ? tt(`errors.${code}`) : tt("errors.call_failed"));
    };

    /** Recherche la fiche client d'un numéro entrant (module clients). */
    const lookupClient = async (number: string): Promise<IncomingCallInfo["client"]> => {
      try {
        const res = await fetch(`/api/clients/lookup?phone=${encodeURIComponent(number)}`);
        if (!res.ok) return null;
        const data: unknown = await res.json().catch(() => null);
        const rec = data as Record<string, unknown> | null;
        const raw = (rec?.client ?? rec) as Record<string, unknown> | null;
        if (!raw || typeof raw.id !== "string") return null;
        const category = raw.category as Record<string, unknown> | undefined;
        const nameFr = typeof category?.nameFr === "string" ? category.nameFr : null;
        const nameEn = typeof category?.nameEn === "string" ? category.nameEn : null;
        return {
          id: raw.id,
          fullName: typeof raw.fullName === "string" ? raw.fullName : "",
          categoryName:
            (i18nRef.current.locale === "en" ? (nameEn ?? nameFr) : (nameFr ?? nameEn)) ?? null,
          categoryColor: typeof category?.color === "string" ? category.color : null,
        };
      } catch {
        return null;
      }
    };

    /** Fin d'appel : complète le journal puis ouvre le popup de disposition. */
    const handleCallEnded = (endedCall: ActiveCall | null) => {
      const meta = callMetaRef.current;
      const logPromise = callLogIdRef.current;
      const ring = ringRef.current;
      callMetaRef.current = {};
      callLogIdRef.current = null;
      incomingRef.current = null;
      ringRef.current = null;
      setIncomingCall(null);
      setMuted(false);
      setHeld(false);

      if (!endedCall) return;

      const endedAt = new Date();

      if (!logPromise) {
        // Entrant jamais décroché (l'appelant a raccroché pendant la sonnerie,
        // ou refus) : journaliser l'appel manqué en une seule requête — le
        // serveur rattache la fiche client et crée la notification de suivi.
        if (endedCall.direction === "inbound" && !endedCall.answeredAt) {
          const number = normalizePhone(endedCall.remoteNumber) ?? endedCall.remoteNumber;
          const missedToast = () =>
            toast.info(
              i18nRef.current.t("missed.toast", {
                name: ring?.client?.fullName || formatPhone(number),
              }),
            );
          // Twilio : le rappel TwiML (attribut action du Dial) est l'UNIQUE
          // journaliseur des manqués — écrire aussi d'ici doublerait la rangée
          // et la notification (les deux écritures partent au même instant).
          if (configRef.current?.provider === "twilio") {
            missedToast();
            emitDataChange("calls");
            emitDataChange("notifications");
            return;
          }
          void createCallLog({
            clientId: ring?.client?.id ?? null,
            direction: "inbound",
            fromNumber: number,
            toNumber: configRef.current?.callerId ?? null,
            startedAt: (ring?.startedAt ?? endedCall.startedAt).toISOString(),
            endedAt: endedAt.toISOString(),
          }).then((id) => {
            if (!id) return;
            missedToast();
            emitDataChange("calls");
            emitDataChange("notifications");
          });
        }
        return;
      }
      const durationSec = endedCall.answeredAt
        ? Math.max(0, Math.round((endedAt.getTime() - endedCall.answeredAt.getTime()) / 1000))
        : 0;

      void logPromise.then(async (id) => {
        if (!id) {
          // POST /api/calls a échoué — pas de popup de disposition possible :
          // prévenir l'agent pour qu'il note le résultat sur la fiche client.
          if (endedCall.answeredAt) {
            toast.error(i18nRef.current.t("errors.log_failed"));
          }
          return;
        }
        await finalizeCallLog(id, {
          answeredAt: endedCall.answeredAt?.toISOString() ?? null,
          endedAt: endedAt.toISOString(),
          durationSec,
        });
        if (endedCall.direction === "inbound" && !endedCall.answeredAt) {
          // Décroché au moment même où l'appelant raccrochait : jamais
          // connecté. Pas de popup de disposition — c'est un appel manqué
          // (le PATCH ci-dessus vient de le classer ainsi, et le serveur
          // crée la notification de rappel).
          toast.info(
            i18nRef.current.t("missed.toast", {
              name: meta.clientName || formatPhone(normalizePhone(endedCall.remoteNumber) ?? ""),
            }),
          );
          emitDataChange("calls");
          emitDataChange("notifications");
          return;
        }
        setPendingDisposition({
          callLogId: id,
          clientId: meta.clientId,
          clientName: meta.clientName,
          number: endedCall.remoteNumber,
          direction: endedCall.direction,
          durationSec,
        });
      });
    };

    const boot = async () => {
      engineRef.current?.destroy();
      engineRef.current = null;

      // Avant tout appel : lister les appareils audio, suivre les branchements,
      // et surtout créer le contexte des tonalités MAINTENANT pour qu'un clic
      // quelconque dans le CRM le déverrouille. Une sonnerie fabriquée au
      // moment de l'appel entrant naîtrait muette (politique d'autoplay).
      primeAudioDevices();
      primeTones();

      // Toujours re-lue : un « Réessayer » après correction des identifiants
      // par l'admin doit repartir de la config à jour.
      let config: TelephonyConfigResponse;
      try {
        const res = await fetch("/api/telephony/config");
        if (!res.ok) {
          // Config illisible : marquer l'échec pour que « Réessayer » reste visible.
          if (!cancelled) setRegistration("failed");
          return;
        }
        config = (await res.json()) as TelephonyConfigResponse;
        configRef.current = config;
      } catch {
        if (!cancelled) setRegistration("failed");
        return;
      }
      if (cancelled) return;

      setProvider(config.provider);
      setReady(config.ready);
      if (!config.ready) return;

      // Import dynamique : le moteur inutilisé n'est jamais téléchargé.
      const engine: TelephonyEngine =
        config.provider === "twilio"
          ? new (await import("@/lib/telephony/engines/twilio-engine")).TwilioEngine()
          : new (await import("@/lib/telephony/engines/jssip-engine")).JsSipEngine();
      if (cancelled) {
        engine.destroy();
        return;
      }
      engineRef.current = engine;

      const engineConfig: EngineConfig = {
        wssUrl: config.wssUrl ?? undefined,
        sipUsername: config.sipUsername ?? undefined,
        sipPassword: config.sipPassword ?? undefined,
        sipDomain: config.sipDomain ?? undefined,
        callerId: config.callerId ?? undefined,
      };

      await engine.init(engineConfig, {
        onRegistrationChange: (state) => {
          if (!cancelled) setRegistration(state);
        },
        onCallStateChange: (state, call) => {
          if (cancelled) return;
          if (state === "ended") {
            setCallState("ended");
            handleCallEnded(call);
            return;
          }
          setCallState(state);
          if (state === "idle") {
            setActiveCall(null);
            setMuted(false);
            setHeld(false);
          } else if (call) {
            setActiveCall({ ...call, ...callMetaRef.current });
          }
          if (state === "held") setHeld(true);
          if (state === "active") setHeld(false);
        },
        onIncoming: (remoteNumber) => {
          if (cancelled) return;
          const number = normalizePhone(remoteNumber) ?? remoteNumber;
          const ringToken = ++ringTokenRef.current;
          const info: IncomingCallInfo = { number, client: null };
          incomingRef.current = info;
          ringRef.current = { number, client: null, startedAt: new Date() };
          setIncomingCall(info);
          void lookupClient(number).then((client) => {
            if (cancelled || ringTokenRef.current !== ringToken) return;
            // La fiche sert au journal d'appel manqué même après un refus.
            if (ringRef.current?.number === number) ringRef.current.client = client;
            // N'enrichit le popup que si CE ring sonne encore (ni décroché,
            // ni refusé, ni terminé) — sinon il rouvrirait par-dessus l'appel.
            if (incomingRef.current?.number !== number) return;
            const enriched = { number, client };
            incomingRef.current = enriched;
            setIncomingCall(enriched);
          });
        },
        onMissedWhileBusy: (remoteNumber) => {
          if (cancelled) return;
          // Second appel pendant qu'on est en ligne : refusé par le moteur sans
          // sonner à l'écran — journalisé tout de suite comme appel manqué.
          // Twilio : le rappel TwiML s'en charge (statut busy), ne pas doubler.
          const number = normalizePhone(remoteNumber) ?? remoteNumber;
          const now = new Date().toISOString();
          if (configRef.current?.provider !== "twilio") {
            void createCallLog({
              direction: "inbound",
              fromNumber: number,
              toNumber: configRef.current?.callerId ?? null,
              startedAt: now,
              endedAt: now,
            }).then((id) => {
              if (!id) return;
              emitDataChange("calls");
              emitDataChange("notifications");
            });
          }
          void lookupClient(number).then((client) => {
            if (cancelled) return;
            toast.info(
              i18nRef.current.t("missed.busyToast", {
                name: client?.fullName || formatPhone(number),
              }),
            );
          });
        },
        onError: (code) => {
          if (!cancelled) showError(code);
        },
      });

      // Le moteur vient de naître : lui redonner les appareils choisis. Twilio
      // reconstruit sa plomberie audio à chaque Device, et « Réessayer » passe
      // par ici — sans ça, le son retomberait dans les haut-parleurs.
      void engine.setOutputDevice(getOutputChoice());
      void engine.setInputDevice(getInputChoice());
    };

    bootRef.current = boot;
    void boot();

    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────

  const dial = useCallback(
    (target: DialTarget) => {
      const engine = engineRef.current;
      const config = configRef.current;
      if (!engine || !config?.ready) {
        toast.error(t("errors.not_configured"));
        return;
      }
      if (callLogIdRef.current || incomingRef.current) {
        toast.error(t("errors.already_in_call"));
        return;
      }
      const number = normalizePhone(target.number);
      if (!number) {
        toast.error(t("errors.invalid_number"));
        return;
      }

      callMetaRef.current = { clientId: target.clientId, clientName: target.clientName };
      const startedAt = new Date().toISOString();

      const chain: Promise<string | null> = engine
        .dial(number)
        .then(() =>
          createCallLog({
            clientId: target.clientId ?? null,
            direction: "outbound",
            toNumber: number,
            fromNumber: config.callerId ?? null,
            startedAt,
          }),
        )
        .catch(() => {
          // dial() a échoué (déjà signalé via onError) — pas de ligne de journal.
          // Ne nettoyer que si les refs appartiennent ENCORE à cet appel : un
          // échec tardif (micro refusé après 30 s) ne doit pas effacer le
          // journal de l'appel suivant, déjà en cours.
          if (callLogIdRef.current === chain) {
            callMetaRef.current = {};
            callLogIdRef.current = null;
          }
          return null;
        });
      callLogIdRef.current = chain;
    },
    [t],
  );

  const answer = useCallback(() => {
    const engine = engineRef.current;
    const incoming = incomingRef.current;
    if (!engine || !incoming) return;

    // Ring consommé : un lookupClient() encore en vol ne doit plus rouvrir
    // le popup entrant (les métadonnées utiles sont déjà copiées ci-dessous).
    ringTokenRef.current += 1;
    incomingRef.current = null;

    callMetaRef.current = {
      clientId: incoming.client?.id,
      clientName: incoming.client?.fullName,
    };
    callLogIdRef.current = createCallLog({
      clientId: incoming.client?.id ?? null,
      direction: "inbound",
      fromNumber: incoming.number,
      toNumber: configRef.current?.callerId ?? null,
      // Début de sonnerie, pas du décroché — aligné sur la date des CDR voip.ms.
      startedAt: (ringRef.current?.startedAt ?? new Date()).toISOString(),
      // Posé tout de suite : un PATCH final perdu ne laisse pas la rangée
      // classée « manqué » (le PATCH raffinera avec l'heure exacte du moteur).
      answeredAt: new Date().toISOString(),
    });
    setIncomingCall(null);
    engine.answer();
  }, []);

  const reject = useCallback(() => {
    engineRef.current?.reject();
    incomingRef.current = null;
    setIncomingCall(null);
  }, []);

  const hangup = useCallback(() => {
    engineRef.current?.hangup();
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      engineRef.current?.mute(!prev);
      return !prev;
    });
  }, []);

  const toggleHold = useCallback(() => {
    setHeld((prev) => {
      engineRef.current?.hold(!prev);
      return !prev;
    });
  }, []);

  const sendDTMF = useCallback((digit: string) => {
    engineRef.current?.sendDTMF(digit);
  }, []);

  const clearPendingDisposition = useCallback(() => {
    setPendingDisposition(null);
  }, []);

  const retryRegistration = useCallback(() => {
    setRegistration("registering");
    void bootRef.current();
  }, []);

  const setOutputDevice = useCallback((deviceId: string) => {
    // Le magasin persiste le choix ET re-route toutes les sorties déjà vivantes
    // (élément <audio>, tonalités) ; le moteur ne sert qu'à Twilio, qui a la
    // sienne.
    setOutputChoice(deviceId);
    void engineRef.current?.setOutputDevice(deviceId);
  }, []);

  const setInputDevice = useCallback((deviceId: string) => {
    setInputChoice(deviceId);
    void engineRef.current?.setInputDevice(deviceId);
  }, []);

  const value = useMemo<TelephonyContextValue>(
    () => ({
      provider,
      ready,
      registration,
      callState,
      activeCall,
      muted,
      held,
      dial,
      answer,
      hangup,
      reject,
      toggleMute,
      toggleHold,
      sendDTMF,
      incomingCall,
      pendingDisposition,
      clearPendingDisposition,
      retryRegistration,
      setOutputDevice,
      setInputDevice,
    }),
    [
      provider,
      ready,
      registration,
      callState,
      activeCall,
      muted,
      held,
      dial,
      answer,
      hangup,
      reject,
      toggleMute,
      toggleHold,
      sendDTMF,
      incomingCall,
      pendingDisposition,
      clearPendingDisposition,
      retryRegistration,
      setOutputDevice,
      setInputDevice,
    ],
  );

  return <TelephonyContext.Provider value={value}>{children}</TelephonyContext.Provider>;
}

export function useTelephony(): TelephonyContextValue {
  const ctx = useContext(TelephonyContext);
  if (!ctx) throw new Error("useTelephony must be used within TelephonyProvider");
  return ctx;
}
