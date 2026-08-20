import { addMonths, addYears } from "date-fns";

/**
 * Consent-ledger validity windows (framework-agnostic — shared by the settings
 * schema, the lead-webhook seeding, and the admin UI).
 *
 * "6m" matches CASL's implied-consent-from-inquiry window and is the default.
 * Longer windows are the operator's choice — appropriate when express consent
 * is collected. Changing the setting only affects consents recorded AFTER the
 * change: the ledger is append-only, existing rows keep their stamped expiry.
 */
export const CONSENT_VALIDITIES = ["6m", "1y", "2y", "3y", "unlimited"] as const;
export type ConsentValidity = (typeof CONSENT_VALIDITIES)[number];

export const DEFAULT_CONSENT_VALIDITY: ConsentValidity = "6m";

/** Expiry timestamp for a consent granted at `grantedAt` — null = never expires. */
export function consentExpiresAt(validity: ConsentValidity, grantedAt: Date): Date | null {
  switch (validity) {
    case "6m":
      return addMonths(grantedAt, 6);
    case "1y":
      return addYears(grantedAt, 1);
    case "2y":
      return addYears(grantedAt, 2);
    case "3y":
      return addYears(grantedAt, 3);
    case "unlimited":
      return null;
  }
}
