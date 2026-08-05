"use client";

/**
 * Moteur Twilio — @twilio/voice-sdk (Programmable Voice JS).
 *
 * Activé quand l'admin bascule le fournisseur sur Twilio (Réglages → Téléphonie)
 * ET que les variables TWILIO_* sont définies. Le jeton d'accès vient de
 * POST /api/telephony/twilio-token ; le routage des appels passe par la TwiML App
 * pointée sur /api/telephony/twiml. Même surface TelephonyEngine que JsSIP.
 */

import { Call, Device } from "@twilio/voice-sdk";
import type {
  ActiveCall,
  EngineConfig,
  RegistrationState,
  TelephonyEngine,
  TelephonyEvents,
} from "@/lib/telephony/types";

async function fetchToken(): Promise<string> {
  const res = await fetch("/api/telephony/twilio-token", { method: "POST" });
  if (!res.ok) throw new Error("twilio_token_failed");
  const data = (await res.json()) as { token: string };
  return data.token;
}

export class TwilioEngine implements TelephonyEngine {
  readonly provider = "twilio" as const;

  private device: Device | null = null;
  private call: Call | null = null;
  private active: ActiveCall | null = null;
  private events: TelephonyEvents | null = null;
  private config: EngineConfig = {};
  private registration: RegistrationState = "unregistered";
  private destroyed = false;

  get registrationState(): RegistrationState {
    return this.registration;
  }

  async init(config: EngineConfig, events: TelephonyEvents): Promise<void> {
    this.config = config;
    this.events = events;
    this.setRegistration("registering");

    try {
      const token = config.twilioToken ?? (await fetchToken());
      this.device = new Device(token, {
        logLevel: "error",
        // Opus d'abord pour la qualité, PCMU en secours.
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      });

      this.device.on("registered", () => this.setRegistration("registered"));
      this.device.on("registering", () => this.setRegistration("registering"));
      this.device.on("unregistered", () => {
        if (!this.destroyed) this.setRegistration("unregistered");
      });
      this.device.on("error", (error: { code?: number; message?: string }) => {
        // Le SDK Twilio gère lui-même la re-connexion ; on remonte l'état.
        this.setRegistration("failed", error?.message);
        this.events?.onError("connect_failed");
      });
      this.device.on("tokenWillExpire", () => {
        void fetchToken()
          .then((fresh) => this.device?.updateToken(fresh))
          .catch(() => this.events?.onError("connect_failed"));
      });
      this.device.on("incoming", (call: Call) => this.handleIncoming(call));

      await this.device.register();
    } catch (err) {
      this.setRegistration("failed", err instanceof Error ? err.message : String(err));
    }
  }

  async dial(number: string): Promise<void> {
    if (!this.device || this.registration !== "registered") {
      this.events?.onError("not_registered");
      throw new Error("not_registered");
    }
    if (this.call) {
      this.events?.onError("already_in_call");
      throw new Error("already_in_call");
    }

    this.active = { direction: "outbound", remoteNumber: number, startedAt: new Date() };
    // Les params sont relayés à /api/telephony/twiml (To + CallerId = DID de l'utilisateur).
    const call = await this.device.connect({
      params: { To: number, CallerId: this.config.callerId ?? "" },
    });
    this.attachCall(call);
    this.events?.onCallStateChange("connecting", this.active);
  }

  answer(): void {
    if (this.call && this.active?.direction === "inbound") this.call.accept();
  }

  hangup(): void {
    this.call?.disconnect();
  }

  reject(): void {
    if (!this.call) return;
    if (this.active?.direction === "inbound" && this.call.status() === Call.State.Pending) {
      this.call.reject();
    } else {
      this.call.disconnect();
    }
  }

  mute(muted: boolean): void {
    this.call?.mute(muted);
  }

  hold(held: boolean): void {
    // Le SDK Voice JS n'offre pas de vraie mise en attente (il faudrait une
    // conférence TwiML). Repli honnête : couper le micro et signaler l'état.
    this.call?.mute(held);
    if (this.active) {
      this.events?.onCallStateChange(held ? "held" : "active", this.active);
    }
  }

  sendDTMF(digit: string): void {
    if (/^[\d#*]$/.test(digit)) this.call?.sendDigits(digit);
  }

  destroy(): void {
    this.destroyed = true;
    try {
      this.call?.disconnect();
    } catch {
      // rien
    }
    this.call = null;
    this.active = null;
    try {
      this.device?.destroy();
    } catch {
      // rien
    }
    this.device = null;
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  private handleIncoming(call: Call): void {
    if (this.call) {
      call.reject(); // déjà en ligne
      return;
    }
    const remoteNumber = call.parameters.From ?? "";
    this.active = { direction: "inbound", remoteNumber, startedAt: new Date() };
    this.attachCall(call);
    this.events?.onIncoming(remoteNumber);
    this.events?.onCallStateChange("ringing", this.active);
  }

  private attachCall(call: Call): void {
    this.call = call;

    call.on("ringing", () => {
      if (this.active?.direction === "outbound") {
        this.events?.onCallStateChange("ringing", this.active);
      }
    });

    call.on("accept", () => {
      if (!this.active) return;
      this.active = { ...this.active, answeredAt: this.active.answeredAt ?? new Date() };
      this.events?.onCallStateChange("active", this.active);
    });

    const onEnd = () => {
      const ended = this.active;
      this.call = null;
      this.active = null;
      this.events?.onCallStateChange("ended", ended);
      this.events?.onCallStateChange("idle", null);
    };
    call.on("disconnect", onEnd);
    call.on("cancel", onEnd);
    call.on("reject", onEnd);
    call.on("error", () => {
      this.events?.onError("call_failed");
      onEnd();
    });
  }

  private setRegistration(state: RegistrationState, error?: string): void {
    this.registration = state;
    this.events?.onRegistrationChange(state, error);
  }
}
