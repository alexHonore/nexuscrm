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
import { getInputChoice, getOutputChoice, refreshDevices } from "@/lib/telephony/audio-devices";
import { speechConstraints } from "@/lib/telephony/microphone";
import { qualityLevel, type CallQuality } from "@/lib/telephony/call-quality";
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
  private registration: RegistrationState = "unregistered";
  /** Sourdine voulue par l'utilisateur — restaurée à la reprise d'attente. */
  private userMuted = false;
  private destroyed = false;
  private dialGeneration = 0;
  private userHeld = false;
  private inputChange = Promise.resolve();
  private answering = false;
  private outputChange = Promise.resolve();

  get registrationState(): RegistrationState {
    return this.registration;
  }

  async init(config: EngineConfig, events: TelephonyEvents): Promise<void> {
    this.events = events;
    this.setRegistration("registering");

    try {
      const token = config.twilioToken ?? (await fetchToken());
      if (this.destroyed) return;
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
        if (this.destroyed) return;
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

      // `device.audio` naît avec le Device et repart sur la sortie par défaut :
      // sans cette relecture, un « Réessayer » (qui reconstruit le moteur)
      // ramènerait le son dans les haut-parleurs du portable en silence.
      await this.applyStoredDevices();
      if (this.destroyed) return;
      await this.device.register();
      void refreshDevices();
    } catch (err) {
      this.setRegistration("failed", err instanceof Error ? err.message : String(err));
    }
  }

  async dial(number: string): Promise<void> {
    if (!this.device || this.registration !== "registered") {
      this.events?.onError("not_registered");
      throw new Error("not_registered");
    }
    if (this.call || this.active) {
      this.events?.onError("already_in_call");
      throw new Error("already_in_call");
    }

    const generation = ++this.dialGeneration;
    const device = this.device;
    this.active = { direction: "outbound", remoteNumber: number, startedAt: new Date() };
    this.events?.onCallStateChange("connecting", this.active);
    // Seul `To` est relayé à /api/telephony/twiml : le DID présenté est relu
    // côté serveur d'après l'identité du jeton, jamais envoyé d'ici — un
    // paramètre du navigateur dirait le numéro qu'on VEUT, pas celui qu'on A.
    try {
      await this.prepareInput();
      if (this.destroyed || generation !== this.dialGeneration) throw new Error("canceled");
      const call = await device.connect({ params: { To: number }, rtcConstraints: speechConstraints() });
      if (this.destroyed || generation !== this.dialGeneration) {
        call.disconnect();
        throw new Error("canceled");
      }
      this.attachCall(call);
    } catch (error) {
      if (!this.destroyed && generation === this.dialGeneration) {
        this.events?.onError("call_failed");
        this.endCall();
      }
      throw error;
    }
  }

  answer(): void {
    const call = this.call;
    if (!call || this.answering || this.active?.direction !== "inbound" || call.status() !== Call.State.Pending) return;
    this.answering = true;
    this.events?.onCallStateChange("connecting", this.active);
    void this.prepareInput().then(() => {
      if (!this.destroyed && this.call === call && call.status() === Call.State.Pending) {
        call.accept({ rtcConstraints: speechConstraints() });
      }
    }).catch(() => {
      if (this.call === call) {
        this.events?.onError("mic_unavailable");
        call.reject();
      }
    });
  }

  hangup(): void {
    this.dialGeneration++;
    if (this.call) this.reject();
    else if (this.active) {
      this.device?.disconnectAll();
      this.endCall();
    }
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
    this.userMuted = muted;
    this.call?.mute(muted || this.userHeld);
  }

  hold(held: boolean): void {
    if (!this.call || !this.active?.answeredAt) return;
    this.userHeld = held;
    // Le SDK Voice JS n'offre pas de vraie mise en attente (il faudrait une
    // conférence TwiML). Repli honnête : couper le micro et signaler l'état.
    // La reprise restaure la sourdine voulue par l'utilisateur.
    this.call?.mute(held || this.userMuted);
    if (this.active) {
      this.events?.onCallStateChange(held ? "held" : "active", this.active);
    }
  }

  sendDTMF(digit: string): void {
    if (/^[\d#*]$/.test(digit)) this.call?.sendDigits(digit);
  }

  /**
   * Le SDK Twilio a sa PROPRE sortie et sa PROPRE sonnerie : un `setSinkId` sur
   * un élément <audio> ne l'atteint pas. Les deux suivent le même appareil,
   * sinon l'appel part au casque et la sonnerie reste dans le portable.
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    const audio = this.device?.audio;
    if (!audio?.isOutputSelectionSupported) return; // Safari / Firefox
    const id = deviceId || "default";
    const change = this.outputChange.catch(() => {}).then(async () => {
      if (this.destroyed) return;
      for (const devices of [audio.speakerDevices, audio.ringtoneDevices]) {
        try { await devices.set(id); }
        catch { if (deviceId) await devices.set("default").catch(() => {}); }
      }
    });
    this.outputChange = change;
    return change;
  }

  async setInputDevice(deviceId: string): Promise<void> {
    if (!this.call && !this.active) return; // do not hold the microphone between calls
    const audio = this.device?.audio;
    if (!audio) return;
    const device = this.device;
    const active = this.active;
    const change = this.inputChange.catch(() => {}).then(async () => {
      if (this.destroyed || this.device !== device || this.active !== active) return;
      try {
        // unsetInputDevice is forbidden during a live Twilio connection.
        await audio.setInputDevice(deviceId || "default");
      } catch (error) {
        if (this.destroyed || this.active !== active) return;
        const name = (error as { name?: string })?.name;
        if (deviceId && (name === "NotFoundError" || name === "OverconstrainedError")) {
          try {
            await audio.setInputDevice("default");
            if (this.active === active) this.events?.onError("mic_fallback");
          } catch { this.events?.onError("mic_unavailable"); }
        } else {
          this.events?.onError(name === "NotAllowedError" ? "mic_denied" : "mic_unavailable");
        }
      }
      if (this.destroyed || !this.active) await audio.unsetInputDevice().catch(() => {});
    });
    this.inputChange = change;
    return change;
  }

  private async applyStoredDevices(): Promise<void> {
    await this.setOutputDevice(getOutputChoice());
    await this.device?.audio?.setAudioConstraints(speechConstraints().audio as MediaTrackConstraints);
  }

  private async prepareInput(): Promise<void> {
    const active = this.active;
    await this.inputChange.catch(() => {});
    if (!this.destroyed && this.active === active) {
      // A previous call may have selected a device. Explicitly apply default
      // too, otherwise that old selection can leak into the next call.
      await this.setInputDevice(getInputChoice());
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.dialGeneration++;
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
    if (this.destroyed || this.call || this.active) {
      call.reject(); // déjà en ligne
      this.events?.onMissedWhileBusy?.(call.parameters.From ?? "");
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
    call.mute(this.userMuted || this.userHeld);

    call.on("ringing", () => {
      if (this.call === call && this.active?.direction === "outbound") {
        this.events?.onCallStateChange("ringing", this.active);
      }
    });

    call.on("accept", () => {
      if (this.call !== call || !this.active) return;
      this.active = { ...this.active, answeredAt: this.active.answeredAt ?? new Date() };
      this.events?.onCallStateChange("active", this.active);
    });

    const onEnd = () => {
      if (this.call === call) this.endCall();
    };
    call.on("disconnect", onEnd);
    call.on("cancel", onEnd);
    call.on("reject", onEnd);
    call.on("error", () => {
      if (this.call !== call) return;
      this.events?.onError("call_failed");
      onEnd();
    });
    call.on("sample", (s: Call.CallMetrics) => {
      if (this.call !== call || !this.active?.answeredAt) return;
      const track = call.getLocalStream()?.getAudioTracks()[0];
      const settings = track?.getSettings();
      const measured = (v: number) => Number.isFinite(v) && v >= 0 ? v : null;
      const total = s.packetsReceived + Math.max(0, s.packetsLost);
      const sample: CallQuality = {
        at: Date.now(), level: "unknown", connection: "connected", codec: s.codecName ?? null,
        // SDK samples report received RTP only. Never label this as uplink loss.
        outbound: { lossPercent: null, jitterMs: null },
        inbound: { lossPercent: total > 0 ? 100 * Math.max(0, s.packetsLost) / total : null, jitterMs: measured(s.jitter) },
        roundTripMs: measured(s.rtt),
        microphone: {
          name: track?.label || null,
          state: !track ? "unknown" : track.readyState === "ended" || track.muted ? "interrupted" : !track.enabled ? "muted" : "live",
          level: null,
          echoCancellation: settings?.echoCancellation ?? null,
          noiseSuppression: settings?.noiseSuppression ?? null,
          autoGainControl: settings?.autoGainControl ?? null,
        },
      };
      sample.level = qualityLevel(sample);
      this.events?.onQuality?.(sample);
    });
  }

  private endCall(): void {
    const ended = this.active;
    this.call = null;
    this.active = null;
    this.userMuted = false;
    this.userHeld = false;
    this.answering = false;
    const audio = this.device?.audio;
    // Serialize cleanup before the next call's microphone selection.
    this.inputChange = this.inputChange.catch(() => {}).then(async () => {
      if (!this.active) await audio?.unsetInputDevice().catch(() => {});
    });
    this.events?.onCallStateChange("ended", ended);
    this.events?.onCallStateChange("idle", null);
  }

  private setRegistration(state: RegistrationState, error?: string): void {
    if (this.destroyed) return;
    this.registration = state;
    this.events?.onRegistrationChange(state, error);
  }
}
