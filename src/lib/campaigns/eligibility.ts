import type { CampaignConfig } from "./schema";

/**
 * Peut-on inscrire cette personne, et peut-on lui envoyer ce barreau?
 *
 * Module PUR : il reçoit des faits déjà rassemblés et rend une décision. Rien
 * ici ne lit la base — ce qui permet d'écrire noir sur blanc, et de tester, la
 * seule chose qui compte vraiment dans une campagne SMS : **pourquoi on ne
 * devrait PAS écrire à quelqu'un.**
 *
 * Chaque refus porte un motif distinct. Regrouper « pas de consentement » et
 * « numéro supprimé » sous un « inéligible » unique rendrait impossible de
 * répondre à la question qu'on se posera forcément un jour : cette campagne
 * convertit-elle mal, ou n'a-t-elle jamais eu le droit de partir?
 */

export const ENROLL_REFUSALS = [
  "campaign_not_active",
  "outside_window",
  "no_phone",
  "no_consent",
  "suppressed",
  "do_not_call",
  "already_enrolled",
  "active_elsewhere",
  "daily_cap_reached",
  "total_cap_reached",
  "empty_ladder",
] as const;
export type EnrollRefusal = (typeof ENROLL_REFUSALS)[number];

export interface EnrollFacts {
  /** État de la campagne au moment de la décision. */
  status: string;
  now: Date;
  hasPhone: boolean;
  /** Consentement valide et non expiré pour le canal SMS. */
  hasValidConsent: boolean;
  suppressed: boolean;
  doNotCall: boolean;
  alreadyEnrolled: boolean;
  activeInOtherCampaign: boolean;
  enrolledTodayCount: number;
  enrolledTotalCount: number;
}

export type EnrollDecision =
  | { allowed: true }
  | { allowed: false; refusal: EnrollRefusal };

export function canEnroll(config: CampaignConfig, facts: EnrollFacts): EnrollDecision {
  const deny = (refusal: EnrollRefusal): EnrollDecision => ({ allowed: false, refusal });

  if (facts.status !== "active") return deny("campaign_not_active");

  if (config.startsAt !== null && facts.now < config.startsAt) return deny("outside_window");
  if (config.endsAt !== null && facts.now >= config.endsAt) return deny("outside_window");

  // Une échelle vide inscrirait des gens pour ne jamais leur écrire : la
  // campagne paraîtrait vivante et ne ferait rien.
  if (config.ladder.length === 0) return deny("empty_ladder");

  if (!facts.hasPhone) return deny("no_phone");

  // L'ordre suit la gravité : un numéro désabonné est un refus exprimé, il
  // passe AVANT toute considération de capacité ou de doublon.
  if (facts.suppressed) return deny("suppressed");
  if (config.requireConsent && !facts.hasValidConsent) return deny("no_consent");
  if (config.audience.excludeDoNotCall && facts.doNotCall) return deny("do_not_call");

  if (facts.alreadyEnrolled) return deny("already_enrolled");
  if (config.audience.excludeActiveInOtherCampaign && facts.activeInOtherCampaign) {
    return deny("active_elsewhere");
  }

  if (
    config.totalEnrollmentCap !== null &&
    facts.enrolledTotalCount >= config.totalEnrollmentCap
  ) {
    return deny("total_cap_reached");
  }
  if (facts.enrolledTodayCount >= config.dailyEnrollmentCap) return deny("daily_cap_reached");

  return { allowed: true };
}

// ── Envoi d'un barreau ───────────────────────────────────────────────────────

export const TOUCH_REFUSALS = [
  "campaign_not_active",
  "enrollment_ended",
  "suppressed",
  "consent_expired",
  "ai_paused",
  "ladder_exhausted",
  "already_sent",
  "replied",
] as const;
export type TouchRefusal = (typeof TOUCH_REFUSALS)[number];

export interface TouchFacts {
  campaignStatus: string;
  enrollmentStatus: string;
  suppressed: boolean;
  hasValidConsent: boolean;
  /** conversations.aiEnabled — un humain a repris la main. */
  aiEnabled: boolean;
  ladderLength: number;
  step: number;
  /** Ce barreau a déjà une trace d'envoi. */
  alreadySent: boolean;
  /** Le client a répondu depuis le dernier barreau. */
  repliedSince: boolean;
}

export type TouchDecision = { allowed: true } | { allowed: false; refusal: TouchRefusal };

/**
 * Les conditions sont RE-VÉRIFIÉES à chaque barreau, jamais seulement à
 * l'inscription. Une échelle de trois semaines part avec un consentement valide
 * et peut très bien atteindre son dernier barreau après un désabonnement : la
 * décision d'inscrire ne vaut pas autorisation permanente d'écrire.
 */
export function canSendTouch(facts: TouchFacts): TouchDecision {
  const deny = (refusal: TouchRefusal): TouchDecision => ({ allowed: false, refusal });

  if (facts.suppressed) return deny("suppressed");
  if (!facts.hasValidConsent) return deny("consent_expired");
  if (facts.campaignStatus !== "active") return deny("campaign_not_active");

  if (facts.enrollmentStatus !== "pending" && facts.enrollmentStatus !== "active") {
    return deny("enrollment_ended");
  }
  // Une réponse rend la main à l'assistant : continuer l'échelle par-dessus une
  // conversation en cours ferait parler deux voix à la même personne.
  if (facts.repliedSince) return deny("replied");
  if (!facts.aiEnabled) return deny("ai_paused");
  if (facts.step >= facts.ladderLength) return deny("ladder_exhausted");
  if (facts.alreadySent) return deny("already_sent");

  return { allowed: true };
}
