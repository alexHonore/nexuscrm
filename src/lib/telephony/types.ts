/**
 * Abstraction fournisseur de téléphonie — côté navigateur.
 * Implémentations : JsSipEngine (voip.ms via passerelle WSS) et TwilioEngine.
 * L'admin bascule le fournisseur dans Réglages → Téléphonie.
 */

export type CallState =
  | "idle"
  | "connecting" // sortant : invitation envoyée
  | "ringing" // sortant : sonnerie distante / entrant : ça sonne ici
  | "active"
  | "held"
  | "ended";

export type CallDirection = "outbound" | "inbound";

export interface ActiveCall {
  direction: CallDirection;
  /** Numéro distant en E.164 si possible */
  remoteNumber: string;
  startedAt: Date;
  answeredAt?: Date;
}

export type RegistrationState = "unregistered" | "registering" | "registered" | "failed";

export interface TelephonyEvents {
  onRegistrationChange: (state: RegistrationState, error?: string) => void;
  onCallStateChange: (state: CallState, call: ActiveCall | null) => void;
  /** Appel entrant — l'UI affiche le popup avec la fiche client correspondante. */
  onIncoming: (remoteNumber: string) => void;
  onError: (message: string) => void;
}

export interface EngineConfig {
  /** voip.ms : wss://... de la passerelle. Twilio : ignoré. */
  wssUrl?: string;
  /** voip.ms : identifiants SIP du sous-compte de l'utilisateur. */
  sipUsername?: string;
  sipPassword?: string;
  /** voip.ms : domaine SIP (défaut sip.voip.ms) */
  sipDomain?: string;
  /** Twilio : jeton d'accès récupéré via /api/telephony/twilio-token */
  twilioToken?: string;
  /** Caller ID (DID de l'utilisateur) */
  callerId?: string;
}

export interface TelephonyEngine {
  readonly provider: "voipms" | "twilio";
  init(config: EngineConfig, events: TelephonyEvents): Promise<void>;
  /** Compose un numéro E.164. */
  dial(number: string): Promise<void>;
  answer(): void;
  hangup(): void;
  reject(): void;
  mute(muted: boolean): void;
  hold(held: boolean): void;
  sendDTMF(digit: string): void;
  destroy(): void;
}
