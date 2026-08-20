/**
 * SMS engine contracts — framework-agnostic (mission-brief rule: this module
 * must lift into another repo unchanged). No Next.js imports, no database
 * client, no env reads: everything arrives injected through these interfaces.
 */

export type SmsMode = "live" | "sandbox" | "dry_run";

export type SmsEncoding = "GSM-7" | "UCS-2";

export interface SendInput {
  /** E.164 destination. */
  to: string;
  body: string;
  conversationId: string;
  /**
   * Caller-supplied idempotency key. The provider itself is stateless; the
   * queue layer (phase 2) guarantees at-most-once by deduplicating on this key
   * before invoking send(). It is still threaded through for logging/tracing.
   */
  idempotencyKey: string;
}

export interface SendResult {
  /** Twilio Message SID — absent in dry_run and for blocked sandbox sends. */
  sid?: string;
  segments: number;
  encoding: SmsEncoding;
  mode: SmsMode;
  /** false when the send was intentionally not performed (suppressed, gated, off-allowlist). */
  sent: boolean;
  /** Reason when sent === false: suppressed | kill_switch | sandbox_not_allowlisted | dry_run */
  skippedReason?: string;
}

export interface SmsProvider {
  send(input: SendInput): Promise<SendResult>;
}

// ── Injected ports ───────────────────────────────────────────────────────────

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface SuppressionStore {
  isSuppressed(phoneE164: string): Promise<boolean>;
  suppress(entry: { phoneE164: string; reason: string; note?: string }): Promise<void>;
}

/** Global send gate — backed by the kill-switch setting. false = nothing sends. */
export interface SendGate {
  isSendingAllowed(): Promise<boolean>;
}

/** Low-level transport that actually reaches Twilio. Injected so tests spy on it. */
export interface SmsTransport {
  (input: { to: string; body: string; idempotencyKey: string }): Promise<{ sid: string }>;
}

export const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export const systemClock: Clock = { now: () => new Date() };
