/**
 * Provenances d'un consentement SMS enregistré à la main — module PUR, partagé
 * entre l'action serveur et le composant qui propose le choix.
 */
export const CONSENT_SOURCES = ["phone_call", "in_person", "form", "email", "other"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** État du consentement SMS d'un client, tel que le fil l'affiche. */
export type SmsConsentState = {
  status: "valid" | "expired" | "none";
  kind: "express" | "implied_inquiry" | null;
  source: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
};
